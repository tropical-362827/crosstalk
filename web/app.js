// crosstalk frontend
let S = null;            // GameState
let META = null;         // /api/meta の結果(シナリオ情報)
let currentThread = null;
let rewindDays = new Set(); // 巻き戻し可能な日(スナップショットがある日)
let dividerAt = null;    // 開いているスレッドの未読境界(開いた時点のメッセージid)

// スレッドごとの既読位置 {thread_id: 既読済み最大メッセージid}
let seenByThread = {};
try {
  seenByThread = JSON.parse(localStorage.getItem("seenByThread") || "{}");
} catch {}

function saveSeen() {
  localStorage.setItem("seenByThread", JSON.stringify(seenByThread));
}

// 鍵垢SNSの既読位置 {キャラid: 既読済み最大投稿id}。プロフィールを開いた人だけ既読になる
let seenPostsByAuthor = {};
try {
  seenPostsByAuthor = JSON.parse(localStorage.getItem("seenPostsByAuthor") || "{}");
} catch {}

function saveSeenPosts() {
  localStorage.setItem("seenPostsByAuthor", JSON.stringify(seenPostsByAuthor));
}

// ---------------------------------------------------------------- save (browser)
// セーブの正本はブラウザ側が持つ。本体は localStorage、巻き戻しスナップショットは IndexedDB。
// サーバはステートレスで、LLM処理のたびに state を送って結果を受け取る。
const SAVE_KEY = "crosstalk_save";

function persistState() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(S));
  } catch (e) {
    toast("セーブの保存に失敗しました(容量不足の可能性): " + e.message, 8000);
  }
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && Array.isArray(data.characters) && data.characters.length ? data : null;
  } catch {
    return null;
  }
}

// 適用済みジョブid(リロードを跨いで同じ結果を二重適用しないため)
let appliedJobs = {};
try {
  appliedJobs = JSON.parse(localStorage.getItem("appliedJobs") || "{}");
} catch {}

function markJobApplied(kind, id) {
  appliedJobs[kind] = id;
  localStorage.setItem("appliedJobs", JSON.stringify(appliedJobs));
}

// 新しいゲーム・読み込み・巻き戻しの後に、サーバに残った古いジョブ結果を
// 「適用済み」扱いにして、リロード時に誤って古い結果を上書き適用しないようにする
async function claimServerJobs() {
  try {
    markJobApplied("advance", (await api("/api/advance/status")).job_id);
  } catch {}
  try {
    markJobApplied("finale", (await api("/api/finale/status")).job_id);
  } catch {}
}

// --- IndexedDB(日次スナップショット。localStorageでは5MB制限に当たるため) ---
let _idb = null;
function idb() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("crosstalk", 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore("snapshots", { keyPath: "day" });
    req.onsuccess = () => {
      _idb = req.result;
      resolve(_idb);
    };
    req.onerror = () => reject(req.error);
  });
}

function idbOp(mode, fn) {
  return idb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("snapshots", mode);
        const out = fn(tx.objectStore("snapshots"));
        tx.oncomplete = () => resolve(out ? out.result : undefined);
        tx.onerror = () => reject(tx.error);
      })
  );
}

const saveSnapshotLocal = (state) =>
  idbOp("readwrite", (s) => s.put({ day: state.day, json: JSON.stringify(state) }));
const snapshotDaysLocal = () =>
  idbOp("readonly", (s) => s.getAllKeys()).then((days) => days || []);
const loadSnapshotLocal = (day) =>
  idbOp("readonly", (s) => s.get(day)).then((r) => (r ? JSON.parse(r.json) : null));
const deleteSnapshotsAfterLocal = (day) =>
  snapshotDaysLocal().then((days) =>
    idbOp("readwrite", (s) => {
      for (const d of days) if (d > day) s.delete(d);
    })
  );
const clearSnapshotsLocal = () => idbOp("readwrite", (s) => s.clear());

// --- クライアント側の状態操作(旧サーバ処理の置き換え) ---
function addMessageLocal(threadId, sender, text, time = "今") {
  S.messages.push({
    id: S.next_message_id++,
    thread_id: threadId,
    sender,
    text,
    day: S.day,
    time,
  });
}

function addPostLocal(author, text, time = "今") {
  S.posts = S.posts || [];
  if (S.next_post_id == null) {
    S.next_post_id = S.posts.reduce((mx, p) => Math.max(mx, p.id), 0) + 1;
  }
  S.posts.push({ id: S.next_post_id++, author, text, day: S.day, time });
}

// 一日を進めている間は、結果と衝突するstate変更(チャット・投稿・乗り移り等)を止める
let advanceRunning = false;
let chatPending = false;

function clampSeen() {
  // 巻き戻しでidが小さく戻ったとき、既読位置が未来を指したままにならないようにする
  const maxId = S.messages.reduce((mx, m) => Math.max(mx, m.id), 0);
  let changed = false;
  for (const k of Object.keys(seenByThread)) {
    if (seenByThread[k] > maxId) {
      seenByThread[k] = maxId;
      changed = true;
    }
  }
  if (changed) saveSeen();
  // 旧形式(全プロフィール共有の既読id)からの一度きりの移行
  const legacySeen = Number(localStorage.getItem("seenPostId") || 0);
  if (legacySeen) {
    for (const c of S.characters) {
      seenPostsByAuthor[c.id] = Math.max(seenPostsByAuthor[c.id] || 0, legacySeen);
    }
    localStorage.removeItem("seenPostId");
    saveSeenPosts();
  }
  const maxPostId = (S.posts || []).reduce((mx, p) => Math.max(mx, p.id), 0);
  let postChanged = false;
  for (const k of Object.keys(seenPostsByAuthor)) {
    if (seenPostsByAuthor[k] > maxPostId) {
      seenPostsByAuthor[k] = maxPostId;
      postChanged = true;
    }
  }
  if (postChanged) saveSeenPosts();
}

