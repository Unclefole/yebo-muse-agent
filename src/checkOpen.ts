// Checks the Muse Spark Open setup in plain English:  npm run check-open
//   1. is BASETEN_API_KEY set (never printed)
//   2. which Muse Spark Open model names Baseten offers this account (GET /v1/models)
//   3. a one-line chat, then a tool call like the agent makes
import "dotenv/config";
import { chat, endpoint, type Tool } from "./muse.js";

const ok = (msg: string) => console.log(`  OK    ${msg}`);
const bad = (msg: string) => console.log(`  FIX   ${msg}`);

async function main() {
  console.log("Checking Muse Spark Open on Baseten...\n");
  const ep = endpoint("muse-spark-open");
  if (!ep.key) {
    bad("BASETEN_API_KEY is not in your .env file. Add a line: BASETEN_API_KEY=your-key");
    process.exitCode = 1;
    return;
  }
  ok(`BASETEN_API_KEY is set (${ep.key.length} characters, not shown)`);

  const res = await fetch(`${ep.base}/models`, { headers: { Authorization: `Bearer ${ep.key}` } });
  if (res.status === 401 || res.status === 403) {
    bad(`Baseten refused the key (${res.status}). Create a new API key in Baseten and paste it into .env again.`);
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    bad(`Baseten answered ${res.status} when listing models: ${(await res.text()).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  const ids: string[] = ((await res.json())?.data ?? []).map((m: { id?: unknown }) => String(m.id ?? ""));
  const muse = ids.filter((id) => /muse/i.test(id));
  if (muse.length) ok(`Muse models on your account: ${muse.join(", ")}`);
  else bad(`No Muse Spark Open model is listed for your account (${ids.length} models in total). Check that Model APIs are enabled.`);
  if (!muse.includes(ep.model)) {
    const suggestion = muse.find((id) => /muse-spark-open/i.test(id));
    bad(`The app is set to use "${ep.model}", which is not in that list.` +
      (suggestion ? ` Add this line to .env: MUSE_SPARK_OPEN_MODEL=${suggestion}` : ""));
  } else ok(`The app will use "${ep.model}"`);

  const t0 = Date.now();
  const hello = await chat([{ role: "user", content: "Reply with the single word: ready" }], [], "muse-spark-open").catch((e: Error) => e);
  if (hello instanceof Error) {
    bad(`A test message failed: ${hello.message.slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  ok(`Test message answered in ${((Date.now() - t0) / 1000).toFixed(1)} s: "${String(hello.content ?? "").trim().slice(0, 60)}"`);

  const tools: Tool[] = [{
    type: "function",
    function: {
      name: "propose_payment",
      description: "Propose ONE payment.",
      parameters: { type: "object", properties: { payee: { type: "string" }, amount_usd: { type: "number" }, memo: { type: "string" } }, required: ["payee", "amount_usd", "memo"] },
    },
  }];
  const t1 = Date.now();
  const call = await chat([{ role: "user", content: "Propose a payment of $89 to Nimbus Cloud Hosting for invoice NH-88317." }], tools, "muse-spark-open").catch((e: Error) => e);
  if (call instanceof Error) {
    bad(`A test tool call failed: ${call.message.slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  const first = call.tool_calls?.[0];
  if (first?.function.name === "propose_payment") ok(`Tool calling works (${((Date.now() - t1) / 1000).toFixed(1)} s): ${first.function.arguments}`);
  else bad("The model answered without calling the tool. The agent may still work, but tell me what it said: " + String(call.content ?? "").slice(0, 200));

  console.log(process.exitCode ? "\nSome checks need fixing (see FIX above)." : "\nAll set. Run: npm run dev -- demo/invoices --open   (or pick Muse Spark Open in the web app)");
}

main().catch((err) => {
  console.error(`Check failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
