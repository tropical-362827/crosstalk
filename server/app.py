"""FastAPI アプリ。web/ を静的配信し、ステートレスなゲームAPIを提供する。

セーブデータの正本はブラウザ側(localStorage / IndexedDB)が持つ。
サーバは「stateを受け取り、LLMで処理し、結果を返す」だけで、何も保存しない。
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

from . import engine, scenario
from .models import GameState

app = FastAPI(title="crosstalk")


def parse_state(payload: dict) -> GameState:
    try:
        st = GameState.model_validate(payload)
    except ValidationError as e:
        raise HTTPException(
            400,
            f"セーブデータとして解釈できませんでした: {e.error_count()}件の形式エラー",
        )
    if not st.characters:
        raise HTTPException(400, "キャラクターが含まれていないデータです")
    return st


class StateReq(BaseModel):
    state: dict


class SuggestReq(StateReq):
    character_id: str


class AdvanceReq(StateReq):
    plan: str = ""
    god: str = ""  # 神の采配(この日必ず起こる絶対命令)


class RepliesReq(StateReq):
    thread_id: str
    text: str


# --- シナリオ情報・初期状態 ------------------------------------------
@app.get("/api/meta")
def get_meta(scenario_id: str = Query("", alias="scenario")):
    sc = scenario.load(scenario_id.strip() or None)
    return {
        "id": sc["id"],
        "name": sc["name"],
        "brand": sc["brand"],
        "page_title": sc["page_title"],
        "plan_placeholder": sc["plan_placeholder"],
        "available_scenarios": [
            {"id": sid, "name": scenario.load(sid).get("name", sid)}
            for sid in scenario.available()
        ],
    }


@app.get("/api/initial")
def get_initial(scenario_id: str = Query("", alias="scenario")):
    sid = scenario_id.strip()
    if sid and sid not in scenario.available():
        raise HTTPException(404, f"シナリオ「{sid}」が見つかりません")
    data = scenario.read_yaml(scenario.initial_state_path(sid or None))
    state = GameState.model_validate(data)
    state.scenario = sid or scenario.current_id()
    return state.model_dump()


# 旧バージョンのサーバ保存セーブ(save/state.json)からの一度きりの移行用
LEGACY_SAVE = Path(__file__).resolve().parent.parent / "save" / "state.json"


@app.get("/api/legacy_save")
def legacy_save():
    if not LEGACY_SAVE.exists():
        raise HTTPException(404, "旧形式のセーブはありません")
    try:
        with open(LEGACY_SAVE, encoding="utf-8") as f:
            st = GameState.model_validate(json.load(f))
    except Exception:
        raise HTTPException(404, "旧形式のセーブを読み込めませんでした")
    return {"state": st.model_dump()}


# --- 行動計画 ----------------------------------------------------------
@app.post("/api/plan/suggest")
def plan_suggest(req: SuggestReq):
    st = parse_state(req.state)
    if st.char(req.character_id) is None:
        raise HTTPException(404, "そのキャラクターは存在しません")
    try:
        plan = engine.suggest_plan(st, req.character_id)
    except Exception as e:  # litellm のエラーをそのままUIに渡す
        raise HTTPException(502, f"LLM呼び出しに失敗しました: {e}")
    return {"plan": plan}


# --- 一日を進めるジョブ(バックグラウンド実行+ポーリング) ----------
# job_id はクライアントが「適用済みか」を判定するための通し番号。
# 完了時は state / record に結果が入り、クライアントが受け取って保存する。
advance_job: dict = {
    "running": False,
    "stage": "待機中",
    "percent": 0,
    "error": None,
    "job_id": 0,
    "state": None,
    "record": None,
}
_job_lock = threading.Lock()


def _job_set(stage: str | None = None, percent: float | None = None) -> None:
    if stage is not None:
        advance_job["stage"] = stage
    if percent is not None:
        # 後退して見えないように単調増加させる
        advance_job["percent"] = max(advance_job["percent"], int(percent))


def _run_advance(st: GameState, plan: str, god: str) -> None:
    try:
        _job_set("NPC全員の行動計画を生成中…", 2)
        npc_plans = engine.generate_npc_plans(
            st,
            exclude={st.player_id},
            on_progress=lambda f: _job_set(percent=2 + f * 28),
            god=god,
        )
        plans = {st.player_id: plan, **npc_plans}
        _job_set("一日をシミュレート中(シーン・関係・メッセージ)…", 30)
        record = engine.simulate_day(
            st,
            plans,
            on_progress=lambda f: _job_set(percent=30 + f * 65),
            god=god,
        )
        advance_job["record"] = record.model_dump()
        advance_job["state"] = st.model_dump()
        _job_set("完了", 100)
    except Exception as e:
        advance_job["error"] = f"LLM呼び出しに失敗しました: {e}"
    finally:
        advance_job["running"] = False


@app.post("/api/advance")
def advance(req: AdvanceReq):
    st = parse_state(req.state)
    with _job_lock:
        if advance_job["running"] or finale_job["running"]:
            raise HTTPException(409, "別の処理がすでに実行中です")
        advance_job.update(
            {
                "running": True,
                "stage": "開始",
                "percent": 0,
                "error": None,
                "state": None,
                "record": None,
                "job_id": advance_job["job_id"] + 1,
            }
        )
    plan = req.plan.strip() or "特に決めず、流れに任せて過ごす。"
    threading.Thread(target=_run_advance, args=(st, plan, req.god), daemon=True).start()
    return {"started": True, "job_id": advance_job["job_id"]}


@app.get("/api/advance/status")
def advance_status():
    return advance_job


# --- 終幕(プレイ終了の総括)ジョブ --------------------------------
finale_job: dict = {
    "running": False,
    "stage": "待機中",
    "percent": 0,
    "error": None,
    "job_id": 0,
    "finale": None,
}


def _run_finale(st: GameState) -> None:
    try:
        finale_job["stage"] = "全記録を開示して総括を執筆中…"
        result = engine.generate_finale(
            st,
            on_progress=lambda f: finale_job.__setitem__(
                "percent", max(finale_job["percent"], int(5 + f * 92))
            ),
        )
        finale_job["finale"] = result
        finale_job["stage"] = "完了"
        finale_job["percent"] = 100
    except Exception as e:
        finale_job["error"] = f"LLM呼び出しに失敗しました: {e}"
    finally:
        finale_job["running"] = False


@app.post("/api/finale")
def finale(req: StateReq):
    st = parse_state(req.state)
    with _job_lock:
        if advance_job["running"] or finale_job["running"]:
            raise HTTPException(409, "別の処理が実行中です")
        finale_job.update(
            {
                "running": True,
                "stage": "開始",
                "percent": 0,
                "error": None,
                "finale": None,
                "job_id": finale_job["job_id"] + 1,
            }
        )
    threading.Thread(target=_run_finale, args=(st,), daemon=True).start()
    return {"started": True, "job_id": finale_job["job_id"]}


@app.get("/api/finale/status")
def finale_status():
    return finale_job


# --- デバッグ: 生のLLMプロンプト/応答ログ ----------------------------
@app.get("/api/debug/llm")
def debug_llm(limit: int = Query(20, ge=1, le=100)):
    from .llm import read_log_tail

    return {"calls": read_log_tail(limit)}


# --- チャット返信(同期。プレイヤーの発言はクライアント側で追加済み) ----
@app.post("/api/message/replies")
def message_replies(req: RepliesReq):
    st = parse_state(req.state)
    if st.thread_by_id(req.thread_id) is None:
        raise HTTPException(404, "そのスレッドは存在しません")
    try:
        replies = engine.npc_replies(st, req.thread_id, req.text)
    except Exception as e:
        raise HTTPException(502, f"返信の生成に失敗しました: {e}")
    return {"replies": replies}


WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class NoCacheStaticFiles(StaticFiles):
    """HTML/JS/CSSの組み合わせが古いキャッシュと混在するとUIが壊れるため、
    毎回サーバーに確認させる(ETag/304で転送量は増えない)。"""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", NoCacheStaticFiles(directory=WEB_DIR, html=True), name="web")