function unreadCount(t) {
  const seen = seenByThread[t.id] || 0;
  return S.messages.filter((m) => m.thread_id === t.id && m.id > seen).length;
}

function markThreadSeen(threadId) {
  const ids = S.messages.filter((m) => m.thread_id === threadId).map((m) => m.id);
  if (ids.length) {
    seenByThread[threadId] = Math.max(...ids);
    saveSeen();
  }
  renderBadge();
}

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- api
async function api(path, body) {
  const opt = body !== undefined
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, opt);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

function toast(msg, ms = 4000) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), ms);
}

// ---------------------------------------------------------------- helpers
const charOf = (id) => S.characters.find((c) => c.id === id);
const playerChar = () => charOf(S.player_id);
const initialOf = (c) => c.name[0];

function relsOf(id) {
  return S.relationships
    .filter((r) => r.a === id || r.b === id)
    .map((r) => ({ other: charOf(r.a === id ? r.b : r.a), rel: r }))
    .filter((x) => x.other)
    .sort((a, b) => (b.rel.intimacy_count || 0) - (a.rel.intimacy_count || 0));
}

const nameOf = (id) => (charOf(id) || { name: id }).name;

function clusterDms(dms) {
  // 「残りの中で一番多くのスレッドに登場する人」をハブに選び、
  // その人のスレッドを相手の名前順でまとめて出す → 同じ人が連続する
  const remaining = [...dms];
  const result = [];
  while (remaining.length) {
    const count = {};
    for (const t of remaining) for (const m of t.members) count[m] = (count[m] || 0) + 1;
    const hub = Object.keys(count).sort(
      (a, b) => count[b] - count[a] || nameOf(a).localeCompare(nameOf(b), "ja")
    )[0];
    const partner = (t) => nameOf(t.members.find((m) => m !== hub) ?? hub);
    const mine = remaining
      .filter((t) => t.members.includes(hub))
      .sort((x, y) => partner(x).localeCompare(partner(y), "ja"));
    for (const t of mine) {
      result.push(t);
      remaining.splice(remaining.indexOf(t), 1);
    }
  }
  return result;
}

