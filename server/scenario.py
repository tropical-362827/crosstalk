"""シナリオパックの読み込み。scenarios/<id>/ に世界観と初期キャストをYAMLで置く。"""

from __future__ import annotations

import fnmatch
from pathlib import Path

import yaml

from .llm import load_config

ROOT = Path(__file__).resolve().parent.parent
SCENARIOS_DIR = ROOT / "scenarios"

# scenario.yaml に項目がない場合の汎用デフォルト
DEFAULTS: dict = {
    "name": "crosstalk",
    "brand": "",
    "page_title": "crosstalk",
    "world_prompt": (
        "あなたは群像劇シミュレーションゲームのゲームマスターです。"
        "登場人物たちの設定・関係性・口調を忠実に守り、毎日少しずつ関係が動く"
        "生き生きとした物語を描いてください。"
        "一日ですべてを進展させず、続きが気になる「引き」で終わること。"
    ),
    "style_rules": [],
    "finale_prompt": (
        "設定: 出演者全員が同じ机の上で、上記の全記録——全メッセージ、全員の秘密、"
        "すべての関係——を初めて見せられた「全暴露の場」です。"
    ),
    "plan_placeholder": "今日の行動計画を書いてください。",
}

_cache: dict[str, dict] = {}


def read_yaml(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def current_id() -> str:
    return load_config().get("scenario", "loveall")


def load(scenario_id: str | None = None) -> dict:
    sid = scenario_id or current_id()
    if sid in _cache:
        return _cache[sid]
    data = dict(DEFAULTS)
    path = SCENARIOS_DIR / sid / "scenario.yaml"
    if path.exists():
        data.update(read_yaml(path))
    data["id"] = sid
    _cache[sid] = data
    return data


def for_state(state) -> dict:
    """セーブデータが属するシナリオの定義を返す(保存時のシナリオを優先)。"""
    return load(getattr(state, "scenario", None) or None)


def world_prompt_for(sc: dict, model: str) -> str:
    """world_prompt_by_model のglobパターン(例: 'xai/*')にモデル名が
    マッチすればそのプロンプトを、なければ通常の world_prompt を返す。"""
    for pattern, prompt in (sc.get("world_prompt_by_model") or {}).items():
        if fnmatch.fnmatch(model, pattern):
            return prompt
    return sc["world_prompt"]


def initial_state_path(scenario_id: str | None = None) -> Path:
    return SCENARIOS_DIR / (scenario_id or current_id()) / "initial_state.yaml"


def available() -> list[str]:
    if not SCENARIOS_DIR.exists():
        return []
    return sorted(p.parent.name for p in SCENARIOS_DIR.glob("*/scenario.yaml"))
