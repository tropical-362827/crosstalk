"""ゲームエンジン: 状態の要約、行動計画の生成、一日のシミュレーション。"""

from __future__ import annotations

from . import scenario
from .llm import chat, chat_json, load_config
from .models import DayRecord, GameEvent, GameState, Scene, weekday_of


def system_prompt(state: GameState) -> str:
    """世界観プロンプトはシナリオパック側で定義する。
    使用中のモデル名に応じた出し分け(world_prompt_by_model)に対応。"""
    sc = scenario.for_state(state)
    model = load_config().get("model", "")
    return scenario.world_prompt_for(sc, model)


def style_rules(state: GameState) -> str:
    rules = scenario.for_state(state).get("style_rules", [])
    return "".join(f"- {r}\n" for r in rules)


# ---------------------------------------------------------------- 状態要約


UNDATED_EVENT_TTL = 2  # 期日未定の火種の寿命(作成日からこの日数を過ぎると自然消滅)


def active_events(state: GameState) -> list[GameEvent]:
    return [
        e
        for e in state.events
        if (e.due_day is not None and e.due_day >= state.day)
        or (e.due_day is None and state.day - e.created_day <= UNDATED_EVENT_TTL)
    ]


def resolve_char_id(state: GameState, value) -> str | None:
    """LLMがidの代わりに表示名(漢字・かな)を返しても解決する。"""
    if not value:
        return None
    v = str(value).strip()
    if state.char(v):
        return v
    for c in state.characters:
        if v == c.name or v == c.kana:
            return c.id
    # 「蓮(ren)」のような混在表記にも対応
    for c in state.characters:
        if c.name and c.name in v:
            return c.id
    return None


def summarize_state(
    state: GameState,
    recent_days: int = 2,
    msg_days: int = 1,
    msg_limit: int = 30,
) -> str:
    lines: list[str] = []
    lines.append(f"## 現在: {state.day}日目({weekday_of(state.day)}曜日)")
    lines.append("\n## 登場人物")
    for c in state.characters:
        marker = " ★プレイヤー操作中" if c.id == state.player_id else ""
        lines.append(
            f"- {c.name}({c.id} / {c.gender} / {c.club}){marker}\n"
            f"  性格: {c.personality}\n"
            f"  趣味: {'、'.join(c.hobbies)} / 口調: {c.speech_style}\n"
            f"  秘密(本人のみが知る): {c.secret} / 目標: {c.goal}"
        )
    lines.append("\n## 関係(間柄 / 片想い / 肉体関係回数 / 直近の出来事)")
    for r in state.relationships:
        ca, cb = state.char(r.a), state.char(r.b)
        if not ca or not cb:
            continue
        bits = []
        if r.status:
            bits.append(r.status)
        for cid in r.crush:
            cc = state.char(cid)
            target = cb if cid == r.a else ca
            if cc and target:
                bits.append(f"片想い({cc.name}→{target.name})")
        label = f" [{'/'.join(bits)}]" if bits else ""
        intimacy = f" / 肉体関係{r.intimacy_count}回" if r.intimacy_count else ""
        note = f" — {r.note}" if r.note else ""
        lines.append(f"- {ca.name}⇔{cb.name}{label}{intimacy}{note}")
    active = active_events(state)
    if active:
        lines.append("\n## 予定・約束・くすぶる火種(未消化の伏線)")
        for e in active:
            if e.due_day is not None:
                due = f"{e.due_day}日目({weekday_of(e.due_day)})実行予定"
                if e.due_day == state.day:
                    due += " ←今日!"
            else:
                left = e.created_day + UNDATED_EVENT_TTL - state.day
                due = f"期日未定・あと{left + 1}日で自然消滅"
            lines.append(f"- (id:{e.id}) {e.text} [{due}]")
    recent = state.history[-recent_days:]
    if recent:
        lines.append("\n## 直近の出来事")
        for rec in recent:
            lines.append(f"- {rec.day}日目: {rec.summary}")
    recent_msgs = [m for m in state.messages if m.day >= state.day - msg_days]
    if recent_msgs:
        lines.append("\n## 直近のメッセージアプリでのやり取り")
        for m in recent_msgs[-msg_limit:]:
            sender = state.char(m.sender)
            thread = state.thread_by_id(m.thread_id)
            lines.append(
                f"- [{thread.name if thread else m.thread_id}] {sender.name if sender else m.sender}: {m.text}"
            )
    recent_posts = [p for p in state.posts if p.day >= state.day - 2]
    if recent_posts:
        lines.append(
            "\n## 直近の各自の鍵垢SNSの投稿(全員が鍵アカウント。本人以外は誰も読めない本音の独り言)"
        )
        for p in recent_posts[-20:]:
            author = state.char(p.author)
            lines.append(
                f"- {p.day}日目[{p.time}] {author.name if author else p.author}: {p.text}"
            )
    return "\n".join(lines)