function visibleThreads() {
  // 並び順: ①グループ(サークル全体)が最上段 ②未読が先 ③同じ人が固まるクラスタ順
  const groups = S.threads.filter((t) => t.kind === "group");
  const dms = S.threads.filter((t) => t.kind !== "group");
  const unreadDms = dms.filter((t) => unreadCount(t) > 0);
  const readDms = dms.filter((t) => unreadCount(t) === 0);
  return [...groups, ...clusterDms(unreadDms), ...clusterDms(readDms)];
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---------------------------------------------------------------- render
function renderAll() {
  clampSeen(); // 巻き戻し後の既読位置の整合
  const p = playerChar();
  $("#day-label").textContent = `${S.day}日目(${"月火水木金土日"[(S.day - 1) % 7]})`;
  $("#player-name").textContent = p ? p.name : "—";
  renderClass();
  renderPlanView();
  renderLog();
  renderThreads();
  renderChat();
  renderBadge();
  renderSns();
  renderFinale();
}

// --- sns (鍵垢) ---
function unreadPostCount(authorId) {
  const seen = seenPostsByAuthor[authorId] || 0;
  return (S.posts || []).filter((p) => p.author === authorId && p.id > seen).length;
}

function renderSnsBadge() {
  const unseen = S.characters.reduce((sum, c) => sum + unreadPostCount(c.id), 0);
  const badge = $("#sns-badge");
  badge.textContent = unseen;
  badge.classList.toggle("hidden", unseen === 0);
}

function markProfileSeen(authorId) {
  const ids = (S.posts || []).filter((p) => p.author === authorId).map((p) => p.id);
  if (ids.length) {
    seenPostsByAuthor[authorId] = Math.max(...ids);
    saveSeenPosts();
  }
  renderSnsBadge();
}

// プロフィールを開く: 開いた時点の未読境界を固定してから、その人の投稿だけ既読にする
function openProfile(authorId) {
  currentProfile = authorId;
  const seen = seenPostsByAuthor[authorId] || 0;
  const firstUnread = (S.posts || []).find(
    (p) => p.author === authorId && p.id > seen
  );
  snsDividerAt = firstUnread ? firstUnread.id : null;
  markProfileSeen(authorId);
  renderSns();
}

let currentProfile = null; // 表示中の鍵垢のキャラid
let snsDividerAt = null; // 表示中プロフィールの未読境界(開いた時点の最初の未読投稿id)

function renderSns() {
  if (!currentProfile || !charOf(currentProfile)) currentProfile = S.player_id;
  // 上段: プロフィール切り替え(アバター列・右下に未読数)
  const strip = $("#sns-profiles");
  strip.innerHTML = "";
  const ordered = [
    ...S.characters.filter((c) => c.id === S.player_id),
    ...S.characters.filter((c) => c.id !== S.player_id),
  ];
  for (const c of ordered) {
    const n = (S.posts || []).filter((p) => p.author === c.id).length;
    const unread = unreadPostCount(c.id);
    const btn = document.createElement("button");
    btn.className = "sns-profile-btn" + (c.id === currentProfile ? " active" : "");
    btn.title = `${c.name}の鍵垢(${n}投稿${unread ? `・未読${unread}` : ""})`;
    btn.innerHTML = `
      <span class="sns-avatar-wrap">
        <span class="msg-avatar" style="background:${c.color}">${esc(initialOf(c))}</span>
        ${unread ? `<span class="sns-unread">${unread}</span>` : ""}
      </span>
      <span class="sns-profile-name">${esc(givenName(c))}</span>`;
    btn.onclick = () => openProfile(c.id);
    strip.appendChild(btn);
  }
  // プロフィールヘッダ
  const c = charOf(currentProfile);
  const isMe = currentProfile === S.player_id;
  const posts = (S.posts || []).filter((p) => p.author === currentProfile);
  $("#sns-profile-head").innerHTML = `
    <div class="sns-head-cover"></div>
    <div class="sns-head-body">
      <div class="sns-head-avatar" style="background:${c.color}">${esc(initialOf(c))}</div>
      <div class="sns-head-main">
        <div class="sns-head-name">${esc(c.name)} <span class="sns-lock" title="鍵アカウント">🔒</span>${isMe ? '<span class="you-tag">YOU</span>' : ""}</div>
        <div class="sns-head-handle">@${esc(c.id)}</div>
        <div class="sns-head-bio">${esc(c.club)}${c.hobbies && c.hobbies.length ? " / " + esc(c.hobbies.join("、")) : ""}</div>
        <div class="sns-head-meta">${posts.length} 投稿 ・ フォロー 0 ・ フォロワー 0</div>
      </div>
    </div>
    ${isMe ? "" : '<div class="sns-peek">👁 鍵垢を神の視点で覗き見しています。本人は誰にも見られていないつもりです</div>'}`;
  // 投稿欄は自分のプロフィールのときだけ
  $("#sns-composer").classList.toggle("hidden", !isMe);
  if (isMe) {
    const av = $("#sns-composer-avatar");
    av.style.background = c.color;
    av.textContent = initialOf(c);
  }
  // 投稿一覧(新しい順)。snsDividerAt以降が未読 → 最古の未読投稿の下に境界線を引く
  const box = $("#sns-timeline");
  let html = "";
  let lastDay = null;
  for (const post of [...posts].reverse()) {
    if (post.day !== lastDay) {
      lastDay = post.day;
      html += `<div class="day-divider"><span>${post.day === 0 ? "プロローグ" : post.day + "日目"}</span></div>`;
    }
    html += `
      <div class="post-row${post.author === S.player_id ? " mine" : ""}">
        <div class="msg-avatar" style="background:${c.color}">${esc(initialOf(c))}</div>
        <div class="post-body">
          <div class="post-head">
            <span class="post-name">${esc(c.name)}</span>
            <span class="post-handle">@${esc(c.id)}</span>
            <span class="post-time">${esc(post.time)}</span>
          </div>
          <div class="post-text">${esc(post.text)}</div>
        </div>
      </div>`;
    if (snsDividerAt !== null && post.id === snsDividerAt) {
      html += '<div class="unread-divider"><span>ここから上が未読</span></div>';
    }
  }
  box.innerHTML =
    html ||
    `<div class="day-divider"><span>${isMe ? "まだ投稿がありません。最初の独り言をどうぞ" : "まだ投稿がありません"}</span></div>`;
  renderSnsBadge();
}

// --- finale ---
function renderFinale() {
  const box = $("#finale-content");
  const f = S.finale;
  $("#finale-btn").textContent = f ? "総括を作り直す(上書き)" : "総括を生成する";
  if (!f) {
    box.innerHTML = "";
    return;
  }
  const highlights = (f.highlights || [])
    .map((h) => `<div class="rel-change"><b>${h.day != null ? h.day + "日目" : ""}</b> ${esc(h.text)}</div>`)
    .join("");
  const awards = (f.awards || [])
    .map((a) => {
      const c = charOf(a.character);
      return `<div class="award-row">🏆 <b>${esc(a.name)}</b> — ${c ? `<span class="event-char" style="background:${c.color}">${esc(c.name)}</span>` : ""} ${esc(a.reason)}</div>`;
    })
    .join("");
  const comments = (f.comments || [])
    .map((cm) => {
      const c = charOf(cm.character);
      if (!c) return "";
      return `
      <div class="finale-comment">
        <div class="msg-avatar" style="background:${c.color}">${esc(initialOf(c))}</div>
        <div>
          <div class="msg-sender">${esc(c.name)}</div>
          <div class="msg-bubble">${esc(cm.text)}</div>
        </div>
      </div>`;
    })
    .join("");
  box.innerHTML = `
    <div class="day-block finale-block">
      <div class="finale-title">${esc(f.title)}</div>
      ${f.tagline ? `<div class="finale-tagline">${esc(f.tagline)}</div>` : ""}
      <div class="narrative" style="border:none;padding:14px 0 0">${esc(f.overall)}</div>
      ${highlights ? `<h3 class="finale-h">名場面</h3>${highlights}` : ""}
      ${awards ? `<h3 class="finale-h">アワード</h3>${awards}` : ""}
      ${comments ? `<h3 class="finale-h">全暴露後・本人コメント</h3>${comments}` : ""}
      <div class="day-summary">${f.generated_on_day}日目時点の総括</div>
    </div>`;
}

function pollFinale() {
  $("#finale-btn").disabled = true;
  $("#finale-status").classList.remove("hidden");
  const timer = setInterval(async () => {
    let j;
    try {
      j = await api("/api/finale/status");
    } catch {
      return;
    }
    $("#finale-stage").textContent = j.stage;
    $("#finale-percent").textContent = j.percent + "%";
    $("#finale-bar").style.width = j.percent + "%";
    if (j.running) return;
    clearInterval(timer);
    if (j.error) toast("エラー: " + j.error, 8000);
    else if (j.finale && appliedJobs.finale !== j.job_id) {
      S.finale = j.finale;
      markJobApplied("finale", j.job_id);
      persistState();
      renderFinale();
      toast("シーズン総括ができました");
    }
    $("#finale-btn").disabled = false;
    setTimeout(() => $("#finale-status").classList.add("hidden"), 600);
  }, 800);
}

$("#finale-btn").onclick = async () => {
  const msg = S.finale
    ? "総括を作り直します(現在の総括は上書きされます)。1〜2分かかります。よろしいですか?"
    : "全記録を開示してシーズン総括を生成します。1〜2分かかります。よろしいですか?";
  if (!confirm(msg)) return;
  try {
    await api("/api/finale", { state: S });
  } catch (e) {
    toast("エラー: " + e.message, 6000);
    return;
  }
  pollFinale();
};

// --- class ---
// statusはLLMが固定の列挙から選ぶ値なので、推測(正規表現)はせず対応表で引くだけ
const STATUS_CAT = { 交際: "love", 元恋人: "ex", 敵意: "hate" };
const CAT_ICONS = { love: "❤️", body: "🔥", crush: "💘", ex: "💔", hate: "💢", other: "・" };

function givenName(c) {
  return c.name.split(/\s/)[1] || c.name;
}

function chipsForRel(me, other, rel) {
  const out = [];
  if (rel.status) {
    const cat = STATUS_CAT[rel.status] || "other";
    out.push(
      `<span class="chip ${cat}" title="${esc(rel.status)}(${esc(other.name)})">${CAT_ICONS[cat]} ${esc(givenName(other))}</span>`
    );
  }
  // 片想いはタグ文字列のパースではなくキャラidで向きを判定する
  for (const cid of rel.crush || []) {
    const mine = cid === me.id;
    const fromName = mine ? me.name : other.name;
    const toName = mine ? other.name : me.name;
    out.push(
      `<span class="chip crush" title="片想い(${esc(fromName)}→${esc(toName)})">${CAT_ICONS.crush}${mine ? "→" : "←"} ${esc(givenName(other))}</span>`
    );
  }
  if ((rel.intimacy_count || 0) > 0) {
    out.push(
      `<span class="chip body" title="肉体関係${rel.intimacy_count}回(${esc(other.name)})">${CAT_ICONS.body} ${esc(givenName(other))}</span>`
    );
  }
  return out;
}

function genderMark(c) {
  if (c.gender.includes("女")) return '<span class="gender f" title="女性">♀</span>';
  if (c.gender.includes("男")) return '<span class="gender m" title="男性">♂</span>';
  return "";
}

function renderClass() {
  const grid = $("#char-grid");
  grid.innerHTML = "";
  // 男→女の順、同性内は元の並び順
  const ordered = [...S.characters].sort(
    (a, b) => (a.gender.includes("女") ? 1 : 0) - (b.gender.includes("女") ? 1 : 0)
  );
  for (const c of ordered) {
    const chips = relsOf(c.id)
      .flatMap(({ other, rel }) => chipsForRel(c, other, rel))
      .join("");
    const card = document.createElement("div");
    card.className = "char-card" + (c.id === S.player_id ? " player" : "");
    card.innerHTML = `
      ${c.id === S.player_id ? '<span class="you-tag">YOU</span>' : ""}
      <div class="avatar" style="background:${c.color}">${esc(initialOf(c))}</div>
      <div class="name">${esc(c.name)} ${genderMark(c)}</div>
      ${c.kana ? `<div class="kana">${esc(c.kana)}</div>` : ""}
      <div class="club">${esc(c.club)}</div>
      ${chips ? `<div class="rel-chips">${chips}</div>` : ""}`;
    card.onclick = () => showDetail(c.id);
    grid.appendChild(card);
  }
}

function showDetail(id) {
  const c = charOf(id);
  const box = $("#char-detail");
  const isPlayer = id === S.player_id;
  const rels = relsOf(id)
    .map(({ other, rel }) => {
      const bits = [
        rel.status || "",
        ...(rel.crush || []).map((cid) =>
          cid === id ? `片想い(→${other.name})` : `片想い(←${other.name})`
        ),
      ].filter(Boolean);
      return `
      <div class="rel-card">
        <div class="rel-card-head">
          <span class="rel-name">${esc(other.name)}</span>
          ${rel.intimacy_count ? `<span class="rel-intimacy" title="肉体関係の累計回数">🔥×${rel.intimacy_count}</span>` : ""}
        </div>
        ${bits.length ? `<div class="rel-tags">${esc(bits.join(" / "))}</div>` : ""}
        ${rel.note ? `<div class="rel-note">${esc(rel.note)}</div>` : ""}
      </div>`;
    })
    .join("");
  box.innerHTML = `
    <div class="head">
      <div class="avatar" style="background:${c.color}">${esc(initialOf(c))}</div>
      <div>
        <h2>${esc(c.name)} ${isPlayer ? "(操作中)" : ""}</h2>
        <div class="meta">${[c.kana, c.gender, c.club].filter(Boolean).map(esc).join(" / ")}</div>
      </div>
      <div class="head-actions">
        ${isPlayer ? "" : `<button class="primary" id="possess-btn">このキャラに乗り移る</button>`}
        <button class="ghost" id="detail-close">閉じる</button>
      </div>
    </div>
    <div class="detail-cols">
      <div class="detail-main">
        <div class="section"><h3>性格</h3>${esc(c.personality)}</div>
        <div class="section"><h3>趣味</h3>${esc(c.hobbies.join("、"))}</div>
        <div class="section"><h3>秘密</h3>${esc(c.secret)}</div>
        <div class="section"><h3>目標</h3>${esc(c.goal)}</div>
      </div>
      <div class="detail-side">
        <div class="section"><h3>関係</h3><div class="rel-list">${rels || '<span class="meta">まだ目立った関係はない</span>'}</div></div>
      </div>
    </div>`;
  box.classList.remove("hidden");
  $("#char-grid").classList.add("hidden");
  $("#detail-close").onclick = () => {
    box.classList.add("hidden");
    $("#char-grid").classList.remove("hidden");
  };
  const pb = $("#possess-btn");
  if (pb)
    pb.onclick = () => {
      if (advanceRunning) {
        toast("一日を進めている間は乗り移れません", 5000);
        return;
      }
      S.player_id = id;
      persistState();
      toast(`${c.name} に乗り移りました`);
      box.classList.add("hidden");
      $("#char-grid").classList.remove("hidden");
      renderAll();
    };
}

// --- plan ---
function renderPlanView() {
  const p = playerChar();
  $("#plan-title").textContent = p
    ? `${p.name} の ${S.day}日目の行動計画`
    : "今日の行動計画";
  const UNDATED_TTL = 2; // server/engine.py の UNDATED_EVENT_TTL と揃える
  const box = $("#events-box");
  const events = (S.events || []).filter((e) =>
    e.due_day != null ? e.due_day >= S.day : S.day - e.created_day <= UNDATED_TTL
  );
  box.classList.remove("hidden");
  const rows = events
    .map((e) => {
      const left = e.created_day + UNDATED_TTL - S.day + 1;
      const due =
        e.due_day != null
          ? `<span class="event-due${e.due_day === S.day ? " today" : ""}">${e.due_day}日目${e.due_day === S.day ? "(今日)" : ""}</span>`
          : `<span class="event-due">あと${left}日で消滅</span>`;
      const who = (e.chars || [])
        .map(charOf)
        .filter(Boolean)
        .map((c) => `<span class="event-char" style="background:${c.color}">${esc(c.name)}</span>`)
        .join("");
      return `<div class="event-row">${due}${who}${esc(e.text)}</div>`;
    })
    .join("");
  box.innerHTML =
    `<h3>📌 予定・くすぶる火種(${events.length}件)</h3>` +
    (rows || '<div class="event-row empty">今は何も仕込まれていません。日を進めると約束や企みがここに溜まります。</div>');
}

function renderLastResult(record) {
  const box = $("#last-result");
  box.classList.remove("hidden");
  box.innerHTML = dayBlockHtml(record);
}

// --- log ---
function dayBlockHtml(rec) {
  const scenes = rec.scenes
    .map((s) => {
      const mainId = charOf(s.main) ? s.main : (s.participants || [])[0];
      const mc = charOf(mainId);
      const others = (s.participants || [])
        .filter((id) => id !== mainId)
        .map(charOf)
        .filter(Boolean);
      const badge =
        (mc
          ? `<span class="main-badge" style="background:${mc.color}" title="この場面の主役(視点人物)">${esc(mc.name)}</span>`
          : "") +
        others
          .map(
            (c) =>
              `<span class="sub-badge" style="border-color:${c.color};color:${c.color}" title="この場面の登場人物">${esc(c.name)}</span>`
          )
          .join("");
      return `
      <details class="scene">
        <summary>
          <div class="scene-head">
            ${s.time ? `<span class="time">${esc(s.time)}</span>` : ""}
            <span class="title">${esc(s.title)}</span>
            <span class="open-hint">▼ 読む</span>
          </div>
          ${s.summary ? `<div class="scene-summary">${badge}${esc(s.summary)}</div>` : badge ? `<div class="scene-summary">${badge}</div>` : ""}
        </summary>
        <div class="narrative">${esc(s.narrative)}</div>
      </details>`;
    })
    .join("");
  const rels = rec.relationship_changes
    .map((ch) => {
      const a = charOf(ch.a), b = charOf(ch.b);
      if (!a || !b) return "";
      const bits = [
        ...(ch.status ? [`→[${ch.status}]`] : []),
        ...(ch.crush_add || []).map((cid) => `+[片想い:${nameOf(cid)}]`),
        ...(ch.crush_remove || []).map((cid) => `-[片想い:${nameOf(cid)}]`),
        // 旧形式(タグ時代)の記録との互換表示
        ...(ch.tags_add || []).map((t) => `+[${t}]`),
        ...(ch.tags_remove || []).map((t) => `-[${t}]`),
      ].join(" ");
      const slept = ch.slept ? ' <span class="slept-mark" title="この日、一線を越えた">🔥</span>' : "";
      return `<div class="rel-change">${esc(a.name)} ⇔ ${esc(b.name)}${slept} ${esc(bits)} — ${esc(ch.reason)}</div>`;
    })
    .join("");
  const plans = Object.entries(rec.plans || {})
    .map(([cid, plan]) => {
      const c = charOf(cid);
      return c ? `<li><b>${esc(c.name)}</b>: ${esc(plan)}</li>` : "";
    })
    .join("");
  const rewind = rewindDays.has(rec.day)
    ? `<button class="ghost rewind-btn" data-day="${rec.day}">⏪ この日をやり直す</button>`
    : "";
  return `
    <div class="day-block">
      <h2>${rec.day}日目(${esc(rec.weekday)})${rewind}</h2>
      ${rec.god_note ? `<div class="god-note">✋ 神の采配: ${esc(rec.god_note)}</div>` : ""}
      ${scenes}
      ${rels ? `<div class="rel-changes">${rels}</div>` : ""}
      ${rec.summary ? `<div class="day-summary">${esc(rec.summary)}</div>` : ""}
      ${plans ? `<details class="plans-detail"><summary>この日の各自の行動計画</summary><ul>${plans}</ul></details>` : ""}
    </div>`;
}

function renderLog() {
  const box = $("#day-log");
  if (!S.history.length) {
    box.innerHTML = '<div class="day-block">まだ何も起きていません。「行動計画」タブから一日を進めてみましょう。</div>';
    return;
  }
  box.innerHTML = [...S.history].reverse().map(dayBlockHtml).join("");
}

// --- messenger ---
function renderThreads() {
  const list = $("#thread-list");
  list.innerHTML = "";
  for (const t of visibleThreads()) {
    const last = [...S.messages].reverse().find((m) => m.thread_id === t.id);
    const isMember = t.members.includes(S.player_id);
    const unread = unreadCount(t);
    const item = document.createElement("div");
    item.className = "thread-item" + (currentThread === t.id ? " active" : "");
    item.innerHTML = `
      <div class="t-name">${esc(t.name)} ${isMember ? "" : '<span class="peek">👁覗き見</span>'}${unread ? `<span class="unread-chip">${unread}</span>` : ""}</div>
      <div class="t-last">${last ? esc(`${(charOf(last.sender) || {}).name || ""}: ${last.text}`) : "(まだ会話なし)"}</div>`;
    item.onclick = () => {
      currentThread = t.id;
      // 開いた時点の未読境界を固定してから既読にする
      const seen = seenByThread[t.id] || 0;
      const firstUnread = S.messages.find((m) => m.thread_id === t.id && m.id > seen);
      dividerAt = firstUnread ? firstUnread.id : null;
      markThreadSeen(t.id);
      renderThreads();
      renderChat();
    };
    list.appendChild(item);
  }
}

function renderChat() {
  const t = S.threads.find((x) => x.id === currentThread);
  const head = $("#chat-header");
  const box = $("#chat-messages");
  const inputRow = $("#chat-input-row");
  const ro = $("#chat-readonly");
  if (!t) {
    head.textContent = "スレッドを選択してください";
    box.innerHTML = "";
    inputRow.classList.add("hidden");
    ro.classList.add("hidden");
    return;
  }
  const memberNames = t.members.map((id) => (charOf(id) || {}).name || id).join("、");
  head.textContent = `${t.name}(${memberNames})`;
  const msgs = S.messages.filter((m) => m.thread_id === t.id);
  let html = "";
  let lastDay = null;
  for (const m of msgs) {
    if (dividerAt !== null && m.id === dividerAt) {
      html += '<div class="unread-divider"><span>ここから未読</span></div>';
    }
    if (m.day !== lastDay) {
      lastDay = m.day;
      html += `<div class="day-divider"><span>${m.day === 0 ? "プロローグ" : m.day + "日目"}</span></div>`;
    }
    const c = charOf(m.sender);
    const mine = m.sender === S.player_id;
    html += `
      <div class="msg-row${mine ? " mine" : ""}">
        <div class="msg-avatar" style="background:${c ? c.color : "#999"}">${c ? esc(initialOf(c)) : "?"}</div>
        <div class="msg-body">
          ${mine ? "" : `<div class="msg-sender">${c ? esc(c.name) : esc(m.sender)}</div>`}
          <div class="msg-bubble">${esc(m.text)}</div>
          <div class="msg-meta">${esc(m.time)}</div>
        </div>
      </div>`;
  }
  box.innerHTML = html || '<div class="day-divider"><span>まだ会話がありません</span></div>';
  const dv = box.querySelector(".unread-divider");
  if (dv) dv.scrollIntoView({ block: "center" });
  else box.scrollTop = box.scrollHeight;
  const isMember = t.members.includes(S.player_id);
  inputRow.classList.toggle("hidden", !isMember);
  ro.classList.toggle("hidden", isMember);
}

function renderBadge() {
  const unseen = S.threads.reduce((sum, t) => sum + unreadCount(t), 0);
  const badge = $("#chat-badge");
  badge.textContent = unseen;
  badge.classList.toggle("hidden", unseen === 0);
}

// ---------------------------------------------------------------- events
document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`#view-${btn.dataset.tab}`).classList.add("active");
    // メッセージタブを開いただけでは既読にしない(スレッドを開いたときに付く)
    // 鍵垢タブは「いま表示しているプロフィール」だけ既読にする(他の人の未読は残る)
    if (btn.dataset.tab === "sns") {
      openProfile(currentProfile && charOf(currentProfile) ? currentProfile : S.player_id);
    }
    if (btn.dataset.tab === "debug") renderDebug();
  };
});

