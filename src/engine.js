// ゲームエンジン(server/engine.py の移植): 状態の要約、行動計画の生成、一日のシミュレーション。

import { chat, chatJson, loadSettings, DEFAULT_MODEL } from "./llm.js";
import * as scenario from "./scenario.js";
import {
  addMessage,
  addPost,
  charOf,
  ensureRel,
  threadById,
  ensureDm,
  weekdayOf,
} from "./state.js";

export function systemPrompt(S) {
  const sc = scenario.load(S.scenario);
  const model = loadSettings().model || DEFAULT_MODEL;
  return scenario.worldPromptFor(sc, model);
}

function styleRules(S) {
  const rules = scenario.load(S.scenario).style_rules || [];
  return rules.map((r) => `- ${r}\n`).join("");
}

// ---------------------------------------------------------------- 状態要約

export const UNDATED_EVENT_TTL = 2; // 期日未定の火種の寿命

export function activeEvents(S) {
  return (S.events || []).filter(
    (e) =>
      (e.due_day != null && e.due_day >= S.day) ||
      (e.due_day == null && S.day - e.created_day <= UNDATED_EVENT_TTL)
  );
}

export function resolveCharId(S, value) {
  if (!value) return null;
  const v = String(value).trim();
  if (charOf(S, v)) return v;
  for (const c of S.characters) {
    if (v === c.name || v === c.kana) return c.id;
  }
  // 「蓮(ren)」のような混在表記にも対応
  for (const c of S.characters) {
    if (c.name && v.includes(c.name)) return c.id;
  }
  return null;
}

// 状態要約はプロンプトキャッシュを効かせるため3層に分け、各層の境界に
// cache_control を置く(最大4ブレークポイント)。各境界は「先頭からそこまでの累積」が
// 4096tok(Opus)以上ないとキャッシュされない点に注意:
//   roster    = 可視範囲 + 登場人物。ゲーム中ずっと不変 → 日も呼び出し種別もまたいで読み出し(0.1倍)。
//   relations = 関係(間柄/片想い/肉体関係回数)。日進行で変わるが同一日内は不変 → 同日の全呼び出しで共有。
//   volatile  = 現在日・記憶・関係ログ・予定・直近ログ・SNS。日々変わる。計画↔シミュの同日ペアで一致。

export function stateRoster(S) {
  const lines = [];
  lines.push(
    "## 情報の可視範囲(厳守)\n" +
      "- 全体チャット=全員が読める / DM=参加者2人だけ / 鍵垢SNS=本人だけ / 秘密=本人だけ(他キャラのsecretやnoteに「知っている」と明記されている場合を除く)。\n" +
      "- 各キャラは自分が知り得る情報だけに基づいて行動・発言・推測すること。以下の全情報が見えているのはゲームマスターであるあなただけである。"
  );
  lines.push("\n## 登場人物");
  for (const c of S.characters) {
    const marker = c.id === S.player_id ? " ★プレイヤー操作中" : "";
    lines.push(
      `- ${c.name}(${c.id} / ${c.gender} / ${c.club})${marker}\n` +
        `  性格: ${c.personality}\n` +
        `  趣味: ${(c.hobbies || []).join("、")} / 口調: ${c.speech_style}\n` +
        `  秘密(本人のみが知る): ${c.secret} / 目標: ${c.goal}`
    );
  }
  return lines.join("\n");
}

// 関係セクション。roster の後ろに連結されるので先頭に空行を入れて区切る。
export function stateRelations(S) {
  const lines = ["\n\n## 関係(間柄 / 片想い / 肉体関係回数)"];
  for (const r of S.relationships) {
    const ca = charOf(S, r.a);
    const cb = charOf(S, r.b);
    if (!ca || !cb) continue;
    const bits = [];
    if (r.status) bits.push(r.status);
    for (const cid of r.crush || []) {
      const cc = charOf(S, cid);
      const target = cid === r.a ? cb : ca;
      if (cc && target) bits.push(`片想い(${cc.name}→${target.name})`);
    }
    const label = bits.length ? ` [${bits.join("/")}]` : "";
    const intimacy = r.intimacy_count ? ` / 肉体関係${r.intimacy_count}回` : "";
    const note = r.note ? ` — ${r.note}` : "";
    lines.push(`- ${ca.name}⇔${cb.name}${label}${intimacy}${note}`);
  }
  return lines.join("\n");
}

// roster + relations(後方互換: finale・スモーク用)
export function stateStable(S) {
  return `${stateRoster(S)}${stateRelations(S)}`;
}

