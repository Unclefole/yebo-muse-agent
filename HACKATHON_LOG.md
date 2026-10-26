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

## 2026-10-26 (Phase 2: web app)

- `src/runner.ts`: the agent run (read invoices, plan, request one mission, wait for approval, check each payment) now reports every step as a typed event. The CLI and the web app share it, so both follow exactly the same path.
- `src/agent.ts`: the CLI prints the runner's events; output unchanged.
- `src/invoice.ts`: reads uploaded bytes as well as files.
- `src/web/`: `npm run web` serves a local web app (127.0.0.1 only, no framework, no new dependencies). Upload invoices or use the samples, see what Muse Spark read, the agent's plan and the limits to approve, a button that opens the approval link, and a live timeline (server-sent events) of every Yebo decision: ALLOW, DENY or REQUIRE_APPROVAL, with the reason and the receipt ID. Yebo green accents, red for DENY, blue-grey for REQUIRE_APPROVAL, no yellow. Strict content security policy, no inline scripts, all text written with textContent, same-origin uploads only, size and type limits. Works in judge mode and live mode.
- `src/judge/pages.ts`: the judge-mode notice is blue instead of peach.
- `test/web.test.ts`: 4 new tests (19 in total) for the web app: a full sample run streams every step in order with nothing checked before approval, late listeners get the full replay, uploads are validated, the page has a strict CSP.
- Checked in Chrome in judge mode with real Muse Spark: approving gives four ALLOW entries with receipts; denying gives four REQUIRE_APPROVAL entries with the reason.

## 2026-10-26 (Phase 2 fixes from browser testing)

- `src/invoice.ts`: due dates came back empty with `muse-spark-1.1` because the prompt said to copy text "word for word" and the model returned "Nov 1, 2026", which the parser only accepted as YYYY-MM-DD. The prompt and schema now ask for YYYY-MM-DD, and `normalizeDate()` also converts written dates ("Nov 7, 2026", "7 Nov 2026", "2026/11/07") itself. All-numeric day/month dates are ambiguous and stay empty.
- `src/invoice.ts`: the payee could come back as the "how to pay" block ("Pay Nimbus Cloud Hosting / Fictional Bank, account ending 3350"). The schema now asks for the business name in the invoice header only, and `cleanPayee()` keeps the first line, drops a leading "Pay"/"Pay to"/"Bank transfer to" and a trailing bank line from the payment details. A payee that still mentions a bank or account is refused, never paid.
- `src/invoice.ts`: a JSON answer wrapped in a code fence or a sentence still parses, and an unusable answer is retried once.
- `src/web/public/`: notes on invoices are collapsed behind a small "Show note" toggle.
- `test/invoice.test.ts`: tests for the exact Nimbus payee string (with and without the line break), date conversion, wrapped JSON and the single retry (22 tests in total).
- Live check: the four samples on `muse-spark-1.1` (three runs) and `muse-spark-1.3` now give the right payee and due date for every invoice; one 1.1 run returned malformed JSON once, which the new retry covers.
