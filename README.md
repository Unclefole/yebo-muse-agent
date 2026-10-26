# yebo-muse-agent

**AI can propose. It cannot execute.**

A Meta Muse Spark agent that plans and proposes payments, and [Yebo](https://yebo.dev) that decides whether each one is allowed before anything runs.

Built for the **Meta Global AI Developer Hackathon** (Cerebral Valley), Startup Track.

## The problem

AI agents are starting to spend real money. Today most of them hold a raw API key, which means one bad prompt, one hallucination or one injected instruction can move funds with nobody in the loop.

## What this project does

1. **You give the agent a goal.** For example: "Pay our three contractors for October."
2. **Muse Spark plans the work** and turns it into concrete payment proposals using tool calls.
3. **Yebo checks every proposal** against the limits a human approved with a passkey (amount, payee, expiry, policy version) and returns `ALLOW`, `DENY` or `REQUIRE_APPROVAL`.
4. **Only `ALLOW` proceeds.** Everything else stops or waits for a human. It fails closed.
5. **Every decision gets a signed receipt** that anyone can verify offline at [yebo.dev/verify](https://yebo.dev/verify).

```
 Goal ──► Muse Spark agent ──► proposes payment ──► Yebo gateway ──► ALLOW / DENY / REQUIRE_APPROVAL
                                                         │
                                         human passkey approved the limits
                                                         │
                                                  signed receipt
```

## What was built during the hackathon

This entire repository was created during the hackathon (Oct 26 to Nov 4, 2026). See [HACKATHON_LOG.md](./HACKATHON_LOG.md) for a dated record.

**Pre-existing (not part of this submission):** the Yebo authorization gateway at `gateway.yebo.dev`. This project calls it over the network the same way any customer would. Its source is not in this repo.

## Meta models used

| Model | Role |
|---|---|
| Muse Spark (`muse-spark-1.1`) | Agent brain: planning and tool calling |
| More to come | See HACKATHON_LOG.md |

## Run it

```bash
cp .env.example .env     # add your keys (never commit .env)
npm install
npm run dev -- "Pay the design contractor $400 for the October logo work"
```

When the agent proposes its first payments, it asks Yebo for a mission covering exactly those payees and amounts, then prints a link like `https://yebo.dev/authorize/<id>`. Open it and approve with your passkey. The agent waits for the approval, then sends each payment to Yebo, which allows only what fits inside the approved limits.

## Safety

Payments run in **dry run** mode. No real money moves in this demo. The gateway decides dry run, and the agent stops if a result ever comes back that is not a dry run.

## License

All rights reserved. The code is public for hackathon judging. For anything else, reach out through [yebo.dev](https://yebo.dev).
