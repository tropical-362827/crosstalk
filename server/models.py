"""ゲーム状態のデータモデル。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Character(BaseModel):
    id: str
    name: str
    kana: str = ""
    gender: str = ""
    club: str = ""
    personality: str = ""
    hobbies: list[str] = Field(default_factory=list)
    speech_style: str = ""
    secret: str = ""
    goal: str = ""
    color: str = "#8899aa"


class Relationship(BaseModel):
    a: str
    b: str
    status: str = ""  # 公式な間柄。"" | 交際 | 元恋人 | 敵意(LLMは列挙から選ぶ)
    crush: list[str] = Field(default_factory=list)  # 片想いしている側のキャラid(両片想いは2人)
    note: str = ""  # 関係の質感・直近の出来事(自由記述はここに集約)
    intimacy_count: int = 0  # 肉体関係の累計回数

    def involves(self, char_id: str) -> bool:
        return char_id in (self.a, self.b)


class Thread(BaseModel):
    id: str
    name: str
    kind: str = "dm"  # "group" | "dm"
    members: list[str] = Field(default_factory=list)


class Message(BaseModel):
    id: int
    thread_id: str
    sender: str
    text: str
    day: int
    time: str = "夜"


class Post(BaseModel):
    """鍵垢SNSへの投稿。全員が鍵アカウントで誰にも読まれないため、本音がそのまま書かれる。"""

    id: int
    author: str
    text: str
    day: int
    time: str = "夜"


class Scene(BaseModel):
    time: str
    title: str
    participants: list[str] = Field(default_factory=list)
    main: str = ""  # この場面の主役(視点人物)のキャラid
    summary: str = ""  # 一覧に出す1〜2文の要約
    narrative: str  # クリックで開く短編小説本文


class GameEvent(BaseModel):
    """先の予定・約束・くすぶる伏線。消化されるまで毎日LLMに提示される。"""

    id: int
    text: str
    created_day: int
    due_day: int | None = None  # 実行予定日(絶対日数)。Noneは期日未定の火種
    chars: list[str] = Field(default_factory=list)


class DayRecord(BaseModel):
    day: int
    weekday: str
    plans: dict[str, str] = Field(default_factory=dict)
    god_note: str = ""  # この日に適用された「神の采配」(チート指示)
    scenes: list[Scene] = Field(default_factory=list)
    summary: str = ""
    relationship_changes: list[dict] = Field(default_factory=list)


class GameState(BaseModel):
    scenario: str = "loveall"  # このセーブが属するシナリオパックのid
    day: int = 1
    player_id: str = ""
    characters: list[Character] = Field(default_factory=list)
    relationships: list[Relationship] = Field(default_factory=list)
    threads: list[Thread] = Field(default_factory=list)
    messages: list[Message] = Field(default_factory=list)
    posts: list[Post] = Field(default_factory=list)
    history: list[DayRecord] = Field(default_factory=list)
    pending_plans: dict[str, str] = Field(default_factory=dict)
    events: list[GameEvent] = Field(default_factory=list)
    next_event_id: int = 1
    next_message_id: int = 1
    next_post_id: int = 1
    finale: dict | None = None  # プレイ終了時の総括(生成結果を保存)

    # --- helpers -------------------------------------------------
    def char(self, char_id: str) -> Character | None:
        return next((c for c in self.characters if c.id == char_id), None)

    def rel(self, a: str, b: str) -> Relationship | None:
        for r in self.relationships:
            if {r.a, r.b} == {a, b}:
                return r
        return None

    def ensure_rel(self, a: str, b: str) -> Relationship:
        r = self.rel(a, b)
        if r is None:
            r = Relationship(a=a, b=b)
            self.relationships.append(r)
        return r

    def thread_by_id(self, thread_id: str) -> Thread | None:
        return next((t for t in self.threads if t.id == thread_id), None)

    def ensure_dm(self, a: str, b: str) -> Thread:
        key = "dm:" + "-".join(sorted([a, b]))
        t = self.thread_by_id(key)
        if t is None:
            ca, cb = self.char(a), self.char(b)
            name = f"{ca.name if ca else a} / {cb.name if cb else b}"
            t = Thread(id=key, name=name, kind="dm", members=sorted([a, b]))
            self.threads.append(t)
        return t

    def add_message(
        self, thread_id: str, sender: str, text: str, time: str = "夜"
    ) -> Message:
        msg = Message(
            id=self.next_message_id,
            thread_id=thread_id,
            sender=sender,
            text=text,
            day=self.day,
            time=time,
        )
        self.next_message_id += 1
        self.messages.append(msg)
        return msg

    def add_post(self, author: str, text: str, time: str = "夜") -> Post:
        post = Post(
            id=self.next_post_id,
            author=author,
            text=text,
            day=self.day,
            time=time,
        )
        self.next_post_id += 1
        self.posts.append(post)
        return post


WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"]


def weekday_of(day: int) -> str:
    return WEEKDAYS[(day - 1) % 7]
