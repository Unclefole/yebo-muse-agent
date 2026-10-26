// The agent brain: Muse Spark (Meta Model API) or Muse Spark Open (Baseten). Requests are
// mocked; nothing leaves the machine.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chat, structured, endpoint, OPEN_DEFAULT_MODEL } from "../src/muse.js";

const realFetch = globalThis.fetch;
type Call = { url: string; auth: string; body: any };
let calls: Call[];
let respond: (call: Call) => Response;

beforeEach(() => {
  process.env.META_API_KEY = "meta-key";
  process.env.META_API_BASE = "https://api.meta.test/v1";
  process.env.BASETEN_API_KEY = "baseten-key";
  process.env.BASETEN_API_BASE = "https://inference.baseten.test/v1";
  delete process.env.MUSE_SPARK_OPEN_MODEL;
  delete process.env.MUSE_SPARK_OPEN_REASONING_EFFORT;
  delete process.env.META_MODEL;
  calls = [];
  respond = () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const call = { url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(String(init.body)) };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BASETEN_API_KEY;
  delete process.env.BASETEN_API_BASE;
});

test("Muse Spark Open goes to Baseten with the documented model, Bearer key and settings", async () => {
  await chat([{ role: "user", content: "hi" }], [], "muse-spark-open");
  assert.equal(calls[0].url, "https://inference.baseten.test/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer baseten-key");
  assert.equal(calls[0].body.model, OPEN_DEFAULT_MODEL);
  assert.equal(OPEN_DEFAULT_MODEL, "meta-models/muse-spark-open");
  assert.equal(calls[0].body.temperature, 1.0);
  assert.equal(calls[0].body.top_p, 1.0);
  assert.equal(calls[0].body.reasoning_effort, "medium");
  assert.equal("tool_choice" in calls[0].body, false, "no tools, so no tool_choice (Baseten rejects it)");
  assert.equal("tools" in calls[0].body, false);
  const tools = [{ type: "function" as const, function: { name: "t", description: "d", parameters: {} } }];
  await chat([{ role: "user", content: "hi" }], tools, "muse-spark-open");
  assert.equal(calls[1].body.tool_choice, "auto");
  assert.equal(calls[1].body.tools.length, 1);
});

test("the default brain stays on the Meta Model API with muse-spark-1.3", async () => {
  await chat([{ role: "user", content: "hi" }], []);
  assert.equal(calls[0].url, "https://api.meta.test/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer meta-key");
  assert.equal(calls[0].body.model, "muse-spark-1.3");
  assert.equal(calls[0].body.reasoning_effort, undefined);
});

test("structured output (invoice reading) always uses the Meta Model API", async () => {
  await structured([{ role: "user", content: "x" }], { type: "json_schema", json_schema: { name: "n", strict: true, schema: {} } });
  assert.equal(calls[0].url, "https://api.meta.test/v1/chat/completions");
});

test("model name and reasoning effort can be changed from .env", async () => {
  process.env.MUSE_SPARK_OPEN_MODEL = "meta-models/muse-spark-open-1026";
  process.env.MUSE_SPARK_OPEN_REASONING_EFFORT = "default";
  await chat([{ role: "user", content: "hi" }], [], "muse-spark-open");
  assert.equal(calls[0].body.model, "meta-models/muse-spark-open-1026");
  assert.equal("reasoning_effort" in calls[0].body, false);
  assert.equal(endpoint("muse-spark-open").model, "meta-models/muse-spark-open-1026");
});

test("if Baseten rejects reasoning_effort, the request is retried once without it", async () => {
  respond = (call) => ("reasoning_effort" in call.body
    ? new Response('{"error":"unknown parameter: reasoning_effort"}', { status: 400 })
    : new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 }));
  const reply = await chat([{ role: "user", content: "hi" }], [], "muse-spark-open");
  assert.equal(reply.content, "ok");
  assert.equal(calls.length, 2);
  assert.equal("reasoning_effort" in calls[1].body, false);
});

test("other errors are reported, and a missing key is explained", async () => {
  respond = () => new Response('{"error":"bad"}', { status: 400 });
  await assert.rejects(chat([{ role: "user", content: "hi" }], [], "muse-spark-open"), /Baseten \(Muse Spark Open\) 400/);
  assert.equal(calls.length, 1);
  delete process.env.BASETEN_API_KEY;
  await assert.rejects(chat([{ role: "user", content: "hi" }], [], "muse-spark-open"), /BASETEN_API_KEY is not set/);
});