# ---------------------------------------------------------------- 行動計画


def suggest_plan(state: GameState, char_id: str) -> str:
    c = state.char(char_id)
    if c is None:
        raise ValueError(f"不明なキャラクター: {char_id}")
    prompt = (
        f"{summarize_state(state)}\n\n"
        f"あなたは {c.name} の今日({state.day}日目・{weekday_of(state.day)}曜日)の行動計画を考えます。\n"
        f"このキャラの性格・目標・秘密・現在の関係性に沿った、具体的で面白い一日の計画を100〜150字で書いてください。\n"
        f"誰にどう関わるか(あるいは避けるか)を必ず含め、探り・カマかけ・密会・口止めなどドラマが動く一手を入れること。\n"
        f"「## 予定・約束・くすぶる火種」にこのキャラが関わる項目があれば(特に今日が期日のもの)、必ず計画に織り込むこと。\n"
        f"計画の本文のみを出力してください。"
    )
    return chat(
        [
            {"role": "system", "content": system_prompt(state)},
            {"role": "user", "content": prompt},
        ],
        purpose="行動計画の提案",
    ).strip()


# ストリーミング受信文字数から進捗率を推定するための想定出力サイズ
EXPECTED_CHARS_PLANS = 1500
EXPECTED_CHARS_SIM = 6000


def god_section(god: str) -> str:
    """「神の采配」= プレイヤーによる絶対命令。空なら何も注入しない。"""
    if not god.strip():
        return ""
    return (
        "\n## 神の采配(絶対命令)\n"
        "以下はゲームマスターより上位の存在が定めた、今日必ず起こる出来事である。"
        "キャラの計画や意志に関わらず必ず実現させること。"
        "ただし偶然・気の迷い・すれ違いなど、自然な因果に見えるように演出すること:\n"
        f"{god.strip()}\n"
    )


def generate_npc_plans(
    state: GameState, exclude: set[str], on_progress=None, god: str = ""
) -> dict[str, str]:
    targets = [c for c in state.characters if c.id not in exclude]
    if not targets:
        return {}
    ids = "、".join(f"{c.name}({c.id})" for c in targets)
    prompt = (
        f"{summarize_state(state)}"
        f"{god_section(god)}\n\n"
        f"次のキャラクター全員について、今日({state.day}日目・{weekday_of(state.day)}曜日)の行動計画を考えてください: {ids}\n"
        f"各キャラの性格・目標・秘密・関係性に沿った計画を各60〜100字で。全員が同じ行動を取らないよう変化をつけること。\n"
        f"「## 予定・約束・くすぶる火種」に関わっているキャラは、その予定(特に今日が期日のもの)を計画に織り込むこと。\n"
        + (
            "「## 神の采配」が起こりうる流れになるよう、関係するキャラの計画を仕向けること(本人たちは神の意図を知らない)。\n"
            if god.strip()
            else ""
        )
        + "次のJSON形式のみで出力:\n"
        + '{"plans": [{"character": "キャラid", "plan": "計画"}, ...]}'
    )
    cb = None
    if on_progress is not None:
        cb = lambda n: on_progress(min(1.0, n / EXPECTED_CHARS_PLANS))  # noqa: E731
    data = chat_json(
        [
            {"role": "system", "content": system_prompt(state)},
            {"role": "user", "content": prompt},
        ],
        on_progress=cb,
        purpose="NPC行動計画の生成",
    )
    plans: dict[str, str] = {}
    for item in data.get("plans", []):
        cid = resolve_char_id(state, item.get("character", ""))
        if cid and cid not in exclude:
            plans[cid] = str(item.get("plan", "")).strip()
    # LLMが漏らしたキャラには無難な計画を入れる
    for c in targets:
        plans.setdefault(c.id, "いつも通りに過ごす。")
    return plans


