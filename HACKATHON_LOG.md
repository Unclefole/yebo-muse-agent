# Hackathon build log

A dated record of what was built during the Meta Global AI Developer Hackathon, so judges can see exactly what is new.

## 2026-10-26 (kickoff day)

- Created this public repository.
- Added the starter structure: Muse Spark client, Yebo gateway client, agent loop, environment template.

## 2026-10-26 (gateway mission flow)

- `src/yebo.ts`: replaced the placeholder `/api/agent/authorize` and `/api/agent/execute` routes with the gateway's real mission routes: `POST /api/blacktoven/authorize`, `GET /api/blacktoven/authorize/<id>/status`, `POST /api/blacktoven/execute`.
- `src/yebo.ts`: replaced the `x-agent-signature` header with the gateway's signed request scheme (`x-blacktoven-ts` + `x-blacktoven-signature`, HMAC-SHA256 over timestamp, method, path and body).
- `src/yebo.ts`: mission requests now send an enforceable scope (payment only, per payment ceiling, total budget, allowed payees, USD only, expiry).
- `src/yebo.ts`: added `waitForApproval()`, which polls until a human approves the mission with a passkey at `yebo.dev/authorize/<id>` and returns the signed mission token.
- `src/yebo.ts`: `checkPayment()` fails closed (anything other than an allowed, executed payment is DENY) and stops the run if the gateway ever returns a payment that is not a dry run.
- `src/agent.ts`: the first batch of proposed payments sets the mission limits; the agent prints the approval link, waits for the passkey approval, then checks each payment.
- `.env.example` and `README.md`: `YEBO_AGENT_SECRET` renamed to `YEBO_HMAC_SECRET`; added `YEBO_BOT_IDENTIFIER` and optional `YEBO_MISSION_TOKEN`; documented the approval step.
- Dry run stays on. No secrets committed.
