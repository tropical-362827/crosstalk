// 描画・取り込み時のサニタイズ群。すべて純関数(DOM非依存)なので node でテストできる。

// 本文・属性値の両方で安全になるよう " と ' もエスケープする
// (textContent方式だと " ' を素通しし、二重引用符の属性内で突破される)
export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 色は色だけを許す(ホワイトリスト)。属性へ生挿入されるため、
// 不正値はデフォルト色に落として style 属性の突破・CSS注入を防ぐ。
export function safeColor(c) {
  return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : "#888";
}

// インポートされたセーブの構造・型を検証(壊れた/細工されたファイルを弾く)。
// 描画側の esc()/safeColor() が一次防御だが、取り込み時にも型を固める。
// 問題なければ null、ダメなら理由の文字列を返す。
export function validateSave(p) {
  const isArr = Array.isArray;
  const isStr = (x) => typeof x === "string";
  if (!p || typeof p !== "object" || isArr(p)) return "オブジェクトではありません";
  if (typeof p.day !== "number" || !Number.isFinite(p.day)) return "day が不正です";
  if (!isArr(p.characters) || !p.characters.length) return "characters がありません";
  for (const c of p.characters) {
    if (!c || typeof c !== "object" || isArr(c)) return "characters の要素が不正です";
    if (!isStr(c.id) || !c.id) return "キャラに id がありません";
    if (!isStr(c.name) || !c.name) return `キャラ ${c.id} の name が不正です`;
  }
  for (const k of ["relationships", "messages", "posts", "threads", "events", "history"]) {
    if (p[k] != null && !isArr(p[k])) return `${k} は配列である必要があります`;
  }
  for (const k of ["next_event_id", "next_message_id", "next_post_id"]) {
    if (p[k] != null && typeof p[k] !== "number") return `${k} は数値である必要があります`;
  }
  if (p.scenario != null && !isStr(p.scenario)) return "scenario が不正です";
  return null;
}
