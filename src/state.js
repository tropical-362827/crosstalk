// ゲーム状態のヘルパと永続化。
// セーブ本体は localStorage、巻き戻しスナップショットとLLMデバッグログは IndexedDB。

export const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
export const weekdayOf = (day) => WEEKDAYS[(day - 1) % 7];

// --- 状態操作(server/models.py のヘルパ群の移植) ---
export const charOf = (S, id) => S.characters.find((c) => c.id === id);

export function relOf(S, a, b) {
  return S.relationships.find(
    (r) => (r.a === a && r.b === b) || (r.a === b && r.b === a)
  );
}

export function ensureRel(S, a, b) {
  let r = relOf(S, a, b);
  if (!r) {
    r = { a, b, status: "", crush: [], note: "", intimacy_count: 0 };
    S.relationships.push(r);
  }
  if (!Array.isArray(r.crush)) r.crush = [];
  return r;
}

export const threadById = (S, id) => S.threads.find((t) => t.id === id);

export function ensureDm(S, a, b) {
  const key = "dm:" + [a, b].sort().join("-");
  let t = threadById(S, key);
  if (!t) {
    const ca = charOf(S, a);
    const cb = charOf(S, b);
    t = {
      id: key,
      name: `${ca ? ca.name : a} / ${cb ? cb.name : b}`,
      kind: "dm",
      members: [a, b].sort(),
    };
    S.threads.push(t);
  }
  return t;
}

export function addMessage(S, threadId, sender, text, time = "夜") {
  const msg = {
    id: S.next_message_id++,
    thread_id: threadId,
    sender,
    text,
    day: S.day,
    time,
  };
  S.messages.push(msg);
  return msg;
}

export function addPost(S, author, text, time = "夜") {
  S.posts = S.posts || [];
  if (S.next_post_id == null) {
    S.next_post_id = S.posts.reduce((mx, p) => Math.max(mx, p.id), 0) + 1;
  }
  const post = { id: S.next_post_id++, author, text, day: S.day, time };
  S.posts.push(post);
  return post;
}

// --- セーブ本体(localStorage) ---
const SAVE_KEY = "crosstalk_save";

export function persistState(S) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(S));
}

export function loadLocalState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && Array.isArray(data.characters) && data.characters.length
      ? data
      : null;
  } catch {
    return null;
  }
}

// --- IndexedDB(スナップショット・LLMログ) ---
let _idb = null;

function idb() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("crosstalk", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots", { keyPath: "day" });
      }
      if (!db.objectStoreNames.contains("llmlog")) {
        db.createObjectStore("llmlog", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => {
      _idb = req.result;
      resolve(_idb);
    };
    req.onerror = () => reject(req.error);
  });
}

function idbOp(store, mode, fn) {
  return idb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const out = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(out ? out.result : undefined);
        tx.onerror = () => reject(tx.error);
      })
  );
}

// IndexedDB(snapshots・llmlog)をまるごと削除する。キャッシュ接続を閉じてから消す
// (開いたままだと deleteDatabase がブロックされるため)。失敗しても reject せず解決する。
export function deleteIndexedDb() {
  return new Promise((resolve) => {
    try {
      if (_idb) {
        _idb.close();
        _idb = null;
      }
      const req = indexedDB.deleteDatabase("crosstalk");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve(); // 残った接続もリロードで閉じる
    } catch {
      resolve();
    }
  });
}

export const saveSnapshotLocal = (S) =>
  idbOp("snapshots", "readwrite", (s) =>
    s.put({ day: S.day, json: JSON.stringify(S) })
  );
export const snapshotDaysLocal = () =>
  idbOp("snapshots", "readonly", (s) => s.getAllKeys()).then((d) => d || []);
export const loadSnapshotLocal = (day) =>
  idbOp("snapshots", "readonly", (s) => s.get(day)).then((r) =>
    r ? JSON.parse(r.json) : null
  );
export const deleteSnapshotsAfterLocal = (day) =>
  snapshotDaysLocal().then((days) =>
    idbOp("snapshots", "readwrite", (s) => {
      for (const d of days) if (d > day) s.delete(d);
    })
  );
export const clearSnapshotsLocal = () =>
  idbOp("snapshots", "readwrite", (s) => s.clear());

// --- LLMデバッグログ(直近50件をリングバッファ的に保持) ---
const LLM_LOG_MAX = 50;

export async function logLlmCall(entry) {
  try {
    await idbOp("llmlog", "readwrite", (s) =>
      s.add({ ts: new Date().toISOString().slice(0, 19), ...entry })
    );
    const keys = (await idbOp("llmlog", "readonly", (s) => s.getAllKeys())) || [];
    if (keys.length > LLM_LOG_MAX) {
      const drop = keys.slice(0, keys.length - LLM_LOG_MAX);
      await idbOp("llmlog", "readwrite", (s) => {
        for (const k of drop) s.delete(k);
      });
    }
  } catch {
    // ログ失敗でゲームを止めない
  }
}

export async function readLlmLog(limit = 20) {
  const all = (await idbOp("llmlog", "readonly", (s) => s.getAll())) || [];
  return all.slice(-limit).reverse();
}
