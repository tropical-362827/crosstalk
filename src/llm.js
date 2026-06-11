// LLM 呼び出しの薄いラッパー。ブラウザから直接 API を叩く(キーは localStorage のみ)。
// プロバイダはモデル名で振り分ける:
//   claude-*      → Anthropic SDK(プロンプトキャッシュ対応)
//   xai/<model>   → xAI(OpenAI互換, https://api.x.ai/v1)   例: xai/grok-4.3
//   openai/<model>→ OpenAI(https://api.openai.com/v1)        例: openai/gpt-4o

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { logLlmCall } from "./state.js";

const SETTINGS_KEY = "crosstalk_settings";
export const DEFAULT_MODEL = "claude-opus-4-6";
export const MODEL_SUGGESTIONS = [
  "claude-opus-4-6",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "xai/grok-4.3",
  "openai/gpt-5.3-chat-latest",
];

// モデル名 → プロバイダ情報。keyField は settings 内の保存キー名
function providerOf(model) {
  if (model.startsWith("xai/"))
    return {
      provider: "xai",
      label: "xAI",
      baseURL: "https://api.x.ai/v1",
      apiModel: model.slice(4),
      keyField: "xaiKey",
      tokenField: "max_tokens",
    };
  if (model.startsWith("openai/"))
    return {
      provider: "openai",
      label: "OpenAI",
      baseURL: "https://api.openai.com/v1",
      apiModel: model.slice(7),
      keyField: "openaiKey",
      tokenField: "max_completion_tokens",
    };
  return { provider: "anthropic", label: "Anthropic", apiModel: model, keyField: "apiKey" };
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// 現在選択中のモデルのプロバイダに対応するキーが入っているか
export const hasApiKey = () => {
  const s = loadSettings();
  const { keyField } = providerOf(s.model || DEFAULT_MODEL);
  return Boolean(s[keyField]);
};

// --- コスト見積もり(USD / 1Mトークン。概算) ---
// Anthropic: キャッシュ書き込み1.25倍 / 読み出し0.1倍。OpenAI/xAI はキャッシュ読み出しを0.1倍で近似
const PRICING = [
  { match: /^claude-(fable|mythos)-5/, input: 10, output: 50 },
  { match: /^claude-opus-4/, input: 5, output: 25 },
  { match: /^claude-sonnet-4/, input: 3, output: 15 },
  { match: /^claude-haiku-4/, input: 1, output: 5 },
  { match: /^openai\/gpt-5.*mini/, input: 0.25, output: 2 },
  { match: /^openai\/gpt-5/, input: 1.25, output: 10 },
  { match: /^openai\/gpt-4o-mini/, input: 0.15, output: 0.6 },
  { match: /^openai\/gpt-4o/, input: 2.5, output: 10 },
  { match: /^openai\//, input: 2.5, output: 10 },
  { match: /^xai\/grok/, input: 3, output: 15 },
  { match: /^xai\//, input: 3, output: 15 },
];

export function estimateCost(model, usage) {
  if (!usage) return null;
  const p = PRICING.find((x) => x.match.test(model));
  if (!p) return null;
  const M = 1e6;
  return (
    ((usage.prompt_tokens || 0) * p.input) / M +
    ((usage.cache_creation || 0) * p.input * 1.25) / M +
    ((usage.cache_read || 0) * p.input * 0.1) / M +
    ((usage.completion_tokens || 0) * p.output) / M
  );
}

// --- 累計コスト(localStorage。セーブとは独立した観測記録) ---
const COST_KEY = "crosstalk_cost_total";

export function readCostTotals() {
  try {
    return JSON.parse(localStorage.getItem(COST_KEY) || "{}");
  } catch {
    return {};
  }
}

export function resetCostTotals() {
  localStorage.removeItem(COST_KEY);
}

function addToTotals(cost, usage) {
  try {
    const t = readCostTotals();
    t.usd = (t.usd || 0) + (cost || 0);
    t.calls = (t.calls || 0) + 1;
    t.in =
      (t.in || 0) +
      (usage?.prompt_tokens || 0) +
      (usage?.cache_read || 0) +
      (usage?.cache_creation || 0);
    t.out = (t.out || 0) + (usage?.completion_tokens || 0);
    localStorage.setItem(COST_KEY, JSON.stringify(t));
  } catch {}
}

const MAX_OUTPUT = 16000;

// Anthropic 経路: system はキャッシュ用ブロック、content はブロック配列のまま渡す
async function streamAnthropic({ messages, temperature, onProgress, model }) {
  const { apiKey } = loadSettings();
  if (!apiKey) throw new Error("Anthropic APIキーが未設定です。⚙設定から入力してください");
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const params = {
    model,
    max_tokens: MAX_OUTPUT,
    system: systemText
      ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
      : undefined,
    messages: rest,
  };
  if (temperature != null) params.temperature = temperature;
  const anth = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const stream = anth.messages.stream(params);
  let total = 0;
  if (onProgress)
    stream.on("text", (d) => {
      total += d.length;
      onProgress(total);
    });
  const final = await stream.finalMessage();
  const text = final.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const u = final.usage;
  return {
    text,
    usage: u
      ? {
          prompt_tokens: u.input_tokens,
          completion_tokens: u.output_tokens,
          cache_read: u.cache_read_input_tokens ?? 0,
          cache_creation: u.cache_creation_input_tokens ?? 0,
        }
      : null,
    stop_reason: final.stop_reason || null,
  };
}

// OpenAI 互換経路(OpenAI / xAI)。Anthropic 形式のメッセージを平文に畳んで渡す
async function streamOpenAICompat({ messages, temperature, onProgress, info }) {
  const apiKey = loadSettings()[info.keyField];
  if (!apiKey) throw new Error(`${info.label} APIキーが未設定です。⚙設定から入力してください`);
  // content がブロック配列(cache_control付き)のことがあるので text を連結して文字列化
  const msgs = messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : (m.content || [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(""),
  }));
  const params = {
    model: info.apiModel,
    messages: msgs,
    stream: true,
    stream_options: { include_usage: true },
  };
  params[info.tokenField] = MAX_OUTPUT;
  if (temperature != null) params.temperature = temperature;
  const oai = new OpenAI({ apiKey, baseURL: info.baseURL, dangerouslyAllowBrowser: true });
  const stream = await oai.chat.completions.create(params);
  let text = "",
    total = 0,
    usage = null,
    finish = null;
  for await (const chunk of stream) {
    const ch = chunk.choices?.[0];
    const delta = ch?.delta?.content || "";
    if (delta) {
      text += delta;
      if (onProgress) {
        total += delta.length;
        onProgress(total);
      }
    }
    if (ch?.finish_reason) finish = ch.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  let mapped = null;
  if (usage) {
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    mapped = {
      prompt_tokens: (usage.prompt_tokens || 0) - cached,
      completion_tokens: usage.completion_tokens || 0,
      cache_read: cached,
      cache_creation: 0,
    };
  }
  return { text, usage: mapped, stop_reason: finish === "length" ? "max_tokens" : finish };
}

export async function chat(
  messages,
  { temperature = null, onProgress = null, purpose = "chat" } = {}
) {
  const model = loadSettings().model || DEFAULT_MODEL;
  const info = providerOf(model);
  const temp = temperature == null ? 0.9 : temperature;
  const callOnce = (useTemp) =>
    info.provider === "anthropic"
      ? streamAnthropic({ messages, temperature: useTemp, onProgress, model })
      : streamOpenAICompat({ messages, temperature: useTemp, onProgress, info });
  const started = Date.now();
  try {
    let result;
    try {
      result = await callOnce(temp);
    } catch (e) {
      // temperature を受け付けないモデル(o系など)は外して1回だけリトライ
      if (String(e).toLowerCase().includes("temperature")) result = await callOnce(null);
      else throw e;
    }
    const usage = result.usage;
    const cost = estimateCost(model, usage);
    if (usage) addToTotals(cost, usage);
    if (result.stop_reason === "max_tokens") {
      console.warn(
        `[${purpose}] 出力が上限(${MAX_OUTPUT})で打ち切られました。` +
          "応答が途中で切れている可能性があります(JSONなら壊れます)。"
      );
    }
    logLlmCall({
      purpose,
      model,
      duration_sec: Math.round((Date.now() - started) / 100) / 10,
      usage,
      cost_usd: cost,
      stop_reason: result.stop_reason,
      messages,
      response: result.text,
    });
    return result.text;
  } catch (e) {
    logLlmCall({
      purpose,
      model,
      duration_sec: Math.round((Date.now() - started) / 100) / 10,
      usage: null,
      messages,
      response: "",
      error: String(e),
    });
    throw e;
  }
}

export function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`JSONが見つかりません: ${cleaned.slice(0, 200)}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function chatJson(messages, opts = {}) {
  const purpose = opts.purpose || "chat_json";
  const raw = await chat(messages, { ...opts, purpose });
  try {
    return extractJson(raw);
  } catch {
    const retry = [
      ...messages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content:
          "出力がJSONとして解析できませんでした。説明文やコードフェンスを付けず、有効なJSONオブジェクトのみを出力し直してください。",
      },
    ];
    return extractJson(
      await chat(retry, {
        temperature: 0.2,
        purpose: `${purpose}(JSON修正リトライ)`,
      })
    );
  }
}