# ---------------------------------------------------------------- 一日の実行

SIMULATE_FORMAT = """次のJSON形式のみで出力してください:
{
  "scenes": [
    {"time": "場面の時点の自由な表記(例: 朝練後、昼休み、稽古終わり、終電前、深夜2時)", "title": "場面タイトル", "participants": ["キャラid"], "main": "この場面の主役=視点人物のキャラid", "summary": "何が起きたかの要約(1〜2文・50字程度)", "novel": "600〜900字の短編小説。三人称で、mainの内面・情景・セリフを織り交ぜ、各キャラの口調を守る。"}
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
    {"text": "今日生まれた後日の約束・予告・企み(例: 次に全員が集まる日に、握っている秘密を突きつけると予告)", "due_day": 実行予定の絶対日数の整数(可能な限り付ける。nullは本当に日付が決められないものだけ), "chars": ["関係するキャラid"]}
  ],
  "resolved_event_ids": [今日のシーンやメッセージで実行・消化した予定のid(整数)],
  "day_summary": "この日全体の要約(100字程度)"
}"""

SIMULATE_RULES = (
    "ルール:\n"
    "- scenesは時間帯の割り当てに縛られず、この日に起きた出来事のうち特筆すべきものだけを2〜4つ選んで時系列順に書くこと。"
    "同じ時間帯に2場面あっても、何も起きない時間帯があってもよい。timeは「朝練後」「終電前」のような自由な表記でよい。"
    "場面に選ばれなかったキャラの動きは messages や relationship_changes で表現する。\n"
    "- novelは一つの場面を腰を据えて深く描く短編。視点人物を一人決め、その内面に潜ること。"
    "要約の繰り返しではなく、空気・間・言えなかった一言を書く。数を増やすより一場面を濃く書くことを優先する。\n"
    "- 各キャラは自分の行動計画に沿って動くが、計画通りにいかない偶発事——目撃、鉢合わせ、スマホの見間違い、口の滑り——を必ず1つ以上起こすこと。\n"
    "- 誰かの秘密は毎日少しずつ漏れる。ただし一気に暴かない。疑念や違和感を積み上げ、爆発(修羅場)は溜まり切ったときだけ。\n"
    "- relationship_changesは実際に描写した出来事に基づくものだけ。3〜6件程度。\n"
    "- 2人が肉体関係を持った日は、そのペアの relationship_changes に slept:true を必ず付けること。"
    "sleptは実際に性行為があった場合のみ。友人同士の添い寝・お泊まり・相談のための宿泊はsleptにしないこと。\n"
    "- messagesやシーン外で密会・お泊まりを示唆した場合も、実際に関係を持ったのなら必ず slept:true を記録すること。"
    "シーンに描かれなかった出来事でも、起きたことは構造データに残す。"
    "逆に何も起きなかったのなら、それと分かる描写やメッセージを残し、宙ぶらりんにしないこと。\n"
    "- statusの変更(交際開始・婚約・破局など)や crush_add/crush_remove(片想いの発生・終わり)は、"
    "流れがそれに見合うときだけ。statusは列挙された値以外を発明しないこと。"
    "関係の細かい質感(秘密の交際、独占欲、気まずさ等)はreasonに書けば記録される。\n"
    "- messagesはその日の出来事を受けたやり取りを8〜15件。全体のグループチャット(thread=group)と、"
    "個人間のDM(thread=dm、membersに2人指定)を織り交ぜる。DMでは密会の約束・嘘・本音・送信先間違いが起こりうる。"
    "グループでは平和を装い、DMで裏が動く、の温度差を大切に。\n"
    "- postsは各自の鍵垢SNSへの投稿を4〜8件。全員が鍵アカウントで相互フォローもなく、誰にも読まれない前提の独り言である。"
    "人目を気にする必要がないので、日常・近況に混じって、愚痴・恨みつらみ・嫉妬・浮かれ・罪悪感・"
    "本人すら認めたくない本音が、名指しも遠慮もなくそのまま書かれる。"
    "表のグループチャットで装った平和と、鍵垢に吐き出される本音の温度差こそが醍醐味。"
    "その日の出来事で心が動いた人ほど書く。互いの鍵垢は見えないため、投稿への反応や言及は起こらない。"
    "全員が毎日投稿する必要はない。書かずに溜め込む人がいるのも自然。\n"
    "- 既存の関係にないキャラ同士の新しい絡みも歓迎(新しい関係エッジは relationship_changes に含めれば自動で作られる)。\n"
    "- 「## 予定・約束」に挙がっている項目のうち due が今日のものは、必ず今日のシーンかメッセージで実行・消化し、"
    "そのidを resolved_event_ids に入れること。期日未定の火種も、機が熟したら拾って消化してよい。\n"
    "- 今日のやり取りで生まれた「後日の約束・予告・企み」は new_events に登録すること(本当に物語を動かすものだけ、0〜2件)。\n"
    "- messages欄で誤爆・暴露・口論などの重大事件を起こした場合は、それを new_events にも登録して後日まで尾を引かせること"
    "(例:「グループへの誤爆がまだ収拾がついていない」)。"
    "できる限り具体的な due_day を付けること。期日未定の火種は2日で自然消滅するので、"
    "残したい火種は消える前に具体的な予定(due_day付き)へ発展させるか、消化すること。"
)