// --- debug(生のLLMログ) ---
async function renderDebug() {
  const box = $("#debug-list");
  box.innerHTML = '<div class="hint">読み込み中…</div>';
  let data;
  try {
    data = await api("/api/debug/llm?limit=20");
  } catch (e) {
    box.innerHTML = `<div class="day-block">取得に失敗しました: ${esc(e.message)}</div>`;
    return;
  }
  if (!data.calls.length) {
    box.innerHTML =
      '<div class="day-block">まだ記録がありません。LLMを呼ぶ操作(一日を進める・AIに考えてもらう・チャット送信)をすると、ここに溜まります。</div>';
    return;
  }
  box.innerHTML = data.calls
    .map((c) => {
      const usage = c.usage && c.usage.prompt_tokens != null
        ? ` ・ ${c.usage.prompt_tokens}→${c.usage.completion_tokens}tok`
        : "";
      const msgs = (c.messages || [])
        .map(
          (m) =>
            `<div class="dbg-role">${esc(m.role)}</div><pre class="dbg-pre">${esc(m.content || "")}</pre>`
        )
        .join("");
      return `
      <details class="scene">
        <summary>
          <div class="scene-head">
            <span class="time">${esc(c.purpose || "?")}</span>
            <span class="title">${esc(c.ts || "")} ・ ${esc(c.model || "")} ・ ${c.duration_sec}s${usage}${c.error ? " ・ ❌エラー" : ""}</span>
            <span class="open-hint">▼ 開く</span>
          </div>
        </summary>
        <div class="dbg-body">
          <h4 class="dbg-h">── 送信プロンプト</h4>
          ${msgs}
          <h4 class="dbg-h">── 応答</h4>
          <pre class="dbg-pre">${esc(c.response || c.error || "(空)")}</pre>
        </div>
      </details>`;
    })
    .join("");
}
$("#debug-refresh").onclick = renderDebug;

