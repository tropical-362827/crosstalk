// シナリオパックの読み込み(server/scenario.py の移植)。
// リポジトリ直下の scenarios/*/ をビルド時に取り込む(単一ソース)。

import yaml from "js-yaml";

const DEFAULTS = {
  name: "crosstalk",
  brand: "",
  page_title: "crosstalk",
  world_prompt:
    "あなたは群像劇シミュレーションゲームのゲームマスターです。" +
    "登場人物たちの設定・関係性・口調を忠実に守り、毎日少しずつ関係が動く" +
    "生き生きとした物語を描いてください。" +
    "一日ですべてを進展させず、続きが気になる「引き」で終わること。",
  style_rules: [],
  synopsis: "", // プレイヤー向けの「どういう話か」紹介(あらすじタブで表示)
  finale_prompt:
    "設定: 出演者全員が同じ机の上で、上記の全記録——全メッセージ、全員の秘密、" +
    "すべての関係——を初めて見せられた「全暴露の場」です。",
  plan_placeholder: "今日の行動計画を書いてください。",
};

// import.meta.glob は Vite がビルド時に静的解析するため、直接呼び出しの形にする必要がある
// (node 実行時=スモークテストでは未定義なので try で空にフォールバック)
let scenarioFiles = {};
let initialFiles = {};
try {
  scenarioFiles = import.meta.glob("../scenarios/*/scenario.yaml", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  initialFiles = import.meta.glob("../scenarios/*/initial_state.yaml", {
    query: "?raw",
    import: "default",
    eager: true,
  });
} catch {
  // node 実行時(Viteを通さない場合)はシナリオなしで動く
}

const idFromPath = (p) => p.split("/").slice(-2, -1)[0];

const PACKS = {};
for (const [path, raw] of Object.entries(scenarioFiles)) {
  const id = idFromPath(path);
  PACKS[id] = { meta: { ...DEFAULTS, ...yaml.load(raw), id }, initialRaw: null };
}
for (const [path, raw] of Object.entries(initialFiles)) {
  const id = idFromPath(path);
  if (PACKS[id]) PACKS[id].initialRaw = raw;
}

export function available() {
  return Object.keys(PACKS)
    .sort()
    .filter((id) => PACKS[id].initialRaw)
    .map((id) => ({ id, name: PACKS[id].meta.name }));
}

export function load(id) {
  const pack = PACKS[id];
  return pack ? pack.meta : { ...DEFAULTS, id: id || "unknown" };
}

export function initialState(id) {
  const pack = PACKS[id];
  if (!pack || !pack.initialRaw) {
    throw new Error(`シナリオ「${id}」が見つかりません`);
  }
  const state = yaml.load(pack.initialRaw);
  state.scenario = id;
  // サーバ版で pydantic が補っていたデフォルトをここで補完
  state.posts = state.posts || [];
  state.history = state.history || [];
  state.pending_plans = state.pending_plans || {};
  state.events = state.events || [];
  state.next_event_id = state.next_event_id ?? 1;
  state.next_message_id = state.next_message_id ?? 1;
  state.next_post_id = state.next_post_id ?? 1;
  state.finale = state.finale ?? null;
  for (const r of state.relationships || []) {
    r.status = r.status || "";
    r.crush = r.crush || [];
    r.note = r.note || "";
    r.intimacy_count = r.intimacy_count || 0;
    r.log = r.log || []; // 直近の出来事ログ(最大5件)
  }
  for (const c of state.characters || []) {
    c.memory = c.memory || []; // 驚きのある重大事実の長期記憶(最大8件)
  }
  return state;
}

// world_prompt_by_model のglobパターン(例: "xai/*")にモデル名がマッチすれば差し替え
export function worldPromptFor(sc, model) {
  for (const [pattern, prompt] of Object.entries(sc.world_prompt_by_model || {})) {
    const re = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
    );
    if (re.test(model)) return prompt;
  }
  return sc.world_prompt;
}