def simulate_day(
    state: GameState, plans: dict[str, str], on_progress=None, god: str = ""
) -> DayRecord:
    plan_lines = []
    for cid, plan in plans.items():
        c = state.char(cid)
        if c:
            plan_lines.append(f"- {c.name}({cid}): {plan}")
    prompt = (
        f"{summarize_state(state)}"
        f"{god_section(god)}\n\n"
        f"## 今日({state.day}日目・{weekday_of(state.day)}曜日)の各自の行動計画\n"
        + "\n".join(plan_lines)
        + f"\n\nこの一日をシミュレートしてください。\n{SIMULATE_RULES}\n"
        + (
            "- 「## 神の采配」の内容は今日必ず起こす。シーン・messages・relationship_changesに確実に反映すること。\n"
            if god.strip()
            else ""
        )
        + style_rules(state)
        + "- JSON内のキャラ指定(participants/main/a/b/sender/members)には必ず英字idのみを使い、名前を書かないこと: "
        + "、".join(f"{c.id}={c.name}" for c in state.characters)
        + f"\n\n{SIMULATE_FORMAT}"
    )
    cb = None
    if on_progress is not None:
        cb = lambda n: on_progress(min(1.0, n / EXPECTED_CHARS_SIM))  # noqa: E731
    data = chat_json(
        [
            {"role": "system", "content": system_prompt(state)},
            {"role": "user", "content": prompt},
        ],
        on_progress=cb,
        purpose="一日のシミュレーション",
    )

    record = DayRecord(
        day=state.day,
        weekday=weekday_of(state.day),
        plans=plans,
        god_note=god.strip(),
    )

    for s in data.get("scenes", []):
        participants = [
            rid
            for rid in (resolve_char_id(state, p) for p in s.get("participants", []))
            if rid
        ]
        main = resolve_char_id(state, s.get("main", "")) or ""
        if not main:
            main = participants[0] if participants else ""
        record.scenes.append(
            Scene(
                time=str(s.get("time", "")),
                title=str(s.get("title", "")),
                participants=participants,
                main=main,
                summary=str(s.get("summary", "")),
                narrative=str(s.get("novel") or s.get("narrative", "")),
            )
        )

    for ch in data.get("relationship_changes", []):
        a = resolve_char_id(state, ch.get("a"))
        b = resolve_char_id(state, ch.get("b"))
        if not (a and b) or a == b:
            continue
        rel = state.ensure_rel(a, b)
        status = str(ch.get("status") or "").strip()
        if status:
            rel.status = "" if status in ("解消", "なし") else status
        crush_add: list[str] = []
        for raw in ch.get("crush_add", []) or []:
            cid = resolve_char_id(state, raw)
            if cid in (a, b) and cid not in rel.crush:
                rel.crush.append(cid)
                crush_add.append(cid)
        crush_remove: list[str] = []
        for raw in ch.get("crush_remove", []) or []:
            cid = resolve_char_id(state, raw)
            if cid in rel.crush:
                rel.crush.remove(cid)
                crush_remove.append(cid)
        slept = bool(ch.get("slept"))
        if slept:
            rel.intimacy_count += 1
        reason = str(ch.get("reason", ""))
        if reason:
            rel.note = reason
        record.relationship_changes.append(
            {
                "a": a,
                "b": b,
                "reason": reason,
                "status": status,
                "crush_add": crush_add,
                "crush_remove": crush_remove,
                "slept": slept,
            }
        )

    group_thread = next((t for t in state.threads if t.kind == "group"), None)
    for m in data.get("messages", []):
        sender = resolve_char_id(state, m.get("sender"))
        if not sender:
            continue
        text = str(m.get("text", "")).strip()
        if not text:
            continue
        time = str(m.get("time", "夜"))
        if m.get("thread") == "group":
            if group_thread:
                state.add_message(group_thread.id, sender, text, time)
        else:
            members = [
                rid
                for rid in (resolve_char_id(state, p) for p in (m.get("members") or []))
                if rid
            ]
            if sender not in members:
                members.append(sender)
            if len(members) != 2:
                continue
            thread = state.ensure_dm(members[0], members[1])
            state.add_message(thread.id, sender, text, time)

    for p in data.get("posts", []) or []:
        author = resolve_char_id(state, p.get("author"))
        text = str(p.get("text", "")).strip()
        if not author or not text:
            continue
        state.add_post(author, text, str(p.get("time", "夜")))

    # 予定・伏線の消化と登録
    resolved: set[int] = set()
    for i in data.get("resolved_event_ids", []) or []:
        try:
            resolved.add(int(i))
        except (TypeError, ValueError):
            continue
    state.events = [e for e in state.events if e.id not in resolved]
    for ev in data.get("new_events", []) or []:
        text = str(ev.get("text", "")).strip()
        if not text:
            continue
        due = ev.get("due_day")
        try:
            due = int(due) if due is not None else None
        except (TypeError, ValueError):
            due = None
        chars = [
            rid
            for rid in (resolve_char_id(state, c) for c in ev.get("chars", []) or [])
            if rid
        ]
        state.events.append(
            GameEvent(
                id=state.next_event_id,
                text=text,
                created_day=state.day,
                due_day=due,
                chars=chars,
            )
        )
        state.next_event_id += 1

    record.summary = str(data.get("day_summary", ""))
    state.history.append(record)
    state.day += 1
    # 期日切れの予定と、TTLを過ぎた期日未定の火種を捨てる
    state.events = active_events(state)
    undated = [e for e in state.events if e.due_day is None]
    if len(undated) > 8:  # 念のための上限
        drop = {e.id for e in undated[: len(undated) - 8]}
        state.events = [e for e in state.events if e.id not in drop]
    state.pending_plans = {}
    return record


