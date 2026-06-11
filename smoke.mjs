// 純ロジック部分のスモークテスト(LLM・ブラウザAPI不要、node で実行)
import fs from "node:fs";
import assert from "node:assert";
import yaml from "js-yaml";
import {
  summarizeState,
  stateStable,
  stateVolatile,
  applySimulationResult,
  resolveCharId,
  activeEvents,
  fullDossier,
} from "./src/engine.js";
import { extractJson } from "./src/llm.js";
import { esc, safeColor, validateSave } from "./src/sanitize.js";

// scenario.initialState 相当(node では import.meta.glob が無いので直接読む)
const S = yaml.load(
  fs.readFileSync(new URL("./scenarios/loveall/initial_state.yaml", import.meta.url), "utf8")
);
S.scenario = "loveall";
S.posts = S.posts || [];
S.history = S.history || [];
S.events = S.events || [];
S.next_event_id = S.next_event_id ?? 1;
S.next_post_id = S.next_post_id ?? 1;
for (const r of S.relationships) {
  r.status = r.status || "";
  r.crush = r.crush || [];
  r.intimacy_count = r.intimacy_count || 0;
}

// --- summarizeState ---
const sum = summarizeState(S);
for (const needle of [
  "## 登場人物",
  "## 関係(間柄 / 片想い / 肉体関係回数)",
  "片想い(慎吾→玲奈)",
  "[交際]",
  "肉体関係38回",
  "鍵垢SNSの投稿",
]) {
  assert(sum.includes(needle), `summarizeState に「${needle}」がない`);
}
console.log("summarizeState OK(", sum.length, "文字 )");

// --- キャッシュ用の stable / volatile 分割(接頭辞を汚さないこと) ---
const stable = stateStable(S);
const volatile = stateVolatile(S);
// stable は「日々変わる内容」を含んではいけない(接頭辞がキャッシュヒットしなくなる)
for (const dirty of ["## 現在:", "鍵垢SNSの投稿", "重要な記憶", "直近のメッセージ"]) {
  assert(!stable.includes(dirty), `stateStable に揮発内容「${dirty}」が混入している`);
}
// 設定(人物・関係)は stable 側、現在日は volatile 側
assert(stable.includes("## 登場人物"), "stateStable に登場人物がない");
assert(volatile.includes("## 現在:"), "stateVolatile に現在日がない");
// summarizeState は stable→volatile の順で連結されている(接頭辞一致のため)
assert(sum.indexOf(stable) === 0, "summarizeState が stable で始まっていない");
console.log("stateStable / stateVolatile 分割 OK");

// --- resolveCharId(名前・かな・混在表記) ---
assert.equal(resolveCharId(S, "ren"), "ren");
assert.equal(resolveCharId(S, "蓮"), "ren");
assert.equal(resolveCharId(S, "ひより"), "hiyori");
assert.equal(resolveCharId(S, "蓮(ren)"), "ren");
assert.equal(resolveCharId(S, "存在しない"), null);
console.log("resolveCharId OK");

// --- extractJson(フェンス除去) ---
assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
console.log("extractJson OK");

// --- applySimulationResult ---
S.events.push({ id: 1, text: "テスト予定", created_day: 0, due_day: 1, chars: ["ren"] });
S.next_event_id = 2;
const before = {
  day: S.day,
  msgs: S.messages.length,
  posts: S.posts.length,
  threads: S.threads.length,
  // テストのDM(hiyori-mio)が初期データに既存かどうかで期待スレッド数が変わる
  hadDm: S.threads.some((t) => t.id === "dm:hiyori-mio"),
};
const data = {
  scenes: [
    {
      time: "放課後",
      title: "テスト場面",
      participants: ["蓮", "sae"],
      main: "紗英",
      summary: "テスト",
      novel: "本文",
    },
  ],
  relationship_changes: [
    { a: "naoto", b: "玲奈", reason: "決裂", status: "敵意", slept: false },
    { a: "ren", b: "mio", reason: "また木曜", slept: true, crush_add: ["mio"] },
    { a: "sae", b: "shun", reason: "整理", status: "解消", crush_remove: [] },
  ],
  messages: [
    { thread: "group", sender: "hikaru", text: "てかさ", time: "夜" },
    { thread: "dm", members: ["hiyori", "mio"], sender: "hiyori", text: "あの、ええと…", time: "深夜" },
  ],
  posts: [{ author: "紗英", text: "もう確かめる", time: "深夜" }],
  new_events: [{ text: "週末に対決", due_day: 6, chars: ["sae", "ren"] }],
  memories: [{ character: "hikaru", fact: "蓮と美桜の決定的証拠を掴んだ" }],
  resolved_event_ids: [1],
  day_summary: "テストの一日",
};
const record = applySimulationResult(S, data, { ren: "テスト計画" }, "神テスト");