$("#suggest-btn").onclick = async () => {
  const btn = $("#suggest-btn");
  btn.disabled = true;
  btn.textContent = "考え中…";
  try {
    const { plan } = await api("/api/plan/suggest", { state: S, character_id: S.player_id });
    $("#plan-text").value = plan;
  } catch (e) {
    toast("エラー: " + e.message, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = "AIに考えてもらう";
  }
};

function setAdvanceUI(on) {
  advanceRunning = on;
  $("#advance-btn").disabled = on;
  $("#suggest-btn").disabled = on;
  $("#advance-status").classList.toggle("hidden", !on);
  if (on) {
    $("#advance-stage").textContent = "準備中…";
    $("#advance-percent").textContent = "";
    $("#advance-bar").style.width = "0%";
  }
}

function pollAdvance() {
  setAdvanceUI(true);
  const timer = setInterval(async () => {
    let j;
    try {
      j = await api("/api/advance/status");
    } catch {
      return; // 一時的な失敗は次のポーリングに任せる
    }
    $("#advance-stage").textContent = j.stage;
    $("#advance-percent").textContent = j.percent + "%";
    $("#advance-bar").style.width = j.percent + "%";
    if (j.running) return;
    clearInterval(timer);
    if (j.error) {
      toast("エラー: " + j.error, 8000);
      setAdvanceUI(false);
      return;
    }
    // 100%を見せてから閉じる
    $("#advance-bar").style.width = "100%";
    if (j.state && appliedJobs.advance !== j.job_id) {
      S = j.state;
      markJobApplied("advance", j.job_id);
      persistState();
      await fetchRewindDays();
      $("#plan-text").value = "";
      $("#god-text").value = ""; // 神の采配は一日限り
      renderAll();
      if (j.record) {
        renderLastResult(j.record);
        toast(`${j.record.day}日目が終わりました`);
      }
    }
    setTimeout(() => setAdvanceUI(false), 600);
  }, 700);
}

$("#advance-btn").onclick = async () => {
  if (advanceRunning) return;
  try {
    await saveSnapshotLocal(S); // この日の朝の状態を巻き戻し用に保存
    await api("/api/advance", {
      state: S,
      plan: $("#plan-text").value,
      god: $("#god-text").value,
    });
  } catch (e) {
    toast("エラー: " + e.message, 8000);
    return;
  }
  pollAdvance();
};

function showTyping(on) {
  const box = $("#chat-messages");
  const cur = box.querySelector(".typing-row");
  if (cur) cur.remove();
  if (on) {
    const el = document.createElement("div");
    el.className = "typing-row";
    el.innerHTML = '<span class="typing-bubble"><span>●</span><span>●</span><span>●</span></span>';
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }
}

async function sendChat() {
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text || !currentThread) return;
  if (advanceRunning) {
    toast("一日を進めている間は送信できません", 5000);
    return;
  }
  if (chatPending) return; // 返信待ちの間は連投しない
  const threadId = currentThread;
  input.value = "";
  // 自分の発言は即座にローカルへ反映・保存
  addMessageLocal(threadId, S.player_id, text);
  persistState();
  markThreadSeen(threadId);
  renderThreads();
  renderChat();
  // 返信はサーバでLLM生成して同期的に受け取る
  chatPending = true;
  showTyping(true);
  try {
    const { replies } = await api("/api/message/replies", {
      state: S,
      thread_id: threadId,
      text,
    });
    for (const r of replies) addMessageLocal(threadId, r.sender, r.text);
    if (replies.length) persistState();
  } catch (e) {
    toast("エラー: " + e.message, 6000);
  } finally {
    chatPending = false;
    showTyping(false);
  }
  renderThreads();
  renderChat();
  // 開いているスレッドへの返信だけ既読扱いにする
  if ($("#view-chat").classList.contains("active") && currentThread === threadId) {
    markThreadSeen(threadId);
    renderThreads();
  } else {
    renderBadge();
  }
}
$("#chat-send").onclick = sendChat;
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) sendChat();
});