# ---------------------------------------------------------------- 終幕(プレイ終了の総括)

EXPECTED_CHARS_FINALE = 6000

FINALE_FORMAT = """次のJSON形式のみで出力してください:
{
  "title": "シーズンタイトル(物語の内容を踏まえた印象的な題)",
  "tagline": "一行キャッチコピー",
  "overall": "シーズン全体の総括(600〜900字。誰が何を隠し、どこから綻び、関係がどう動いたかを物語として振り返る)",
  "highlights": [{"day": 日数の整数, "text": "名場面の振り返り(50字程度)"}],
  "awards": [{"name": "賞の名前(例: 最優秀二股賞)", "character": "キャラid", "reason": "授賞理由(ユーモアと毒を込めて50字程度)"}],
  "comments": [{"character": "キャラid", "text": "本人コメント(150〜250字、口調厳守)"}]
}"""


def full_dossier(state: GameState) -> str:
    """終幕用: 隠し事も含めた全記録(全DM・全関係・全サマリ)。"""
    lines: list[str] = [f"## プレイ期間: 1日目〜{state.day - 1}日目"]
    lines.append("\n## 登場人物(全員の秘密・目標を含む)")
    for c in state.characters:
        lines.append(
            f"- {c.name}({c.id} / {c.gender} / {c.club})\n"
            f"  性格: {c.personality} / 口調: {c.speech_style}\n"
            f"  秘密: {c.secret} / 目標: {c.goal}"
        )
    lines.append("\n## 最終的な関係(間柄 / 片想い / 肉体関係の累計回数 / 直近の出来事)")
    for r in state.relationships:
        ca, cb = state.char(r.a), state.char(r.b)
        if not ca or not cb:
            continue
        bits = []
        if r.status:
            bits.append(r.status)
        for cid in r.crush:
            cc = state.char(cid)
            target = cb if cid == r.a else ca
            if cc and target:
                bits.append(f"片想い({cc.name}→{target.name})")
        label = f" [{'/'.join(bits)}]" if bits else ""
        intimacy = f" / 肉体関係{r.intimacy_count}回" if r.intimacy_count else ""
        note = f" — {r.note}" if r.note else ""
        lines.append(f"- {ca.name}⇔{cb.name}{label}{intimacy}{note}")
    if state.history:
        lines.append("\n## 日々の記録")
        for rec in state.history:
            lines.append(f"- {rec.day}日目({rec.weekday}): {rec.summary}")
    lines.append("\n## 裏でのやり取り(各DMの全ログ ※直近40件まで)")
    for t in state.threads:
        if t.kind != "dm":
            continue
        msgs = [m for m in state.messages if m.thread_id == t.id][-40:]
        if not msgs:
            continue
        lines.append(f"### {t.name}")
        for m in msgs:
            c = state.char(m.sender)
            lines.append(f"  {m.day}日目 {c.name if c else m.sender}: {m.text}")
    group_ids = {t.id for t in state.threads if t.kind == "group"}
    group = [m for m in state.messages if m.thread_id in group_ids][-30:]
    if group:
        lines.append("\n## グループチャット(直近30件)")
        for m in group:
            c = state.char(m.sender)
            lines.append(f"  {m.day}日目 {c.name if c else m.sender}: {m.text}")
    posts = state.posts[-40:]
    if posts:
        lines.append(
            "\n## 全員の鍵垢SNSの投稿(直近40件。誰にも見せるつもりのなかった本音の記録)"
        )
        for p in posts:
            c = state.char(p.author)
            lines.append(f"  {p.day}日目 {c.name if c else p.author}: {p.text}")
    return "\n".join(lines)