export function stateVolatile(S, { recentDays = 2, msgDays = 1, msgLimit = 30 } = {}) {
  const lines = [];
  lines.push(`## 現在: ${S.day}日目(${weekdayOf(S.day)}曜日)`);
  // 各自の重要な記憶(驚きのある重大事実の長期記憶)
  const memChars = S.characters.filter((c) => (c.memory || []).length);
  if (memChars.length) {
    lines.push("\n## 各自の重要な記憶(本人の中に長く残っている重大な事実)");
    for (const c of memChars) {
      const mem = (c.memory || []).slice(-8);
      lines.push(
        `- ${c.name}: ${mem.map((m) => `${m.day}日目「${m.fact}」`).join(" / ")}`
      );
    }
  }
  // 関係ごとの最近の出来事ログ
  const relLogs = [];
  for (const r of S.relationships) {
    const log = (r.log || []).slice(-5);
    if (!log.length) continue;
    const ca = charOf(S, r.a);
    const cb = charOf(S, r.b);
    if (!ca || !cb) continue;
    relLogs.push(
      `- ${ca.name}⇔${cb.name}: ${log.map((e) => `${e.day}日目:${e.reason}`).join(" / ")}`
    );
  }
  if (relLogs.length) {
    lines.push("\n## 関係の最近の出来事");
    lines.push(...relLogs);
  }
  const active = activeEvents(S);
  if (active.length) {
    lines.push("\n## 予定・約束・くすぶる火種(未消化の伏線)");
    for (const e of active) {
      let due;
      if (e.due_day != null) {
        due = `${e.due_day}日目(${weekdayOf(e.due_day)})実行予定`;
        if (e.due_day === S.day) due += " ←今日!";
      } else {
        const left = e.created_day + UNDATED_EVENT_TTL - S.day;
        due = `期日未定・あと${left + 1}日で自然消滅`;
      }
      lines.push(`- (id:${e.id}) ${e.text} [${due}]`);
    }
  }
  const recent = (S.history || []).slice(-recentDays);
  if (recent.length) {
    lines.push("\n## 直近の出来事");
    for (const rec of recent) lines.push(`- ${rec.day}日目: ${rec.summary}`);
  }
  const recentMsgs = S.messages.filter((m) => m.day >= S.day - msgDays);
  if (recentMsgs.length) {
    lines.push("\n## 直近のメッセージアプリでのやり取り");
    for (const m of recentMsgs.slice(-msgLimit)) {
      const sender = charOf(S, m.sender);
      const thread = threadById(S, m.thread_id);
      const label = thread
        ? thread.kind === "group"
          ? `全体:${thread.name}`
          : `DM:${thread.name}|この2人のみ`
        : m.thread_id;
      lines.push(`- [${label}] ${sender ? sender.name : m.sender}: ${m.text}`);
    }
  }
  const recentPosts = (S.posts || []).filter((p) => p.day >= S.day - 2);
  if (recentPosts.length) {
    lines.push(
      "\n## 直近の各自の鍵垢SNSの投稿(全員が鍵アカウント。本人以外は誰も読めない本音の独り言)"
    );
    for (const p of recentPosts.slice(-20)) {
      const author = charOf(S, p.author);
      lines.push(`- ${p.day}日目[${p.time}] ${author ? author.name : p.author}: ${p.text}`);
    }
  }
  return lines.join("\n");
}

// 後方互換(finale・スモークなど一回限りの呼び出し用): stable + volatile を結合した文字列
export function summarizeState(S, opts) {
  return `${stateStable(S)}\n\n${stateVolatile(S, opts)}`;
}

// キャッシュ用ブロックのヘルパー。stable は全呼び出し共通の接頭辞として常にキャッシュする。
const cached = (text) => ({ type: "text", text, cache_control: { type: "ephemeral" } });
const plain = (text) => ({ type: "text", text });

// ---------------------------------------------------------------- 行動計画

export async function suggestPlan(S, charId) {
  const c = charOf(S, charId);
  if (!c) throw new Error(`不明なキャラクター: ${charId}`);
  const tail =
    `\n\nあなたは ${c.name} の今日(${S.day}日目・${weekdayOf(S.day)}曜日)の行動計画を考えます。\n` +
    `このキャラの性格・目標・秘密・現在の関係性に沿った、具体的で面白い一日の計画を100〜150字で書いてください。\n` +
    `誰にどう関わるか(あるいは避けるか)を必ず含め、探り・カマかけ・密会・口止めなどドラマが動く一手を入れること。\n` +
    `「## 予定・約束・くすぶる火種」にこのキャラが関わる項目があれば(特に今日が期日のもの)、必ず計画に織り込むこと。\n` +
    `計画の本文のみを出力してください。`;
  const text = await chat(
    [
      { role: "system", content: systemPrompt(S) },
      {
        role: "user",
        content: [
          cached(stateRoster(S)),
          cached(stateRelations(S)),
          plain(`\n\n${stateVolatile(S)}${tail}`),
        ],
      },
    ],
    { purpose: "行動計画の提案" }
  );
  return text.trim();
}

// 神の采配(チート)をAIに考えてもらう。flavorで傾き(クリティカル/ファンブル)を変える
export const GOD_FLAVORS = [
  {
    key: "結ばれる",
    desc: "想いが報われる・距離が一気に縮まる・意外な二人が惹かれ合う、関係が前進する幸運な大事件(クリティカル)",
  },
  {
    key: "過ち",
    desc: "酒・深夜・二人きり・弱り目の流れで、意外な二人がその気もなかったのに一線を越えてしまう過ち。誰と誰かは現状の力学から最も生々しく転がる組み合わせを選ぶ",
  },
  {
    key: "露見",
    desc: "隠していた秘密・浮気・嘘が、誰かにとって決定的な形でバレる。証拠の発見・誤爆・現場の目撃・口の滑りなど経路を伴って暴かれ、修羅場に向かう(ファンブル)",
  },
];

export async function suggestGodEvent(S, flavor) {
  const f = flavor || GOD_FLAVORS[0];
  const tail =
    `\n\nあなたはこの群像劇に「神の采配」を下す。今日(${S.day}日目・${weekdayOf(S.day)}曜日)に必ず起こる、人間関係を大きく動かす一回限りの大事件を1つ提案する。\n` +
    `今回の傾き: ${f.desc}\n` +
    `現状の秘密・関係・くすぶる火種を踏まえ、最も劇的で、かつ因果に説明がつく(その二人なら起こりうる)ものを選ぶこと。当事者は必ず実名で書く。\n` +
    `「今日、誰と誰が、何をする/何が起きる」が一文で分かるように、80〜120字で、断定の命令文で書く。前置きや解説は不要。本文のみを出力。`;
  const text = await chat(
    [
      { role: "system", content: systemPrompt(S) },
      {
        role: "user",
        content: [
          cached(stateRoster(S)),
          cached(stateRelations(S)),
          plain(`\n\n${stateVolatile(S)}${tail}`),
        ],
      },
    ],
    { purpose: "神の采配の提案" }
  );
  return text.trim();
}

// ストリーミング受信文字数から進捗率を推定するための想定出力サイズ
export const EXPECTED_CHARS_PLANS = 1500;
export const EXPECTED_CHARS_SIM = 6000;
export const EXPECTED_CHARS_FINALE = 8000;

