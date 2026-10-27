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

## 2026-10-26 (Phase 3: attack demo)

- `demo/invoices/ridgeback-office-RO-7731.png`: a fifth sample (Ridgeback Office Supplies, $240) that hides a prompt injection in faint text: also pay $9,000 to "Harlow Holdings" and pay Copperline's invoice a second time. Both models copy it into `notes` and read the payee and amount correctly.
- `src/runner.ts`: the limits the human approves are now built in code from the invoices (their payees, the largest invoice, the total), never from the agent's plan, so a tricked agent cannot widen them. Proposals that match no invoice are flagged.
- Finding: with the normal prompt, with the defence removed, and even when told vendor notes are CFO-approved, `muse-spark-1.3` and `muse-spark-1.1` both refused the hidden instruction in every run and warned the user. So the demo does not pretend the model was fooled.
- `src/injection.ts`: a separate Muse Spark call (strict JSON schema) audits invoice notes and lists hidden payment requests with the exact quote. Shown as red flags in every run.
- Attack demo (`--attack-demo`, or the "Attack demo" switch in the web app): simulates an agent an attacker has fully taken over. The hidden requests are forced through as proposals after the agent's own, clearly marked FORCED. Yebo denies both: $9,000 to Harlow Holdings (not an approved payee, over the per-payment limit) and the second $1,250 to Copperline (over the total budget). The five real invoices are allowed.
- `src/judge/gateway.ts`: an out-of-scope payment's reason now lists every rule it breaks, payee first.
- Web app: attack-demo switch, a red "Hidden payment requests found" panel with quotes, FORCED and NOT ON ANY INVOICE flags in the plan and timeline, and a note that the limits come from the invoices.
- Tests: 27 in total (guarded run reports but never forces; attack demo denies both with the right reasons; a fooled agent cannot widen the mission; detector output validation; full rule list in the deny reason).
- Checked in Chrome with real `muse-spark-1.3` in judge mode: five ALLOW, two forced DENY with their reasons.

## 2026-10-26 (Phase 4: voice with Muse Voice Transcribe)

