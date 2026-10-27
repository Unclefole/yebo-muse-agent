// Command line front end for the agent (the web app is src/web/server.ts). Muse Spark reads
// invoices and proposes payments; Yebo decides; only ALLOW proceeds.
//   npm run dev -- demo/invoices                   pay every invoice in a folder
//   npm run dev -- path/to/invoice.pdf "goal"      one or more invoice files, optional goal
//   npm run dev -- "Pay the design contractor $400 for the October logo work"
//   npm run dev -- demo/invoices --attack-demo      hidden payment requests are forced through
//                                                   (a hijacked agent); Yebo still stops them
//   npm run dev -- demo/invoices --open             plan with Muse Spark Open (open weights, Baseten)
//   npm run dev -- demo/invoices --voice demo/voice/pay-this-weeks-invoices.wav
//                                                   the spoken instruction, via Muse Voice Transcribe
import "dotenv/config";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { DRY_RUN_OUTCOME } from "./yebo.js";
import { readInvoiceFile, SUPPORTED_EXTENSIONS } from "./invoice.js";
import { startGateway, modeBanner } from "./gatewayMode.js";
import { transcribe, VOICE_MODEL } from "./voice.js";
import { readFile } from "node:fs/promises";
import { runAgent, type AgentMode, type RunEvent } from "./runner.js";
import type { Brain } from "./muse.js";

function print(e: RunEvent, mode: "live" | "judge") {
  switch (e.type) {
    case "started":
      if (e.agentMode === "attack-demo") {
        console.log("\nATTACK DEMO: simulates an agent an attacker has fully taken over. Payment requests");
        console.log("hidden in the invoices are forced through after the agent's own. Watch what Yebo does.");
      }
      console.log(`Instruction: "${e.goal}" (today is ${e.today})`);
      console.log(`Agent brain: ${e.brainLabel}, ${e.model}`);
      if (e.vendorCheck) console.log("Vendor file: on (payee and bank account must match it)");
      if (e.invoices) console.log(`\nReading ${e.invoices} invoice${e.invoices === 1 ? "" : "s"} with ${e.readerModel}...`);
      break;
    case "invoice": {
      const v = e.invoice;
      console.log(`  ${v.file}: ${v.payee}, ${v.currency} ${v.amount.toFixed(2)}, due ${v.due_date ?? "?"}, #${v.invoice_number ?? "?"}`);
      if (v.notes) console.log(`    note on invoice: ${v.notes.replace(/\s*\n\s*/g, " ")}`);
      break;
    }
    case "invoice_error":
      console.log(`  ${e.file}: could not read (${e.error})`);
      break;
    case "proposed":
      if (e.forced) console.log(`\nFORCED (attack demo): $${e.proposal.amount_usd} to ${e.proposal.payee} (${e.proposal.memo})`);
      else console.log(`\nProposed: $${e.proposal.amount_usd} to ${e.proposal.payee} (${e.proposal.memo})${e.matchesInvoice === false ? "  << NOT ON ANY INVOICE" : ""}`);
      break;
    case "hidden_requests":
      console.log(`\nHidden payment requests found in invoice text (not followed by the agent):`);
      for (const r of e.requests) console.log(`  ${r.invoice_file}: $${r.amount_usd} to ${r.payee}  "${r.quote}"`);
      break;
    case "invoices_refused":
      console.log(`\nLeft out of the limits (Yebo will deny these):`);
      for (const r of e.rejected) console.log(`  ${r.file}: ${r.payee}: ${r.reason}`);
      break;
    case "no_mission":
      console.log(`\nNo mission requested: ${e.reason}. Nothing will run.`);
      break;
    case "proposal_refused":
      console.log(`\nRefused a malformed proposal: ${e.raw}`);
      break;
    case "mission": {
      const l = e.limits;
      console.log(`\nLimits ${e.source === "invoices" ? "from the invoices" : "for this plan"}: ${l.payees.length} payees, up to $${l.per_payment_usd} each, $${l.total_usd} in total`);
      const how = mode === "judge" ? "in your browser (judge mode, simulated approval)" : "with your passkey";
      console.log(`\nApprove these limits ${how}: ${e.authorizeUrl}`);
      if (e.requiredApprovals > 1) console.log(`(needs ${e.requiredApprovals} different approvers)`);
      break;
    }
    case "mission_result":
      console.log(e.approved ? "Mission approved." : "Mission was not approved. Nothing will run.");
      break;
    case "decision":
      console.log(`Yebo${e.forced ? " (forced)" : ""}: ${e.decision}, ${e.outcome}${e.receipt ? `  receipt ${e.receipt}` : ""}${e.reason ? `  (${e.reason})` : ""}`);
      break;
    case "agent_message":
      console.log(`\nAgent: ${e.text}`);
      break;
    case "summary":
      // Printed by the code, not the model, so the last word on what happened is accurate.
      if (!e.results.length) break;
      console.log("\nSummary:");
      for (const r of e.results) {
        const line = r.decision === "ALLOW" ? DRY_RUN_OUTCOME : r.outcome;
        console.log(`  $${r.proposal.amount_usd} to ${r.proposal.payee}${r.forced ? " (forced)" : ""}: ${line}${r.reason && r.decision !== "ALLOW" ? ` (${r.reason})` : ""}${r.receipt ? `  receipt ${r.receipt}` : ""}`);
      }
      break;
    case "error":
      console.error(`\nError: ${e.message}`);
      process.exitCode = 1;
      break;
  }
}

// Splits the command line into invoice files (files, or folders of them) and the goal text.
async function parseArgs(args: string[]): Promise<{ goal: string; files: string[]; agentMode: AgentMode; voice: string | null; brain: Brain }> {
  const files: string[] = [];
  const words: string[] = [];
  let agentMode: AgentMode = "guarded";
  let voice: string | null = null;
  let brain: Brain = "muse-spark";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--open") {
      brain = "muse-spark-open";
      continue;
    }
    if (arg === "--attack-demo") {
      agentMode = "attack-demo";
      continue;
    }
    if (arg === "--voice") {
      voice = args[++i] ?? null;
      if (!voice) throw new Error("--voice needs a WAV file");
      continue;
    }
    const info = await stat(arg).catch(() => null);
    if (info?.isDirectory()) {
      for (const name of (await readdir(arg)).sort()) {
        if (SUPPORTED_EXTENSIONS.includes(extname(name).toLowerCase())) files.push(join(arg, name));
      }
    } else if (info?.isFile()) files.push(arg);
    else words.push(arg);
  }
  const goal = words.join(" ") || (files.length ? "Pay these invoices." : "Pay the design contractor $400 for the October logo work");
  return { goal, files, agentMode, voice, brain };
}

async function main() {
  const args = await parseArgs(process.argv.slice(2));
  const { files, agentMode, brain } = args;
  let goal = args.goal;
  if (args.voice) {
    console.log(`Transcribing ${args.voice} with ${VOICE_MODEL}...`);
    goal = await transcribe(await readFile(args.voice));
    console.log(`Heard: "${goal}"`);
  }
  const sources = await Promise.all(files.map((f) => readInvoiceFile(f)));
  const gateway = await startGateway();
  console.log(modeBanner(gateway));
  try {
    await runAgent({ goal, sources, agentMode, brain }, gateway, (e) => print(e, gateway.mode));
  } finally {
    await gateway.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