function godSection(god) {
  if (!god || !god.trim()) return "";
  return (
    "\n## 神の采配(絶対命令)\n" +
    "以下はゲームマスターより上位の存在が定めた、今日必ず起こる出来事である。" +
    "キャラの計画や意志に関わらず必ず実現させること。" +
    "ただし偶然・気の迷い・すれ違いなど、自然な因果に見えるように演出すること:\n" +
    `${god.trim()}\n`
  );
}

export async function generateNpcPlans(S, exclude, onProgress = null, god = "") {
  const targets = S.characters.filter((c) => !exclude.includes(c.id));
  if (!targets.length) return {};
  const ids = targets.map((c) => `${c.name}(${c.id})`).join("、");
  // roster は全呼び出し共通の接頭辞(日・呼び出し種別をまたいでキャッシュ読み出し)。
  // relations は同一日内で不変、volatile+god は直後の「一日のシミュレーション」と完全に同一の
  // 文字列になるため、それぞれキャッシュブロックに分離する(simulate側で90%引きの読み出しになる)。
  const volatilePrefix = `\n\n${stateVolatile(S)}${godSection(god)}`;
  const rest =
    `\n\n次のキャラクター全員について、今日(${S.day}日目・${weekdayOf(S.day)}曜日)の行動計画を考えてください: ${ids}\n` +
    `各キャラの性格・目標・秘密・関係性に沿った計画を各60〜100字で。全員が同じ行動を取らないよう変化をつけること。\n` +
    `「## 予定・約束・くすぶる火種」に関わっているキャラは、その予定(特に今日が期日のもの)を計画に織り込むこと。\n` +
    `交際中・セフレ・浮気関係のキャラは、相手をデート・密会・お泊まりに誘う計画を定期的に立てること。\n` +
    `全員が毎日、疑念の追跡や調査をする必要はない。趣味や日常を過ごすだけの計画のキャラがいてよい。\n` +
    (god.trim()
      ? "「## 神の采配」が起こりうる流れになるよう、関係するキャラの計画を仕向けること(本人たちは神の意図を知らない)。\n"
      : "") +
    "次のJSON形式のみで出力:\n" +
    '{"plans": [{"character": "キャラid", "plan": "計画"}, ...]}';
  // 出力サイズの揺れでバーが止まって見えないよう、漸近カーブで進める
  const cb = onProgress
    ? (n) => onProgress(n / (n + EXPECTED_CHARS_PLANS * 0.35))
    : null;
  const data = await chatJson(
    [
      { role: "system", content: systemPrompt(S) },
      {
        role: "user",
        content: [
          cached(stateRoster(S)),
          cached(stateRelations(S)),
          cached(volatilePrefix),
          plain(rest),
        ],
      },
    ],
    { onProgress: cb, purpose: "NPC行動計画の生成" }
  );
  const plans = {};
  for (const item of data.plans || []) {
    const cid = resolveCharId(S, item.character);
    if (cid && !exclude.includes(cid)) plans[cid] = String(item.plan || "").trim();
  }
  // LLMが漏らしたキャラには無難な計画を入れる
  for (const c of targets) {
    if (!plans[c.id]) plans[c.id] = "いつも通りに過ごす。";
  }
  return plans;
}

// ---------------------------------------------------------------- 一日の実行

const SIMULATE_FORMAT = `次のJSON形式のみで出力してください:
{
  "scenes": [
    {"time": "場面の時点の自由な表記(例: 朝練後、昼休み、稽古終わり、終電前、深夜2時)", "title": "場面タイトル", "participants": ["キャラid"], "main": "この場面の主役=視点人物のキャラid", "summary": "何が起きたかの要約(1〜2文・50字程度)", "novel": "600〜900字の短編小説。三人称で、mainの内面・情景・セリフを織り交ぜ、各キャラの口調を守る。段落の区切りやセリフの前後で必ず改行(JSON文字列内では\\n)を入れ、全文を一行にしないこと。"}
  ],
  "relationship_changes": [
    {"a": "キャラid", "b": "キャラid", "reason": "関係が動いた出来事(短文)", "status": "二人の間柄が変わったときだけ次の列挙から選ぶ: 交際|元恋人|敵意(関係の決裂・宣戦布告)|解消(間柄なしに戻る)。変化がなければ省略", "crush_add": ["新たに片想いを始めた側のキャラid(任意)"], "crush_remove": ["想いに区切りをつけた側のキャラid(任意)"], "slept": この日に2人が肉体関係を持った場合のみtrue}
  ],
  "messages": [
    {"thread": "group" または "dm", "members": ["dmの場合のみ参加者2人のキャラid"], "sender": "キャラid", "text": "メッセージ本文(口調を守る・絵文字や省略も自然に)", "time": "午前|夕方|夜|深夜"}
  ],
  "posts": [
    {"author": "キャラid", "text": "本人の鍵垢SNSへの投稿本文(誰にも読まれない前提の本音の独り言)", "time": "午前|夕方|夜|深夜"}
  ],
  "new_events": [
    {"text": "今日成立した、特定の日に行われる具体的な予定(例: 「水曜の夜、蓮と紗英が二人きりでディナー」)", "due_day": 実行予定の絶対日数の整数(必須に近い。nullは誤爆の後始末など例外のみ), "chars": ["その予定に実際に参加する当事者のキャラidのみ"]}
  ],
  "memories": [
    {"character": "キャラid", "fact": "そのキャラが今日知った/経験した、後々まで尾を引く『驚きのある重大な事実』を、当事者の実名と具体的な中身まで省略せず書く(良い例:「紗英から『蓮が美桜と浮気している』と打ち明けられた」「自分の恋人=美桜の決定的な浮気現場を見た」)。誰と誰かを落とした曖昧な要約(悪い例:「蓮の浮気を聞いた」「秘密を知った」)は禁止。情緒的な出来事の要約ではなく、後日その知識で動ける形の事実にする。些細な日常は入れない"}
  ],
  "resolved_event_ids": [今日のシーンやメッセージで実行・消化した予定のid(整数)],
  "day_summary": "この日全体の要約(100字程度)"
}`;