// --- sns 投稿(鍵垢の独り言。LLM処理がないので完全にローカル) ---
function sendPost() {
  const input = $("#sns-input");
  const text = input.value.trim();
  if (!text) return;
  if (advanceRunning) {
    toast("一日を進めている間は投稿できません", 5000);
    return;
  }
  addPostLocal(S.player_id, text);
  persistState();
  input.value = "";
  $("#sns-count").textContent = "0/280";
  markProfileSeen(S.player_id); // 自分の投稿が自分の未読にならないように
  renderSns();
}
$("#sns-send").onclick = sendPost;
$("#sns-input").addEventListener("input", () => {
  $("#sns-count").textContent = `${$("#sns-input").value.length}/280`;
});
$("#sns-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) sendPost();
});

async function fetchRewindDays() {
  try {
    rewindDays = new Set(await snapshotDaysLocal());
  } catch {
    rewindDays = new Set();
  }
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".rewind-btn");
  if (!btn) return;
  if (advanceRunning || chatPending) {
    toast("処理の実行中は巻き戻せません", 5000);
    return;
  }
  const day = Number(btn.dataset.day);
  if (
    !confirm(
      `${day}日目の朝に戻ってやり直します。\n${day}日目以降のできごと・メッセージ・関係の変化はすべて消えます(取り消せません)。よろしいですか?`
    )
  )
    return;
  try {
    const snap = await loadSnapshotLocal(day);
    if (!snap) {
      toast(`${day}日目のスナップショットがありません`, 6000);
      return;
    }
    S = snap;
    await deleteSnapshotsAfterLocal(day); // 未来は上書き対象として破棄
    persistState();
    await claimServerJobs(); // 巻き戻し前のジョブ結果を誤って適用しない
    currentThread = null;
    dividerAt = null;
    await fetchRewindDays();
    renderAll();
    $("#last-result").classList.add("hidden");
    toast(`${day}日目の朝に戻りました。計画を立て直してください`);
  } catch (err) {
    toast("エラー: " + err.message, 6000);
  }
});

