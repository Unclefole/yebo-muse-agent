// Meta Muse Spark client: Chat Completions with tool calling, image/PDF input and
// structured output. Base URL and model come from .env so they can be changed without
// code edits.
//
// Shapes checked against the official Meta Model API docs (dev.meta.ai/docs) on
// 2026-10-26: base URL https://api.meta.ai/v1, Bearer auth, POST /chat/completions,
// image parts { type: "image_url", image_url: { url } }, file parts
// { type: "file", file: { filename, file_data } }, and
// response_format { type: "json_schema", json_schema: { name, strict, schema } }.

export const DEFAULT_MODEL = "muse-spark-1.3"; // the docs' recommended Muse Spark for new work

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type Tool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type JsonSchemaFormat = {
  type: "json_schema";
  json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
};

export function model(): string {
  return process.env.META_MODEL || DEFAULT_MODEL;
}

// Which model drives the agent's planning and tool calls ("the brain").
//   muse-spark       Muse Spark on the Meta Model API (META_API_KEY), the default
//   muse-spark-open  Muse Spark Open, Meta's open-weight release, served by Baseten
//                    (BASETEN_API_KEY). Checked against dev.meta.ai/docs/muse-spark-open
//                    and docs.baseten.co on 2026-10-26: OpenAI-compatible
//                    https://inference.baseten.co/v1, Authorization: Bearer, model
//                    "meta-models/muse-spark-open", tool calling supported, structured
//                    output NOT supported, recommended temperature 1.0 and top_p 1.0.
// Invoice reading and the hidden-request audit use strict JSON schemas, so they always run
// on Muse Spark through the Meta Model API.
export type Brain = "muse-spark" | "muse-spark-open";

export const OPEN_DEFAULT_MODEL = "meta-models/muse-spark-open";

type Endpoint = { base: string; key: string | undefined; keyName: string; model: string; label: string; extra: Record<string, unknown> };

export function endpoint(brain: Brain = "muse-spark"): Endpoint {
  if (brain === "muse-spark-open") {
    const effort = process.env.MUSE_SPARK_OPEN_REASONING_EFFORT || "medium"; // docs' default is xhigh (slow)
    return {
      base: process.env.BASETEN_API_BASE || "https://inference.baseten.co/v1",
      key: process.env.BASETEN_API_KEY,
      keyName: "BASETEN_API_KEY",
      model: process.env.MUSE_SPARK_OPEN_MODEL || OPEN_DEFAULT_MODEL,
      label: "Muse Spark Open (open weights, via Baseten)",
      extra: { temperature: 1.0, top_p: 1.0, ...(effort === "default" ? {} : { reasoning_effort: effort }) },
    };
  }
  return {
    base: process.env.META_API_BASE || "https://api.meta.ai/v1",
    key: process.env.META_API_KEY,
    keyName: "META_API_KEY",
    model: model(),
    label: "Muse Spark (Meta Model API)",
    extra: {},
  };
}

export function openAvailable(): boolean {
  return !!process.env.BASETEN_API_KEY;
}

async function complete(body: Record<string, unknown>, brain: Brain = "muse-spark"): Promise<Message> {
  const ep = endpoint(brain);
  if (!ep.key) throw new Error(`${ep.keyName} is not set`);
  const who = brain === "muse-spark-open" ? "Baseten (Muse Spark Open)" : "Meta API";
  const send = (payload: Record<string, unknown>) =>
    fetch(`${ep.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.key}` },
      body: JSON.stringify(payload),
    });
  const payload = { model: ep.model, ...ep.extra, ...body };
  let res = await send(payload);
  // If the provider does not accept reasoning_effort, retry once without it.
  if (res.status === 400 && "reasoning_effort" in payload) {
    const text = await res.text();
    if (!/reasoning/i.test(text)) throw new Error(`${who} 400: ${text}`);
    const { reasoning_effort: _dropped, ...rest } = payload;
    res = await send(rest);
  }
  if (!res.ok) throw new Error(`${who} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error(`${who} returned no message`);
  return message as Message;
}

export async function chat(messages: Message[], tools: Tool[], brain: Brain = "muse-spark"): Promise<Message> {
  return complete({ messages, tools, tool_choice: "auto" }, brain);
}

// One structured answer, constrained to `format`. Returns the raw JSON text.
export async function structured(messages: Message[], format: JsonSchemaFormat): Promise<string> {
  const message = await complete({ messages, response_format: format });
  if (typeof message.content !== "string") throw new Error("Meta API returned no structured content");
  return message.content;
}