def generate_finale(state: GameState, on_progress=None) -> dict:
    prompt = (
        f"{full_dossier(state)}\n\n"
        "プレイが終了しました。シーズン総括を作ってください。\n"
        + scenario.for_state(state)["finale_prompt"]
        + "\n"
        "ルール:\n"
        "- overallは物語として面白く、しかし事実に忠実に。\n"
        "- highlightsは5〜8件、実際にあった出来事から選ぶこと。\n"
        "- awardsは3〜5件。ユーモアと毒を込めるが、事実に基づくこと。\n"
        "- commentsは全員分を必ず出すこと。各自が「初めて知って」最も衝撃を受けたはずの事実への反応を含め、"
        "怒り・動揺・開き直り・安堵など、その人の性格と口調に忠実に。修羅場上等。\n"
        "- キャラ指定は必ず英字id: "
        + "、".join(f"{c.id}={c.name}" for c in state.characters)
        + "\n\n"
        f"{FINALE_FORMAT}"
    )
    cb = None
    if on_progress is not None:
        cb = lambda n: on_progress(min(1.0, n / EXPECTED_CHARS_FINALE))  # noqa: E731
    data = chat_json(
        [
            {"role": "system", "content": system_prompt(state)},
            {"role": "user", "content": prompt},
        ],
        on_progress=cb,
        purpose="終幕の総括",
    )
    comments = []
    for cm in data.get("comments", []) or []:
        cid = resolve_char_id(state, cm.get("character"))
        text = str(cm.get("text", "")).strip()
        if cid and text:
            comments.append({"character": cid, "text": text})
    awards = []
    for aw in data.get("awards", []) or []:
        cid = resolve_char_id(state, aw.get("character"))
        if cid and aw.get("name"):
            awards.append(
                {
                    "name": str(aw["name"]),
                    "character": cid,
                    "reason": str(aw.get("reason", "")),
                }
            )
    return {
        "title": str(data.get("title", "シーズン総括")),
        "tagline": str(data.get("tagline", "")),
        "overall": str(data.get("overall", "")),
        "highlights": [
            {"day": h.get("day"), "text": str(h.get("text", ""))}
            for h in (data.get("highlights") or [])
            if h.get("text")
        ],
        "awards": awards,
        "comments": comments,
        "generated_on_day": state.day,
    }