$("#export-btn").onclick = () => {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `crosstalk_save_day${S.day}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

$("#import-btn").onclick = () => $("#import-file").click();

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // 同じファイルを再選択できるようにリセット
  if (!file) return;
  if (advanceRunning || chatPending) {
    toast("処理の実行中は読み込みできません", 5000);
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast("JSONとして読み込めないファイルです", 6000);
    return;
  }
  if (
    !payload ||
    !Array.isArray(payload.characters) ||
    !payload.characters.length ||
    typeof payload.day !== "number"
  ) {
    toast("セーブデータとして読み込めませんでした(形式が違います)", 6000);
    return;
  }
  if (!confirm(`「${file.name}」を読み込みます。\n現在のプレイ状況は上書きされ、巻き戻し履歴も消えます。よろしいですか?`)) return;
  try {
    S = payload;
    await clearSnapshotsLocal(); // 旧タイムラインの巻き戻し履歴は破棄
    persistState();
    await claimServerJobs();
    currentThread = null;
    dividerAt = null;
    currentProfile = null;
    snsDividerAt = null;
    await applyMeta(); // 別シナリオのセーブならブランド表示も切り替わる
    await fetchRewindDays();
    renderAll();
    $("#last-result").classList.add("hidden");
    toast(`セーブデータを読み込みました(${S.day}日目)`);
  } catch (err) {
    toast("エラー: " + err.message, 8000);
  }
});

// --- 新しいゲーム(シナリオ選択モーダル) ---
let selectedScenario = null;

function renderScenarioList() {
  const list = $("#scenario-list");
  list.innerHTML = "";
  for (const sc of META?.available_scenarios || []) {
    const el = document.createElement("div");
    el.className = "scenario-option" + (sc.id === selectedScenario ? " selected" : "");
    el.innerHTML = `
      <div class="scenario-name">${esc(sc.name)}</div>
      <div class="scenario-id">${esc(sc.id)}${sc.id === META.id ? " ・ 現在プレイ中" : ""}</div>`;
    el.onclick = () => {
      selectedScenario = sc.id;
      renderScenarioList();
    };
    list.appendChild(el);
  }
}

$("#new-game-btn").onclick = () => {
  if (!META || !(META.available_scenarios || []).length) {
    toast("シナリオ一覧を取得できていません。リロードしてください", 6000);
    return;
  }
  selectedScenario = META.id; // 現在のシナリオを初期選択
  renderScenarioList();
  $("#newgame-modal").classList.remove("hidden");
};

$("#newgame-cancel").onclick = () => $("#newgame-modal").classList.add("hidden");

$("#newgame-modal").addEventListener("click", (e) => {
  if (e.target.id === "newgame-modal") $("#newgame-modal").classList.add("hidden"); // 外側クリックで閉じる
});

$("#newgame-start").onclick = async () => {
  if (advanceRunning || chatPending) {
    toast("処理の実行中ははじめられません", 5000);
    return;
  }
  const btn = $("#newgame-start");
  btn.disabled = true;
  try {
    S = await api("/api/initial?scenario=" + encodeURIComponent(selectedScenario || ""));
  } catch (e) {
    toast("エラー: " + e.message, 6000);
    btn.disabled = false;
    return;
  }
  $("#newgame-modal").classList.add("hidden");
  btn.disabled = false;
  await clearSnapshotsLocal();
  persistState();
  await claimServerJobs();
  currentThread = null;
  dividerAt = null;
  currentProfile = null;
  snsDividerAt = null;
  seenByThread = {};
  seenPostsByAuthor = {};
  saveSeen();
  saveSeenPosts();
  await applyMeta(); // 選んだシナリオのブランド表示に切り替わる
  await fetchRewindDays();
  renderAll();
  $("#last-result").classList.add("hidden");
  toast(`新しいゲームをはじめました — ${META ? META.name : ""}`);
};

// ---------------------------------------------------------------- init
async function applyMeta() {
  try {
    const meta = await api(
      "/api/meta?scenario=" + encodeURIComponent((S && S.scenario) || "")
    );
    META = meta;
    document.title = meta.page_title;
    document.querySelector(".brand .sub").textContent = meta.brand;
    $("#plan-text").placeholder = meta.plan_placeholder;
  } catch {}
}

(async () => {
  // セーブの正本はブラウザ。なければ旧サーバ保存→初期状態の順で探す
  S = loadLocalState();
  if (!S) {
    try {
      S = (await api("/api/legacy_save")).state;
      toast("サーバ保存時代のセーブを引き継ぎました");
    } catch {}
  }
  if (!S) S = await api("/api/initial");
  persistState();
  await applyMeta();
  await fetchRewindDays();
  renderAll();
  // リロード時、進行中・未適用のジョブがあればポーリングで拾う
  try {
    const j = await api("/api/advance/status");
    if (j.running || (j.state && j.job_id && appliedJobs.advance !== j.job_id)) {
      pollAdvance();
    }
  } catch {}
  try {
    const f = await api("/api/finale/status");
    if (f.running || (f.finale && f.job_id && appliedJobs.finale !== f.job_id)) {
      pollFinale();
    }
  } catch {}
})();
