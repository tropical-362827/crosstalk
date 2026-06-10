"""litellm の薄いラッパー。config.yaml の model を差し替えるだけでプロバイダを切り替えられる。"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path

import litellm
import yaml
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT_DIR / "config.yaml"
LOG_DIR = ROOT_DIR / "logs"  # 生のプロンプト/応答のデバッグログ(JSONL・日別)


def _log_call(
    purpose: str,
    model: str,
    messages: list[dict],
    response: str,
    started: float,
    usage: dict | None = None,
    error: str | None = None,
) -> None:
    """LLM呼び出し1回分を logs/llm-YYYYMMDD.jsonl に追記する。失敗してもゲームは止めない。"""
    try:
        LOG_DIR.mkdir(exist_ok=True)
        entry: dict = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "purpose": purpose,
            "model": model,
            "duration_sec": round(time.time() - started, 2),
            "usage": usage,
            "messages": messages,
            "response": response,
        }
        if error:
            entry["error"] = error
        path = LOG_DIR / f"llm-{datetime.now():%Y%m%d}.jsonl"
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def read_log_tail(limit: int = 20) -> list[dict]:
    """直近のLLM呼び出しログを新しい順で返す(直近2ファイル=最大2日分から)。"""
    if not LOG_DIR.exists():
        return []
    lines: list[str] = []
    for path in sorted(LOG_DIR.glob("llm-*.jsonl"))[-2:]:
        with open(path, encoding="utf-8") as f:
            lines.extend(f.readlines())
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out[::-1]

litellm.suppress_debug_info = True
# モデルが対応していないパラメータ(例: gpt-5系のtemperature)は黙って落とす。
# config.yaml のモデル差し替えをエラーなしで通すための設定。
litellm.drop_params = True
load_dotenv(ROOT_DIR / ".env")


def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f)


def _completion(**kwargs):
    """litellm.completion の薄いラッパー。
    litellm の台帳が古くて drop_params が効かないモデル(例: claude-opus-4-8 は
    API側で temperature を拒否する)のため、temperature を理由に弾かれたら
    temperature 抜きで1回だけ自動リトライする。"""
    try:
        return litellm.completion(**kwargs)
    except Exception as e:
        if "temperature" in kwargs and "temperature" in str(e).lower():
            kwargs.pop("temperature")
            return litellm.completion(**kwargs)
        raise


def chat(
    messages: list[dict],
    temperature: float | None = None,
    on_progress=None,
    purpose: str = "chat",
) -> str:
    """on_progress を渡すとストリーミングで受信し、累計文字数をコールバックする。
    purpose はデバッグログの用途ラベル。"""
    cfg = load_config()
    model = cfg["model"]
    started = time.time()
    try:
        if on_progress is not None:
            stream = _completion(
                model=model,
                messages=messages,
                temperature=cfg.get("temperature", 0.9)
                if temperature is None
                else temperature,
                max_tokens=cfg.get("max_tokens", 8000),
                stream=True,
            )
            parts: list[str] = []
            total = 0
            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content or ""
                if delta:
                    parts.append(delta)
                    total += len(delta)
                    on_progress(total)
            text = "".join(parts)
            _log_call(purpose, model, messages, text, started)
            return text
        resp = _completion(
            model=model,
            messages=messages,
            temperature=cfg.get("temperature", 0.9)
            if temperature is None
            else temperature,
            max_tokens=cfg.get("max_tokens", 8000),
        )
        text = resp.choices[0].message.content or ""
        usage = getattr(resp, "usage", None)
        u = (
            {
                "prompt_tokens": getattr(usage, "prompt_tokens", None),
                "completion_tokens": getattr(usage, "completion_tokens", None),
            }
            if usage
            else None
        )
        _log_call(purpose, model, messages, text, started, usage=u)
        return text
    except Exception as e:
        _log_call(purpose, model, messages, "", started, error=str(e))
        raise


def extract_json(text: str) -> dict:
    text = re.sub(r"```(?:json)?", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"JSONが見つかりません: {text[:200]}")
    return json.loads(text[start : end + 1])


def chat_json(
    messages: list[dict],
    temperature: float | None = None,
    on_progress=None,
    purpose: str = "chat_json",
) -> dict:
    """JSON応答を期待して呼び出す。パース失敗時は1回だけ修正を依頼してリトライ。"""
    raw = chat(messages, temperature=temperature, on_progress=on_progress, purpose=purpose)
    try:
        return extract_json(raw)
    except (ValueError, json.JSONDecodeError):
        retry = messages + [
            {"role": "assistant", "content": raw},
            {
                "role": "user",
                "content": "出力がJSONとして解析できませんでした。説明文やコードフェンスを付けず、有効なJSONオブジェクトのみを出力し直してください。",
            },
        ]
        return extract_json(chat(retry, temperature=0.2, purpose=f"{purpose}(JSON修正リトライ)"))