// テンプレートリテラル内の改行・字下げはそのままプロンプトに入るため、行頭は字下げしない
const SIMULATE_RULES = `ルール:
- scenesは時間帯の割り当てに縛られず、この日に起きた出来事のうち特筆すべきものを3〜5つ選んで時系列順に書くこと。同じ時間帯に2場面あっても、何も起きない時間帯があってもよい。timeは「朝練後」「終電前」のような自由な表記でよい。場面に選ばれなかったキャラの動きは messages や relationship_changes で表現する。
- ★プレイヤー操作中のキャラの行動計画が結実または破綻する場面を必ず1つ以上含め、その場面ではプレイヤーのキャラをmainにすること。プレイヤーの行動は要約やmessagesで済ませず、必ず小説として描く。
- novelは一つの場面を腰を据えて深く描く短編。視点人物を一人決め、その内面に潜ること。要約の繰り返しではなく、空気・間・言えなかった一言を書く。数を増やすより一場面を濃く書くことを優先する。複数の段落に分け、段落の境目は改行(\n)で区切ること(全文を一行にしない)。絵文字は使わない。
- 2人が肉体関係を持った日は、必ずnovelにそのピロートークか朝チュンの場面を書く。
- 各キャラは自分の行動計画に沿って動くが、計画通りにいかない偶発事——目撃、鉢合わせ、スマホの見間違い、口の滑り——を必ず1つ以上起こすこと。
- 誰かの秘密は毎日少しずつ漏れる。ただし一気に暴かない。疑念や違和感を積み上げ、爆発(修羅場)は溜まり切ったときだけ。
- 「## 情報の可視範囲」を厳守すること。キャラが自分の知り得ない情報(他人のDM・鍵垢・秘密)を行動・発言・推測の根拠にするのは禁止。あなたは全知だが、キャラは全知ではない。
- 情報が他人に伝わるときは、必ず伝達経路——目撃、盗み聞き、誤爆、又聞き、カマかけの成功——をその日のシーンかmessagesで描くこと。経路を描かずに知識だけが伝わるのは禁止。伝わった事実はrelationship_changesのreasonに残し、以後そのキャラは知っているものとして扱う。
- relationship_changesは実際に描写した出来事に基づくものだけ。3〜6件程度。
- 2人が肉体関係を持った日は、そのペアの relationship_changes に slept:true を必ず付けること。sleptは実際に性行為があった場合のみ。友人同士の添い寝・お泊まり・相談のための宿泊はsleptにしないこと。
- messagesやシーン外で密会・お泊まりを示唆した場合も、実際に関係を持ったのなら必ず slept:true を記録すること。シーンに描かれなかった出来事でも、起きたことは構造データに残す。逆に何も起きなかったのなら、それと分かる描写やメッセージを残し、宙ぶらりんにしないこと。
- 恋愛感情だけでなく欲望も物語の駆動力である。酒・深夜・二人きり・弱り目・据え膳といった状況が揃えば、プレイヤーが関与しない裏でもNPC同士は自分の意志で一線を越える(slept:trueを忘れずに)。特に恋人のいる男性キャラは積極的に恋人と夜を過ごそうとする。理性で踏みとどまるのは、その我慢自体がドラマになるときだけ。
- statusの変更(交際開始・婚約・破局など)や crush_add/crush_remove(片想いの発生・終わり)は、流れがそれに見合うときだけ。statusは列挙された値以外を発明しないこと。関係の細かい質感(秘密の交際、独占欲、気まずさ等)はreasonに書けば記録される。
- messagesはその日の出来事を受けたやり取りを8〜20件。全体のグループチャット(thread=group)と、個人間のDM(thread=dm、membersに2人指定)を織り交ぜる。DMでは密会の約束・嘘・本音・送信先間違いが起こりうる。グループでは平和を装い、DMで裏が動く、の温度差を大切に。
- postsは各自の鍵垢SNSへの投稿を4〜8件。全員が鍵アカウントで相互フォローもなく、誰にも読まれない前提の独り言である。人目を気にする必要がないので、日常・近況に混じって、愚痴・恨みつらみ・嫉妬・浮かれ・罪悪感・本人すら認めたくない本音が、名指しも遠慮もなくそのまま書かれる。表のグループチャットで装った平和と、鍵垢に吐き出される本音の温度差こそが醍醐味。その日の出来事で心が動いた人ほど書く。互いの鍵垢は見えないため、投稿への反応や言及は起こらない。全員が毎日投稿する必要はない。書かずに溜め込む人がいるのも自然。
- postsは「小説の地の文」ではなく「実在のSNS投稿」として書くこと。これは最重要のルール。1投稿1〜2文まで、口語で崩し、絵文字・「〜」「…」「笑」「ww」を自然に混ぜる。整った文学的なモノローグ、内省の長文、詩的な言い回しは禁止。つらい本音や秘密を吐き出すときも同じで、生々しさは「文学的な内省」ではなく「短くて身も蓋もない一言」で出すこと。
  例(悪い・地の文すぎる): 「聞きたくなかった話を抱えたまま、明日もカフェで笑うんだ。わたし、ちゃんと笑えるかな」
  例(良い・SNSっぽい): 「明日もカフェで笑う側、しんどいなー😇 え、わたし笑えてる?笑」
- そのうえで文体は各キャラの口調(speech_style)に合わせる。明るい・砕けた・テンション高めのキャラ(陽キャ)は絵文字多め・ノリと勢い・ハッシュタグ。落ち着いた・皮肉屋・淡々としたキャラは絵文字控えめでも、あくまで短いSNS口調(地の文にはしない)。誰が書いたかで文体がはっきり違うこと。
- 既存の関係にないキャラ同士の新しい絡みも歓迎(新しい関係エッジは relationship_changes に含めれば自動で作られる)。
- memoriesは「## 登場人物」の各自の『重要な記憶』として長期に持ち越され、後日そのキャラがその知識に基づいて動くための判断材料になる。だから記録は"出来事の情緒的な要約"ではなく、「誰が・誰と・何を」が後から使える具体的事実にすること。特に秘密・浮気・関係の発覚は当事者の実名(誰と誰か)を必ず残す——「蓮の浮気を聞いた」ではなく「紗英から『蓮が美桜と浮気している』と聞いた」と書く。一つの場面で"重大な事実の判明"と"自分の経験(一線を越えた等)"が両方起きたなら、事実の方を落とさず両方を別のmemoryに分けてよい。記録対象は驚きのある重大事実だけ(秘密の発覚・決定的な目撃・告白・破局・一線を越える等)で、ご飯を食べた等の些細な日常は入れない。該当が無ければ空配列。1日0〜2件。
- 「## 予定・約束」に挙がっている項目のうち due が今日のものは、必ず今日のシーンかメッセージで実行・消化し、そのidを resolved_event_ids に入れること。期日未定の火種も、機が熟したら拾って消化してよい。
- new_eventsは「特定の日に・誰と誰が・何をする」が決まった具体的な予定だけを登録する(0〜2件)。デート・密会・お泊まり・誕生日・呼び出し・対決などで、必ずdue_dayを付けること(期日未定が許されるのは誤爆・暴露の後始末のような例外だけ。2日で自然消滅する)。
- すでに「## 予定・約束」に載っている予定を再登録しないこと。約束の再確認・楽しみにしている会話は登録対象ではない。日時や内容が変わった場合だけ、resolved_event_idsで旧idを消化した上で新しい予定として登録し直す。
- 進行中の疑念・調査・観察・心理状態(「〜を狙っている」「〜の瀬戸際」「〜に気づき始めた」等)は予定ではないので、new_eventsに登録しないこと。そうした状態はrelationship_changesのreasonやpostsに書けば十分に残る。
- 交際中・セフレ・浮気関係のペアは、関係を維持するために自分から動く。数日に一度はデート・密会・お泊まりに誘い、約束が成立したら必ずnew_eventsに登録すること。誘いの口実は趣味や日常(行きつけの店・サウナ・カフェ・ドライブ・新作スイーツ等)から取ると自然になる。`;

