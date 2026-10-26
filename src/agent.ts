// Command line front end for the agent (the web app is src/web/server.ts). Muse Spark reads
// invoices and proposes payments; Yebo decides; only ALLOW proceeds.
//   npm run dev -- demo/invoices                   pay every invoice in a folder
//   npm run dev -- path/to/invoice.pdf "goal"      one or more invoice files, optional goal
//   npm run dev -- "Pay the design contractor $400 for the October logo work"
import "dotenv/config";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { DRY_RUN_OUTCOME } from "./yebo.js";
import { readInvoiceFile, SUPPORTED_EXTENSIONS } from "./invoice.js";
import { startGateway, modeBanner } from "./gatewayMode.js";
import { runAgent, type RunEvent } from "./runner.js";

function print(e: RunEvent, mode: "live" | "judge") {
  switch (e.type) {
    case "started":
      if (e.invoices) console.log(`\nReading ${e.invoices} invoice${e.invoices === 1 ? "" : "s"} with ${e.model}...`);
      break;
    case "invoice": {
      const v = e.invoice;
      console.log(`  ${v.file}: ${v.payee}, ${v.currency} ${v.amount.toFixed(2)}, due ${v.due_date ?? "?"}, #${v.invoice_number ?? "?"}`);
      if (v.notes) console.log(`    note on invoice: ${v.notes}`);
      break;
    }
    case "invoice_error":
      console.log(`  ${e.file}: could not read (${e.error})`);
      break;
    case "proposed":
      console.log(`\nProposed: $${e.proposal.amount_usd} to ${e.proposal.payee} (${e.proposal.memo})`);
      break;
    case "proposal_refused":
      console.log(`\nRefused a malformed proposal: ${e.raw}`);
      break;
    case "mission": {
      const how = mode === "judge" ? "in your browser (judge mode, simulated approval)" : "with your passkey";
      console.log(`\nApprove these limits ${how}: ${e.authorizeUrl}`);
      if (e.requiredApprovals > 1) console.log(`(needs ${e.requiredApprovals} different approvers)`);
      break;
    }
    case "mission_result":
      console.log(e.approved ? "Mission approved." : "Mission was not approved. Nothing will run.");
      break;
    case "decision":
      console.log(`Yebo: ${e.decision}, ${e.outcome}${e.receipt ? `  receipt ${e.receipt}` : ""}${e.reason ? `  (${e.reason})` : ""}`);
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
        console.log(`  $${r.proposal.amount_usd} to ${r.proposal.payee}: ${line}${r.receipt ? `  receipt ${r.receipt}` : ""}`);
      }
      break;
    case "error":
      console.error(`\nError: ${e.message}`);
      process.exitCode = 1;
      break;
  }
}

// Splits the command line into invoice files (files, or folders of them) and the goal text.
async function parseArgs(args: string[]): Promise<{ goal: string; files: string[] }> {
  const files: string[] = [];
  const words: string[] = [];
  for (const arg of args) {
    const info = await stat(arg).catch(() => null);
    if (info?.isDirectory()) {
      for (const name of (await readdir(arg)).sort()) {
        if (SUPPORTED_EXTENSIONS.includes(extname(name).toLowerCase())) files.push(join(arg, name));
      }
    } else if (info?.isFile()) files.push(arg);
    else words.push(arg);
  }
  const goal = words.join(" ") || (files.length ? "Pay these invoices." : "Pay the design contractor $400 for the October logo work");
  return { goal, files };
}

async function main() {
  const { goal, files } = await parseArgs(process.argv.slice(2));
  const sources = await Promise.all(files.map((f) => readInvoiceFile(f)));
  const gateway = await startGateway();
  console.log(modeBanner(gateway));
  try {
    await runAgent({ goal, sources }, gateway, (e) => print(e, gateway.mode));
  } finally {
    await gateway.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
