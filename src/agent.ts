// Agent loop: Muse Spark plans and proposes payments; Yebo decides; only ALLOW proceeds.
import "dotenv/config";
import { chat, type Message, type Tool } from "./muse.js";
import { checkPayment, type PaymentProposal } from "./yebo.js";

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
REQUIRE_APPROVAL, explain why to the user and do not try to work around it.`;

async function run(goal: string) {
  const missionToken = process.env.YEBO_MISSION_TOKEN ?? ""; // issued after the human approves the mission
  const messages: Message[] = [
    { role: "system", content: system },
    { role: "user", content: goal },
  ];

  for (let step = 0; step < 8; step++) {
    const reply = await chat(messages, tools);
    messages.push(reply);

    if (!reply.tool_calls?.length) {
      console.log(`\nAgent: ${reply.content}`);
      return;
    }

    for (const call of reply.tool_calls) {
      const proposal = JSON.parse(call.function.arguments) as PaymentProposal;
      console.log(`\nProposed: $${proposal.amount_usd} to ${proposal.payee} (${proposal.memo})`);
      const result = await checkPayment(missionToken, proposal);
      console.log(`Yebo: ${result.decision}${result.receipt ? `  receipt ${result.receipt}` : ""}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
}

const goal = process.argv.slice(2).join(" ") || "Pay the design contractor $400 for the October logo work";
run(goal).catch((err) => {
  console.error(err);
  process.exit(1);
});