// LLM応答(data)を状態に適用する純粋部。テストしやすいよう simulateDay から分離
export function applySimulationResult(S, data, plans, god = "") {
  const record = {
    day: S.day,
    weekday: weekdayOf(S.day),
    plans,
    god_note: (god || "").trim(),
    scenes: [],
    summary: "",
    relationship_changes: [],
  };

  for (const s of data.scenes || []) {
    const participants = (s.participants || [])
      .map((p) => resolveCharId(S, p))
      .filter(Boolean);
    let main = resolveCharId(S, s.main) || "";
    if (!main) main = participants[0] || "";
    record.scenes.push({
      time: String(s.time || ""),
      title: String(s.title || ""),
      participants,
      main,
      summary: String(s.summary || ""),
      narrative: String(s.novel || s.narrative || ""),
    });
  }

  for (const ch of data.relationship_changes || []) {
    const a = resolveCharId(S, ch.a);
    const b = resolveCharId(S, ch.b);
    if (!a || !b || a === b) continue;
    const rel = ensureRel(S, a, b);
    const status = String(ch.status || "").trim();
    if (status) {
      rel.status = ["解消", "なし"].includes(status) ? "" : status;
    }
    const crushAdd = [];
    for (const raw of ch.crush_add || []) {
      const cid = resolveCharId(S, raw);
      if ((cid === a || cid === b) && !rel.crush.includes(cid)) {
        rel.crush.push(cid);
        crushAdd.push(cid);
      }
    }
    const crushRemove = [];
    for (const raw of ch.crush_remove || []) {
      const cid = resolveCharId(S, raw);
      if (cid && rel.crush.includes(cid)) {
        rel.crush = rel.crush.filter((x) => x !== cid);
        crushRemove.push(cid);
      }
    }
    const slept = Boolean(ch.slept);
    if (slept) rel.intimacy_count += 1;
    const reason = String(ch.reason || "");
    if (reason) {
      // noteは初期の説明文として残し、出来事は直近5件のログに追記していく
      rel.log = rel.log || [];
      rel.log.push({ day: S.day, reason });
      if (rel.log.length > 5) rel.log = rel.log.slice(-5);
    }
    record.relationship_changes.push({
      a,
      b,
      reason,
      status,
      crush_add: crushAdd,
      crush_remove: crushRemove,
      slept,
    });
  }

  const groupThread = S.threads.find((t) => t.kind === "group");
  for (const m of data.messages || []) {
    const sender = resolveCharId(S, m.sender);
    if (!sender) continue;
    const text = String(m.text || "").trim();
    if (!text) continue;
    const time = String(m.time || "夜");
    if (m.thread === "group") {
      if (groupThread) addMessage(S, groupThread.id, sender, text, time);
    } else {
      const members = (m.members || [])
        .map((p) => resolveCharId(S, p))
        .filter(Boolean);
      if (!members.includes(sender)) members.push(sender);
      if (members.length !== 2) continue;
      const thread = ensureDm(S, members[0], members[1]);
      addMessage(S, thread.id, sender, text, time);
    }
  }

  for (const p of data.posts || []) {
    const author = resolveCharId(S, p.author);
    const text = String(p.text || "").trim();
    if (!author || !text) continue;
    addPost(S, author, text, String(p.time || "夜"));
  }

  // 重要記憶: 驚きのある重大事実だけを各キャラに長期保存(直近8件まで)
  for (const m of data.memories || []) {
    const cid = resolveCharId(S, m.character);
    const fact = String(m.fact || "").trim();
    if (!cid || !fact) continue;
    const c = charOf(S, cid);
    if (!c) continue;
    c.memory = c.memory || [];
    c.memory.push({ day: S.day, fact });
    if (c.memory.length > 8) c.memory = c.memory.slice(-8);
  }

  // 予定・伏線の消化と登録
  const resolved = new Set();
  for (const i of data.resolved_event_ids || []) {
    const n = parseInt(i, 10);
    if (!Number.isNaN(n)) resolved.add(n);
  }
  S.events = S.events.filter((e) => !resolved.has(e.id));
  for (const ev of data.new_events || []) {
    const text = String(ev.text || "").trim();
    if (!text) continue;
    let due = ev.due_day;
    due = due == null ? null : parseInt(due, 10);
    if (Number.isNaN(due)) due = null;
    const chars = (ev.chars || []).map((c) => resolveCharId(S, c)).filter(Boolean);
    // 同じ当事者×同じ期日の予定はLLMが再登録しがちなので、新規追加せず本文を上書きする
    if (due != null && chars.length) {
      const key = [...chars].sort().join(",");
      const dupe = S.events.find(
        (e) =>
          e.due_day === due && [...(e.chars || [])].sort().join(",") === key
      );
      if (dupe) {
        dupe.text = text;
        continue;
      }
    }
    S.events.push({
      id: S.next_event_id++,
      text,
      created_day: S.day,
      due_day: due,
      chars,
    });
  }

  record.summary = String(data.day_summary || "");
  S.history.push(record);
  S.day += 1;
  // 期日切れの予定と、TTLを過ぎた期日未定の火種を捨てる
  S.events = activeEvents(S);
  const undated = S.events.filter((e) => e.due_day == null);
  if (undated.length > 8) {
    const drop = new Set(undated.slice(0, undated.length - 8).map((e) => e.id));
    S.events = S.events.filter((e) => !drop.has(e.id));
  }
  S.pending_plans = {};
  return record;
}