# ---------------------------------------------------------------- チャット介入


def npc_replies(state: GameState, thread_id: str, player_text: str) -> list[dict]:
    thread = state.thread_by_id(thread_id)
    player = state.char(state.player_id)
    if thread is None or player is None:
        return []
    others = [cid for cid in thread.members if cid != state.player_id]
    if not others:
        return []
    history = [m for m in state.messages if m.thread_id == thread_id][-25:]
    hist_lines = []
    for m in history:
        c = state.char(m.sender)
        hist_lines.append(f"{c.name if c else m.sender}: {m.text}")
    names = "、".join(f"{c.name}({c.id})" for c in map(state.char, others) if c)
    prompt = (
        # チャット返信では記憶の穴を防ぐため、メッセージ窓を広めに取る
        f"{summarize_state(state, msg_days=2, msg_limit=60)}\n\n"
        f"## メッセージアプリ「{thread.name}」の直近ログ\n"
        + "\n".join(hist_lines)
        + "\n\n"
        f"たった今、{player.name} がこう送信しました: 「{player_text}」\n\n"
        f"このスレッドの他の参加者({names})のうち、返信しそうな人だけが返信します(0〜3件)。\n"
        f"既読スルーが自然なら空配列でも構いません。各自の口調・関係性・時間帯を守ること。\n"
        f"senderには必ず英字id(括弧内のid)を使うこと。\n"
        f'次のJSON形式のみで出力: {{"replies": [{{"sender": "キャラid", "text": "本文"}}]}}'
    )
    data = chat_json(
        [
            {"role": "system", "content": system_prompt(state)},
            {"role": "user", "content": prompt},
        ],
        purpose="チャット返信の生成",
    )
    replies = []
    for r in data.get("replies", [])[:3]:
        cid = resolve_char_id(state, r.get("sender"))
        text = str(r.get("text", "")).strip()
        if cid and cid in others and text:
            replies.append({"sender": cid, "text": text})
    return replies
