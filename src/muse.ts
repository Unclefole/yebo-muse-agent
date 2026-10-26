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

async function complete(body: Record<string, unknown>): Promise<Message> {
  const base = process.env.META_API_BASE || "https://api.meta.ai/v1";
  const key = process.env.META_API_KEY;
  if (!key) throw new Error("META_API_KEY is not set");

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: model(), ...body }),
  });
  if (!res.ok) throw new Error(`Meta API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error("Meta API returned no message");
  return message as Message;
}

export async function chat(messages: Message[], tools: Tool[]): Promise<Message> {
  return complete({ messages, tools, tool_choice: "auto" });
}

// One structured answer, constrained to `format`. Returns the raw JSON text.
export async function structured(messages: Message[], format: JsonSchemaFormat): Promise<string> {
  const message = await complete({ messages, response_format: format });
  if (typeof message.content !== "string") throw new Error("Meta API returned no structured content");
  return message.content;
}