assert.equal(S.day, before.day + 1, "day が進んでいない");
assert.equal(record.scenes[0].main, "sae", "main の名前解決");
assert.deepEqual(record.scenes[0].participants, ["ren", "sae"]);
const naotoRena = S.relationships.find(
  (r) => [r.a, r.b].sort().join() === ["naoto", "rena"].sort().join()
);
assert.equal(naotoRena.status, "敵意");
const renMio = S.relationships.find(
  (r) => [r.a, r.b].sort().join() === ["mio", "ren"].sort().join()
);
assert.equal(renMio.intimacy_count, 10, "slept で +1 されていない");
assert(renMio.crush.includes("mio"), "crush_add が効いていない");
const saeShun = S.relationships.find(
  (r) => [r.a, r.b].sort().join() === ["sae", "shun"].sort().join()
);
assert.equal(saeShun.status, "", "解消 で status が空になっていない");
assert.equal(S.messages.length, before.msgs + 2);
// 既存DMなら増えない、新規なら +1(ensureDmの遅延生成)
assert.equal(
  S.threads.length,
  before.threads + (before.hadDm ? 0 : 1),
  "DMスレッドの自動作成数が想定と違う"
);
assert.equal(S.posts.length, before.posts + 1);
assert.equal(S.posts.at(-1).author, "sae", "post author の名前解決");
assert(!S.events.some((e) => e.id === 1), "resolved_event が消えていない");
assert(S.events.some((e) => e.text === "週末に対決" && e.due_day === 6));
assert.equal(record.god_note, "神テスト");
assert.equal(S.history.length, 1);
// 関係ログ(noteは上書きされず、出来事はlogに追記)
assert.equal(renMio.note !== "また木曜", true, "noteが上書きされてしまった");
assert(
  (renMio.log || []).some((e) => e.reason === "また木曜"),
  "関係logに出来事が追記されていない"
);
// 重要記憶(驚きの事実だけが該当キャラに残る)
const hikaru = S.characters.find((c) => c.id === "hikaru");
assert(
  (hikaru.memory || []).some((m) => m.fact.includes("決定的証拠")),
  "重要記憶が保存されていない"
);
console.log("applySimulationResult OK(関係log・重要記憶 含む)");

// --- new_events の重複排除(同じ当事者×同じ期日は上書き) ---
const beforeEvents = S.events.length;
const beforeNextId = S.next_event_id;
applySimulationResult(
  S,
  {
    scenes: [],
    relationship_changes: [],
    messages: [],
    posts: [],
    new_events: [{ text: "週末に対決(再確認・詳細版)", due_day: 6, chars: ["ren", "sae"] }],
    resolved_event_ids: [],
    day_summary: "重複テスト",
  },
  {}
);
assert.equal(S.events.length, beforeEvents, "重複イベントが追加された");
assert.equal(S.next_event_id, beforeNextId, "重複なのにidが消費された");
assert(
  S.events.some((e) => e.text === "週末に対決(再確認・詳細版)"),
  "重複イベントの本文が上書きされていない"
);
console.log("new_events重複排除 OK");

// --- fullDossier / activeEvents ---
assert(fullDossier(S).includes("鍵垢SNSの投稿"));
assert(activeEvents(S).length >= 1);
console.log("fullDossier / activeEvents OK");

// --- セキュリティ: 悪意ある入力のサニタイズ ---
const XSS = '#000"><img src=x onerror=alert(1)>';

// esc: タグ生成も属性突破も無効化する(< > " ' & を全てエンティティ化)
const escaped = esc(XSS);
assert(!/[<>]/.test(escaped), "esc: 生の <> が残っている(タグ注入可能)");
assert(!escaped.includes('"'), 'esc: 生の " が残っている(属性突破可能)');
assert(!escaped.includes("'"), "esc: 生の ' が残っている");
assert(escaped.includes("&lt;") && escaped.includes("&quot;"), "esc: エンティティ化されていない");
assert.equal(esc("a&b"), "a&amp;b", "esc: & が二重エスケープ等で壊れている");
assert.equal(esc("a'b"), "a&#39;b", "esc: ' が未エスケープ");
assert.equal(esc(undefined), "", "esc: undefined は空文字にすべき");
assert.equal(esc(null), "", "esc: null は空文字にすべき");
console.log("esc(evil) OK");

// safeColor: 正常な色は素通し、それ以外(突破文字列・CSS注入・名前色)は既定色へ
assert.equal(safeColor("#3f5a8f"), "#3f5a8f", "safeColor: 正常な6桁hexを変えるな");
assert.equal(safeColor("#abc"), "#abc", "safeColor: 3桁hexを許可");
assert.equal(safeColor(XSS), "#888", "safeColor: 属性突破色を弾いていない");
assert.equal(safeColor("red"), "#888", "safeColor: 名前付き色を弾いていない");
assert.equal(safeColor("rgb(0,0,0)"), "#888", "safeColor: rgb() を弾いていない");
assert.equal(safeColor("#000;background:url(//evil)"), "#888", "safeColor: CSS注入を弾いていない");
assert.equal(safeColor(undefined), "#888", "safeColor: undefined を弾いていない");
console.log("safeColor(evil) OK");

// validateSave: 正常は null、細工・型崩し・破損は理由つきで拒否(truthy)
assert.equal(
  validateSave({ day: 3, characters: [{ id: "a", name: "A" }], scenario: "x", messages: [] }),
  null,
  "validateSave: 正常なセーブを弾くな"
);
for (const [bad, why] of [
  [null, "null"],
  [[], "配列"],
  ["x", "文字列"],
  [{ characters: [{ id: "a", name: "A" }] }, "day欠落"],
  [{ day: "1", characters: [{ id: "a", name: "A" }] }, "day文字列"],
  [{ day: 1, characters: [] }, "空characters"],
  [{ day: 1, characters: [{ name: "A" }] }, "id欠落キャラ"],
  [{ day: 1, characters: [{ id: "a" }] }, "name欠落キャラ"],
  [{ day: 1, characters: [{ id: "a", name: "A" }], messages: "x" }, "messages非配列"],
  [{ day: 1, characters: [{ id: "a", name: "A" }], next_message_id: "1" }, "next_id文字列"],
]) {
  assert(validateSave(bad), `validateSave: 不正データ(${why})を通してしまった`);
}
console.log("validateSave(evil) OK");

console.log("\n全スモークテスト通過 ✅");