export async function simulateDay(S, plans, onProgress = null, god = "") {
  const planLines = [];
  for (const [cid, plan] of Object.entries(plans)) {
    const c = charOf(S, cid);
    if (c) planLines.push(`- ${c.name}(${cid}): ${plan}`);
  }
  // generateNpcPlans と同一の状態要約ブロック → キャッシュが効く(5分TTL内)
  const volatilePrefix = `\n\n${stateVolatile(S)}${godSection(god)}`;
  // シナリオが simulate_rules を持てば既定の(恋愛ドロドロ前提の)ルールを差し替える
  const rules = scenario.load(S.scenario).simulate_rules || SIMULATE_RULES;
  const rest =
    `\n\n## 今日(${S.day}日目・${weekdayOf(S.day)}曜日)の各自の行動計画\n` +
    planLines.join("\n") +
    `\n\nこの一日をシミュレートしてください。\n${rules}\n` +
    (god.trim()
      ? "- 「## 神の采配」の内容は今日必ず起こす。シーン・messages・relationship_changesに確実に反映すること。\n"
      : "") +
    styleRules(S) +
    "- JSON内のキャラ指定(participants/main/a/b/sender/members)には必ず英字idのみを使い、名前を書かないこと: " +
    S.characters.map((c) => `${c.id}=${c.name}`).join("、") +
    `\n\n${SIMULATE_FORMAT}`;
  const cb = onProgress
    ? (n) => onProgress(n / (n + EXPECTED_CHARS_SIM * 0.35))
    : null;
  const data = await chatJson(
    [
      { role: "system", content: systemPrompt(S) },
      {
        role: "user",
        content: [
          cached(stateRoster(S)),
          cached(stateRelations(S)),
          cached(volatilePrefix),
          plain(rest),
        ],
      },
    ],
    { onProgress: cb, purpose: "一日のシミュレーション" }
  );
  return applySimulationResult(S, data, plans, god);
}

// ---------------------------------------------------------------- 終幕

// 終幕は出力が大きく1回ではmax_tokensを超えて途中で切れるため、3回に分割する。
const FINALE_SUMMARY_FORMAT = `次のJSON形式のみで出力してください:
{
  "title": "シーズンタイトル(物語の内容を踏まえた印象的な題)",
  "tagline": "一行キャッチコピー",
  "overall": "シーズン全体の総括(600〜900字。誰が何を隠し、どこから綻び、関係がどう動いたかを物語として振り返る)",
  "highlights": [{"day": 日数の整数, "text": "名場面の振り返り(50字程度)"}],
  "awards": [{"name": "賞の名前(例: 最優秀二股賞)", "character": "キャラid", "reason": "授賞理由(ユーモアと毒を込めて50字程度)"}]
}`;

const FINALE_REVIEWS_FORMAT = `次のJSON形式のみで出力してください:
{
  "goal_reviews": [{"character": "キャラid", "verdict": "当初の目標の達成度を「達成」「半分」「未達」のいずれか一語で", "evaluation": "そう判定した理由を、実際に起きた出来事を根拠に(60〜100字)", "comment": "その評価に対する本人のコメント(口調厳守・80〜150字)"}],
  "comments": [{"character": "キャラid", "text": "本人コメント(150〜250字、口調厳守)"}]
}`;

const FINALE_WORDS_FORMAT = `次のJSON形式のみで出力してください:
{
  "final_words": [{"from": "キャラid", "to": [{"target": "宛先のキャラid", "text": "その相手一人だけに面と向かって言う本音のひとこと(口調厳守・40〜100字)"}]}]
}`;

