// Meta Muse Spark client (chat completions with tool calling).
// Base URL and model come from .env so they can be changed without code edits.
// TODO(confirm): request/response shape against the official Meta Model API docs at kickoff.

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
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

export async function chat(messages: Message[], tools: Tool[]): Promise<Message> {
  const base = process.env.META_API_BASE ?? "https://api.meta.ai/v1";
  const model = process.env.META_MODEL ?? "muse-spark-1.1";
  const key = process.env.META_API_KEY;
  if (!key) throw new Error("META_API_KEY is not set");

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
  });
  if (!res.ok) throw new Error(`Meta API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message as Message;
}
