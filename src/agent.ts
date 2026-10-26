// Agent loop: Muse Spark plans and proposes payments; Yebo decides; only ALLOW proceeds.
import "dotenv/config";
import { chat, type Message, type Tool } from "./muse.js";
import { checkPayment, requestMission, waitForApproval, DRY_RUN_OUTCOME, type PaymentProposal } from "./yebo.js";

const MISSION_TTL_MS = 15 * 60_000;

// Asks Yebo for a mission that covers exactly these proposals, then waits for a human
// to approve it with a passkey. Returns the mission token, or "" if it was not approved.
async function approveMission(goal: string, proposals: PaymentProposal[]): Promise<string> {
  const mission = await requestMission(goal, {
    per_transaction_usd: Math.max(...proposals.map((p) => p.amount_usd)),
    cumulative_usd: proposals.reduce((sum, p) => sum + p.amount_usd, 0),
    payees: [...new Set(proposals.map((p) => p.payee))],
    expires_at: new Date(Date.now() + MISSION_TTL_MS).toISOString(),
  });
  console.log(`\nApprove these limits with your passkey: ${mission.authorizeUrl}`);
  if (mission.requiredApprovals > 1) console.log(`(needs ${mission.requiredApprovals} different approvers)`);
  const token = await waitForApproval(mission);
  console.log(token ? "Mission approved." : "Mission was not approved. Nothing will run.");
  return token ?? "";
}

const tools: Tool[] = [
  {
    type: "function",
    function: {
      name: "propose_payment",
      description:
        "Propose ONE payment. You cannot send money yourself. Yebo will ALLOW, DENY or REQUIRE_APPROVAL it.",
      parameters: {
        type: "object",
        properties: {
          payee: { type: "string", description: "Who receives the money" },
          amount_usd: { type: "number", description: "Amount in US dollars" },
          memo: { type: "string", description: "What the payment is for" },
        },
        required: ["payee", "amount_usd", "memo"],
      },
    },
  },
];

const system = `You are a finance operations agent. Break the user's goal into individual payments and
call propose_payment for each one. You can propose; you cannot execute. If Yebo returns DENY or
REQUIRE_APPROVAL, explain why to the user and do not try to work around it.
Payments run in dry run. When Yebo returns ALLOW, say the payment was "${DRY_RUN_OUTCOME}".
Never say a payment was executed, sent, paid or transferred.`;

async function run(goal: string) {
  let missionToken = process.env.YEBO_MISSION_TOKEN ?? ""; // issued after the human approves the mission
  let missionRequested = missionToken !== "";
  const results: Result[] = [];
  const messages: Message[] = [
    { role: "system", content: system },
    { role: "user", content: goal },
  ];

  for (let step = 0; step < 8; step++) {
    const reply = await chat(messages, tools);
    messages.push(reply);

    if (!reply.tool_calls?.length) {
      console.log(`\nAgent: ${reply.content}`);
      printSummary(results);
      return;
    }

    const proposals = reply.tool_calls.map((call) => JSON.parse(call.function.arguments) as PaymentProposal);
    for (const p of proposals) console.log(`\nProposed: $${p.amount_usd} to ${p.payee} (${p.memo})`);

    // One mission per run: the first batch of proposals sets the limits the human approves.
    // Anything proposed later must fit inside them or Yebo denies it.
    if (!missionRequested) {
      missionRequested = true;
      missionToken = await approveMission(goal, proposals);
    }

    for (const [i, call] of reply.tool_calls.entries()) {
      const result = await checkPayment(missionToken, proposals[i]);
      results.push({ proposal: proposals[i], decision: result.decision, outcome: result.outcome, receipt: result.receipt });
      console.log(
        `Yebo: ${result.decision}, ${result.outcome}${result.receipt ? `  receipt ${result.receipt}` : ""}${result.reason ? `  (${result.reason})` : ""}`,
      );
      // The model gets the decision in plain words, not the gateway's raw response
      // (which says executed: true even in dry run).
      const forModel = { decision: result.decision, outcome: result.outcome, reason: result.reason, receipt: result.receipt };
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(forModel) });
    }
  }
  printSummary(results);
}

type Result = { proposal: PaymentProposal; decision: string; outcome: string; receipt?: string };

// Printed by the code, not the model, so the last word on what happened is always accurate.
function printSummary(results: Result[]) {
  if (!results.length) return;
  console.log("\nSummary:");
  for (const r of results) {
    const line = r.decision === "ALLOW" ? DRY_RUN_OUTCOME : r.outcome;
    console.log(`  $${r.proposal.amount_usd} to ${r.proposal.payee}: ${line}${r.receipt ? `  receipt ${r.receipt}` : ""}`);
  }
}

const goal = process.argv.slice(2).join(" ") || "Pay the design contractor $400 for the October logo work";
run(goal).catch((err) => {
  console.error(err);
  process.exit(1);
});