export function fullDossier(S) {
  const lines = [`## プレイ期間: 1日目〜${S.day - 1}日目`];
  lines.push("\n## 登場人物(全員の秘密・目標を含む)");
  for (const c of S.characters) {
    lines.push(
      `- ${c.name}(${c.id} / ${c.gender} / ${c.club})\n` +
        `  性格: ${c.personality} / 口調: ${c.speech_style}\n` +
        `  秘密: ${c.secret} / 目標: ${c.goal}`
    );
  }
  lines.push("\n## 最終的な関係(間柄 / 片想い / 肉体関係の累計回数 / 直近の出来事)");
  for (const r of S.relationships) {
    const ca = charOf(S, r.a);
    const cb = charOf(S, r.b);
    if (!ca || !cb) continue;
    const bits = [];
    if (r.status) bits.push(r.status);
    for (const cid of r.crush || []) {
      const cc = charOf(S, cid);
      const target = cid === r.a ? cb : ca;
      if (cc && target) bits.push(`片想い(${cc.name}→${target.name})`);
    }
    const label = bits.length ? ` [${bits.join("/")}]` : "";
    const intimacy = r.intimacy_count ? ` / 肉体関係${r.intimacy_count}回` : "";
    const note = r.note ? ` — ${r.note}` : "";
    lines.push(`- ${ca.name}⇔${cb.name}${label}${intimacy}${note}`);
  }
  if (S.history.length) {
    lines.push("\n## 日々の記録");
    for (const rec of S.history) {
      lines.push(`- ${rec.day}日目(${rec.weekday}): ${rec.summary}`);
    }
  }
  lines.push("\n## 裏でのやり取り(各DMの全ログ ※直近40件まで)");
  for (const t of S.threads) {
    if (t.kind !== "dm") continue;
    const msgs = S.messages.filter((m) => m.thread_id === t.id).slice(-40);
    if (!msgs.length) continue;
    lines.push(`### ${t.name}`);
    for (const m of msgs) {
      const c = charOf(S, m.sender);
      lines.push(`  ${m.day}日目 ${c ? c.name : m.sender}: ${m.text}`);
    }
  }
  const groupIds = new Set(S.threads.filter((t) => t.kind === "group").map((t) => t.id));
  const group = S.messages.filter((m) => groupIds.has(m.thread_id)).slice(-30);
  if (group.length) {
    lines.push("\n## グループチャット(直近30件)");
    for (const m of group) {
      const c = charOf(S, m.sender);
      lines.push(`  ${m.day}日目 ${c ? c.name : m.sender}: ${m.text}`);
    }
  }
  const posts = (S.posts || []).slice(-40);
  if (posts.length) {
    lines.push("\n## 全員の鍵垢SNSの投稿(直近40件。誰にも見せるつもりのなかった本音の記録)");
    for (const p of posts) {
      const c = charOf(S, p.author);
      lines.push(`  ${p.day}日目 ${c ? c.name : p.author}: ${p.text}`);
    }
  }
  return lines.join("\n");
}

// 終幕の各分割呼び出し。長大なdossier+共通指示(head)はキャッシュブロックにして
// 3回の呼び出しで共有する(2回目以降は0.1倍の読み出しになる)。
async function finaleCall(S, head, tail, cb, purpose) {
  return chatJson(
    [
      { role: "system", content: systemPrompt(S) },
      { role: "user", content: [cached(head), plain(tail)] },
    ],
    { onProgress: cb, purpose }
  );
}

// 0..1のストリーミング進捗を全体バーの[base, base+span]区間にマッピングする
function finaleSeg(onProgress, base, span, expected) {
  if (!onProgress) return null;
  return (n) => onProgress(base + span * (n / (n + expected * 0.35)));
}

export async function generateFinale(S, onProgress = null) {
  const head =
    `${fullDossier(S)}\n\n` +
    "プレイが終了しました。これからシーズン総括を複数パートに分けて作ります。\n" +
    scenario.load(S.scenario).finale_prompt +
    "\n- 事実(上記の記録)に忠実に。キャラ指定は必ず英字id: " +
    S.characters.map((c) => `${c.id}=${c.name}`).join("、") +
    "\n";

  // ① 総括(title/tagline/overall/highlights/awards)
  const sum = await finaleCall(
    S,
    head,
    "\n## いま作るパート: シーズン総括\n" +
      "- overallは物語として面白く、しかし事実に忠実に(600〜900字)。\n" +
      "- highlightsは5〜8件、実際にあった出来事から選ぶこと。\n" +
      "- awardsは3〜5件。ユーモアと毒を込めるが、事実に基づくこと。\n\n" +
      FINALE_SUMMARY_FORMAT,
    finaleSeg(onProgress, 0, 0.35, 2500),
    "終幕①総括"
  );

  // ② 各人の結末(goal_reviews + comments)
  const rev = await finaleCall(
    S,
    head,
    "\n## いま作るパート: 各人の結末\n" +
      "- goal_reviewsは全員分を必ず出すこと。各キャラの当初の目標(goal)が、このシーズンの出来事を経て達成できたかを、実際に起きた事実に基づいて判定(達成/半分/未達)し、本人のコメントを添える(口調厳守)。\n" +
      "- commentsは全員分を必ず出すこと。各自が「初めて知って」最も衝撃を受けたはずの事実への反応を含め、怒り・動揺・開き直り・安堵など、その人の性格と口調に忠実に。修羅場上等。\n\n" +
      FINALE_REVIEWS_FORMAT,
    finaleSeg(onProgress, 0.35, 0.45, 4000),
    "終幕②各人の結末"
  );

  // ③ それぞれへの本音(final_words)
  const fw = await finaleCall(
    S,
    head,
    "\n## いま作るパート: それぞれへの本音\n" +
      "- final_wordsは全員分を必ず出すこと。各キャラが、このシーズンで関わりの深かった相手・因縁のある相手を2〜4人選び、その一人ひとりに向けて、全部を知った今だからこそ面と向かって言う本音を書く。宛先(target)は実際に絡みのあった相手を選ぶこと。感謝・恨み・未練・謝罪・宣戦布告・嫌味など、その二人の関係に応じて宛先ごとに内容を変え、口調を厳守。自分自身は宛先にしない。\n\n" +
      FINALE_WORDS_FORMAT,
    finaleSeg(onProgress, 0.8, 0.2, 2000),
    "終幕③本音"
  );

  const data = { ...sum, ...rev, ...fw };
  const comments = [];
  for (const cm of data.comments || []) {
    const cid = resolveCharId(S, cm.character);
    const text = String(cm.text || "").trim();
    if (cid && text) comments.push({ character: cid, text });
  }
  const awards = [];
  for (const aw of data.awards || []) {
    const cid = resolveCharId(S, aw.character);
    if (cid && aw.name) {
      awards.push({
        name: String(aw.name),
        character: cid,
        reason: String(aw.reason || ""),
      });
    }
  }
  const goalReviews = [];
  for (const g of data.goal_reviews || []) {
    const cid = resolveCharId(S, g.character);
    if (!cid) continue;
    goalReviews.push({
      character: cid,
      verdict: String(g.verdict || "").trim(),
      evaluation: String(g.evaluation || "").trim(),
      comment: String(g.comment || "").trim(),
    });
  }
  const finalWords = [];
  for (const fw of data.final_words || []) {
    const from = resolveCharId(S, fw.from);
    if (!from) continue;
    const to = [];
    for (const t of fw.to || []) {
      const target = resolveCharId(S, t.target);
      const text = String(t.text || "").trim();
      if (target && target !== from && text) to.push({ target, text });
    }
    if (to.length) finalWords.push({ from, to });
  }
  return {
    title: String(data.title || "シーズン総括"),
    tagline: String(data.tagline || ""),
    overall: String(data.overall || ""),
    highlights: (data.highlights || [])
      .filter((h) => h.text)
      .map((h) => ({ day: h.day ?? null, text: String(h.text) })),
    awards,
    goal_reviews: goalReviews,
    comments,
    final_words: finalWords,
    generated_on_day: S.day,
  };
}