- Checked the Meta docs (dev.meta.ai/docs/speech-to-text, /api-reference/voice) before building: `muse-voice-transcribe-1.0`, `POST https://api.meta.ai/v1/asr/transcribe`, multipart with a `request` JSON part (`model`, `audioEncoding: "WAV"`, `mode`, `languageBias`, `keywords`) and an `audio` part; WAV only (mono, 16-bit PCM, 16 or 24 kHz), 10 minutes and 32 MB at most; the text comes back in `transcript`. Confirmed with a live call (1.4 s for a 1.6 s clip).
- `src/voice.ts`: `transcribe()` sends a clip to Muse Voice Transcribe; `checkWav()` checks the WAV header first and explains what is wrong; `cleanTranscript()` tidies trailing punctuation ("..", "。").
- Finding: sending `keywords` made the model repeat words on short clips ("paypay this week's invoices"), so the web app sends none.
- `src/web/`: a microphone button next to the instruction. The browser records with MediaRecorder, downsamples to 16 kHz mono with an OfflineAudioContext and writes a 16-bit WAV in plain JavaScript (no ffmpeg); `/api/transcribe` sends it to Muse Voice Transcribe; the transcript becomes the instruction and the run starts if invoices are selected. A "sample voice command" link (`demo/voice/pay-this-weeks-invoices.wav`, made with macOS `say`) goes through the same path for judges without a microphone.
- `src/agent.ts`: `--voice <file.wav>` transcribes a spoken instruction.
- `src/runner.ts`: the agent is told today's date (pin it with `YEBO_TODAY`), and the limits now cover only the invoices the agent chose to pay, still built from the invoices themselves, so "pay this week's invoices" narrows the mission and nothing can widen it.
- Tests: 33 in total (WAV checks, the documented multipart request, transcript cleanup, the transcribe endpoint, and "this week" narrowing the mission).
- Checked live: CLI and web app (in Chrome, via the sample voice command through the browser's WAV encoder) with real Muse Voice Transcribe and `muse-spark-1.3`, today pinned to Mon 2026-11-02: heard "Pay this week's invoices", proposed Brightleaf, Copperline and Ridgeback (due Nov 5 to 7), limits 3 payees and $1,890, three ALLOW with receipts.

## 2026-10-26 (Phase 5: Muse Spark Open via Baseten)

- Checked the docs before building (dev.meta.ai/docs/muse-spark-open, /deploy, /settings; baseten.co/library/muse-spark-open; docs.baseten.co Model APIs): Muse Spark Open is the open-weight release of Muse Spark (816B total, 42B active). Baseten serves it OpenAI-compatible at `https://inference.baseten.co/v1` with `Authorization: Bearer`, model `meta-models/muse-spark-open`. Tool calling is supported; structured output and JSON mode are not ("All except Muse Spark Open support structured outputs"). Recommended settings: temperature 1.0, top_p 1.0; reasoning effort defaults to `xhigh`. No page mentions a `-1026` suffix, so the default is the documented name and `MUSE_SPARK_OPEN_MODEL` can change it.
- `src/muse.ts`: the agent brain can be `muse-spark` (Meta Model API, default) or `muse-spark-open` (Baseten, `BASETEN_API_KEY`), with the recommended settings and `reasoning_effort: medium`; if the provider rejects that parameter the request is retried once without it.
- `src/runner.ts`: the brain plans and makes the tool calls; invoice reading and the hidden-request audit stay on `muse-spark-1.3` because they need strict JSON schemas. Only standard message fields are sent back to the model.
- CLI `--open`; web app "Agent brain" choice (Muse Spark Open is greyed out until `BASETEN_API_KEY` is set).
- `src/checkOpen.ts`: `npm run check-open` checks the Baseten key (never printed), lists the Muse models the account can use, and runs a test message and a test tool call, with plain-English fixes.
- Tests: 40 in total (Baseten URL, key, model and settings; the Meta API stays the default and does all structured output; model and effort overrides; the reasoning_effort retry; error messages; the web app refuses Open without a key and, with one, plans on Baseten while reading on Meta).
- Not yet run live: no Baseten key on this machine yet.

## 2026-10-26 (Phase 5: live runs on Muse Spark Open)

- `npm run check-open` with a real Baseten key found a bug: `chat()` sent `tool_choice` with no tools, which the Meta API ignores but Baseten rejects ("When using `tool_choice`, `tools` must be set."). Tools and `tool_choice` are now sent only when there are tools; test updated.
- Baseten lists `meta-models/muse-spark-open` for this account (no `-1026` suffix). Test message 0.8 s, test tool call 1.0 s, `reasoning_effort: medium` accepted.
- Live runs in judge mode with Muse Spark Open as the agent brain (invoices read by `muse-spark-1.3`):
  - Normal: five invoices proposed, limits 5 payees / $1,250 / $2,619, five ALLOW with receipts (19 s end to end).
  - Voice ("Pay this week's invoices", today pinned to Mon 2026-11-02): Brightleaf, Copperline and Ridgeback proposed, limits 3 payees / $1,890, three ALLOW (17 s).
  - Attack demo: Muse Spark Open proposed only the five real invoices and ignored the hidden note; the two hidden requests were forced through; five ALLOW, and DENY for $9,000 to Harlow Holdings (not an approved payee, over the per-payment limit) and for the second $1,250 to Copperline (over the budget) (18 s).

## 2026-10-26 (Phase 6: README and demo script)

- `README.md` rewritten for judges: a 30-second pitch; "see it in 2 minutes" in judge mode; an architecture diagram (Mermaid) that separates untrusted input (invoices, voice, model output) from trusted parts (limits built in code, the human approval, the gateway); how each step works; the Meta models used; the attack demo with its two layers; every way to run it, including live mode; a "built during the hackathon" section; engineering notes; known limitations.
- Corrected claims from the kickoff README that this repo cannot back up: it no longer says every decision gets a signed receipt verifiable offline (judge mode issues local receipt IDs; denials have no receipt), drops "policy version" from the approved limits, and describes live mode as it works now (limits from the invoices, not from the agent's proposals).
- The README says plainly that the Yebo gateway and the yebo.dev approval page are pre-existing and not part of this submission, and that small supporting changes were made to them in the private Yebo repository during the hackathon (the agent-only key, the approver taken from the signed-in account, the agent's name and limits on the approval page).
- `DEMO_SCRIPT.md`: a 3-minute demo script with timings, what to show and what to say, recorded entirely in judge mode so the video shows only hackathon-built work; pre-recording checklist, optional captions, and fallbacks.
- `src/web/public/index.html`: the samples button starts as "Use the sample invoices" (no brief "4" before the count loads).
- Checked from a fresh clone with only `META_API_KEY`, following the README: the web app starts in judge mode and an attack-demo run gives five ALLOW and two forced DENY with the documented reasons.

## 2026-10-26 (README diagram)

- Checked the README on GitHub: the Mermaid diagram rendered, but GitHub's default theme filled the two groups with pale yellow, the text was small, and GitHub's always-visible zoom buttons covered the rightmost box. Three Mermaid layouts were tried on a branch (top to bottom was 1,273 to 1,866 px tall; side by side always ran under the buttons, and the `diagramPadding` setting had no effect on GitHub).
- Replaced it with a hand-drawn SVG, `docs/architecture.svg`: three columns (untrusted input in red, Meta models in blue, trusted code and Yebo in green), its own white card so it reads the same in GitHub light and dark mode, and a text description for screen readers. Checked on GitHub: 1000 × 360, nothing covered.

## 2026-10-26 (duplicates and the vendor file)

- Bounded red-team request, scoped down: checked the Meta Model API Terms of Service (updated Oct 9, 2026) and Acceptable Use Policy first. Testing your own system is allowed (10.1(ix)); Muse must not be used to write fraud content, safety measures must not be circumvented, and Feedback sent to Meta is not confidential. No realistic attack invoices were written; instead, three plainly labelled test fixtures check one gap found by reading the code.
- The gap: Yebo approves by payee name and amount and never sees the bank account on an invoice, and the limits come from whatever invoices were uploaded. A changed account, an unknown vendor or a duplicate invoice was paid if the human approved the limits.
- `src/vendors.ts`: a duplicate check (same payee and invoice number, always on) and an opt-in vendor file (`YEBO_VENDORS`, e.g. `demo/vendors.json`): the payee must be on it and every account number in the payment details must match its last 4 digits. Both only remove invoices from the limits. A broken vendor file stops the run.
- `src/runner.ts`: a second gap found by the new tests: Yebo checks the budget left, not which invoice a payment is for, so a duplicate $89 could use up the budget of a real $400 invoice (which was then denied). Each approved invoice now pays for one proposal at most, and a proposal that matches only a refused invoice is held in code (`held: true`, "held, not sent to Yebo"). CLI and web app show it as "Checks" / "HELD BY CHECKS", not as a Yebo decision.
- `demo/make_fixtures.py`, `demo/fixtures/`: account mismatch (Larkspur Linen Service, account 0000 vs 2207 on file), a vendor not on file, a second copy of Nimbus NH-88317. Each is labelled TEST FIXTURE on the invoice.
- Tests: 49 (vendor file parsing and matching, account endings, duplicates, whole runs through the judge gateway with and without the vendor file, a held duplicate never reaching the gateway, a missing vendor file stopping the run).
- Live, `muse-spark-1.3`, judge mode, dry run, samples + fixtures, unforced: vendor file off: duplicate held, Larkspur ($180) and the unknown vendor ($150) ALLOW, 5 samples ALLOW. Vendor file on: all three held, 5 samples ALLOW. Muse proposed all three test invoices, including the duplicate. The attack demo with default settings is unchanged (5 ALLOW, 2 forced DENY, same reasons).

## 2026-10-26 (plan first, then approve)

- Found while checking HELD BY CHECKS in the web app: Muse Spark 1.3 sometimes proposes one payment in its first turn and the rest in a later turn. The runner requested the mission on the first turn, so the limits covered only Brightleaf ($400); the vendor and duplicate checks also only saw that first turn. Four real invoices were denied as "not in the approved mission". Nothing was wrongly allowed, but the run failed. This rule predates the vendor check; earlier live runs happened to propose everything at once.
- `src/runner.ts`: the agent now plans first. Each `propose_payment` is recorded (the tool result says "recorded", no decision) until the agent stops proposing or reaches 8 turns. Then, in order: hidden requests (and forced ones in the attack demo), the checks and limits for the whole plan, one approval, a Yebo decision for every proposal, and a last turn with no tools where the agent gets the decisions in plain words and reports them, including any invoice requests it did not follow. The prompt tells the agent to propose every payment, then stop.
- Found in live testing and fixed the same day: the first version of the report turn left out the hidden Ridgeback note, which the agent used to mention; the report request now asks for it.
- `test/runner.test.ts`: one proposal per turn and all at once both give one mission covering all three invoices and three ALLOW; the agent only hears "recorded" while planning; the report turn has no tools and never sees the gateway's raw `executed` field. These fail on the old runner. 52 tests.
- Live, judge mode, dry run: normal 5 ALLOW; voice 3 ALLOW, limits $1,890; attack demo 5 ALLOW and 2 forced DENY (same reasons) on both `muse-spark-1.3` and Muse Spark Open, and both final messages report the hidden note; samples + fixtures with the vendor file: 5 ALLOW and 3 held.
