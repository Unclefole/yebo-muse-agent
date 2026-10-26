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

## 2026-10-26 (dry run check fix)

- `src/yebo.ts`: the dry run check now accepts `tr_dryrun_` references. The gateway now pays through Stripe Connect transfers, so its dry runs return `tr_dryrun_...` instead of `pi_dryrun_...`, and the old check stopped the run on every allowed payment. `pi_dryrun_` is still accepted for older gateways. Anything else still stops the run.

## 2026-10-26 (milestone: first live end-to-end run)

- First live run against the production Yebo gateway: Muse Spark proposed a $400 payment to the design contractor, the agent asked Yebo for a mission covering it, a human approved the limits with a Touch ID passkey at `yebo.dev/authorize/<id>`, and Yebo returned ALLOW with receipt `rcpt_1185e4fd-…`. Dry run: no money moved.

## 2026-10-26 (dry run wording)

- `src/yebo.ts`: `checkPayment()` now returns an `outcome` in plain words; an ALLOW is "approved (dry run, no money moved)".
- `src/agent.ts`: the model gets the decision and that outcome instead of the gateway's raw response, which says `executed: true` even in dry run. The system prompt tells it never to say executed, sent, paid or transferred.
- `src/agent.ts`: each run ends with a summary printed by the code, not the model, so the final word on each payment is always accurate.

## 2026-10-26 (Phase 1: invoice reading + judge mode)

- Checked the Meta Model API docs (dev.meta.ai/docs) before building: base URL `https://api.meta.ai/v1`, Bearer auth, Chat Completions `image_url` and `file` content parts, `response_format` `json_schema`. `muse-spark-1.3` is the docs' recommended model and accepts images and PDFs. Confirmed the shapes with live calls.
- `src/muse.ts`: image and PDF content parts and structured output (`structured()`); default model is now `muse-spark-1.3`.
- `src/invoice.ts`: reads an invoice image (PNG, JPEG, GIF, WebP) or PDF with Muse Spark vision and returns payee, amount, currency, due date, invoice number, payment details and any notes as JSON, constrained by a strict JSON schema and validated (fail closed). Invoice text is treated as untrusted data.
- `demo/invoices/`: four sample invoices from fictional businesses (two PNGs, a tilted phone-style JPEG, a PDF), made by `demo/make_invoices.py`.
- `src/judge/`: judge mode, a local stand-in for the Yebo gateway written for this repo (no gateway code). Same signed protocol and the same mission rules: allowed payees, per-payment limit, total budget, expiry, fail closed. Approval is simulated on a local page (no passkey) and every payment is a dry run.
- `src/gatewayMode.ts`: judge mode starts automatically when `YEBO_HMAC_SECRET` is empty (or `YEBO_MODE=judge`), so the repo runs with only a Meta API key.
- `src/agent.ts`: `npm run dev -- demo/invoices` reads the invoices, proposes one payment per invoice, asks for one mission covering them, waits for approval, then checks each payment. Malformed tool calls from the model are refused before they reach the gateway.
- `src/extract.ts`: `npm run extract` prints the extracted invoice JSON.
- `test/`: 15 tests (`npm test`) for the judge gateway rules (through the real client) and invoice reading (Meta API mocked).
- Live check: all four sample invoices extracted correctly by `muse-spark-1.3` (about 14 s for four), and a full judge-mode run proposed four payments, got one mission approved on the local page, and returned ALLOW with a receipt for each, dry run.