// ---------------------------------------------------------------- チャット介入

// プレイヤーが次にそのスレッドへ送る一言をAIに考えさせる(入力欄の下書き用)
export async function suggestMessage(S, threadId) {
  const thread = threadById(S, threadId);
  const player = charOf(S, S.player_id);
  if (!thread || !player) throw new Error("不明なスレッドです");
  if (!thread.members.includes(S.player_id))
    throw new Error("参加していないスレッドには送信できません");
  const others = thread.members
    .filter((cid) => cid !== S.player_id)
    .map((cid) => charOf(S, cid))
    .filter(Boolean);
  const history = S.messages.filter((m) => m.thread_id === threadId).slice(-25);
  const histLines = history.map((m) => {
    const c = charOf(S, m.sender);
    return `${c ? c.name : m.sender}: ${m.text}`;
  });
  const names = others.map((c) => `${c.name}(${c.id})`).join("、") || "(まだ誰もいない)";
  const tail =
    `\n\n## メッセージアプリ「${thread.name}」の直近ログ\n` +
    (histLines.join("\n") || "(まだ会話なし)") +
    "\n\n" +
    `あなたは ${player.name} です。このトーク(相手: ${names})で、${player.name} が次に送るメッセージを1つ書いてください。\n` +
    `${player.name} の口調(${player.speech_style})・性格・目標・秘密・現在の関係性に沿うこと。会話の流れを自然に受け、探り・甘え・はぐらかし・本音などドラマが動く一言だと良い。\n` +
    `メッセージ1通分の本文だけを、鉤括弧や説明や名前を付けずに出力してください。`;
  const text = await chat(
    [
      { role: "system", content: systemPrompt(S) },
      {
        role: "user",
        content: [
          cached(stateRoster(S)),
          cached(stateRelations(S)),
          plain(`\n\n${stateVolatile(S, { msgDays: 2, msgLimit: 60 })}${tail}`),
        ],
      },
    ],
    { purpose: "プレイヤー返信の提案" }
  );
  // 余計な鉤括弧が付いたら剥がす
  return text.trim().replace(/^「(.*)」$/s, "$1").trim();
}

export async function npcReplies(S, threadId, playerText) {
  const thread = threadById(S, threadId);
  const player = charOf(S, S.player_id);
  if (!thread || !player) return [];
  const others = thread.members.filter((cid) => cid !== S.player_id);
  if (!others.length) return [];
  const history = S.messages.filter((m) => m.thread_id === threadId).slice(-25);
  const histLines = history.map((m) => {
    const c = charOf(S, m.sender);
    return `${c ? c.name : m.sender}: ${m.text}`;
  });
  const names = others
    .map((cid) => charOf(S, cid))
    .filter(Boolean)
    .map((c) => `${c.name}(${c.id})`)
    .join("、");
  // チャット返信では記憶の穴を防ぐため、メッセージ窓を広めに取る
  const tail =
    `\n\n## メッセージアプリ「${thread.name}」の直近ログ\n` +
    histLines.join("\n") +
    "\n\n" +
    `たった今、${player.name} がこう送信しました: 「${playerText}」\n\n` +
    `このスレッドの他の参加者(${names})のうち、返信しそうな人だけが返信します(0〜3件)。\n` +
    `既読スルーが自然なら空配列でも構いません。各自の口調・関係性・時間帯を守ること。\n` +
    `senderには必ず英字id(括弧内のid)を使うこと。\n` +
    `次のJSON形式のみで出力: {"replies": [{"sender": "キャラid", "text": "本文"}]}`;
  const data = await chatJson(
    [
      { role: "system", content: systemPrompt(S) },
      {
        role: "user",
        content: [
          cached(stateRoster(S)),
          cached(stateRelations(S)),
          plain(`\n\n${stateVolatile(S, { msgDays: 2, msgLimit: 60 })}${tail}`),
        ],
      },
    ],
    { purpose: "チャット返信の生成" }
  );
  const replies = [];
  for (const r of (data.replies || []).slice(0, 3)) {
    const cid = resolveCharId(S, r.sender);
    const text = String(r.text || "").trim();
    if (cid && others.includes(cid) && text) replies.push({ sender: cid, text });
  }
  return replies;
}
