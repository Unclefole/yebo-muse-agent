# Submission draft (not submitted)

> **Draft only.** Nothing here has been submitted. Review it, then paste it into the hackathon form yourself.

**Demo video (3 min):** https://youtu.be/QfSVHJDowAU

**Hosted demo (replays, no key needed):** https://yebo-muse-demo-production.up.railway.app

**Yebo AP Agent: AI pays your invoices. It cannot be tricked into paying anyone else.** Meta's Muse models read the invoices and plan the payments; Yebo checks every payment against limits a human approved.

**Three Meta models:** Muse Spark 1.3 (reads invoices with vision, flags hidden payment requests, plans), Muse Voice Transcribe (spoken instructions), Muse Spark Open via Baseten (open weights: in Open mode it transcribes, reads invoice images, flags hidden requests and plans; PDFs stay on Muse Spark 1.3 because Baseten does not accept them).

**Contributors:** Francis Folekani Banda (solo).

## Quick start for judges

```bash
git clone https://github.com/Unclefole/yebo-muse-agent.git && cd yebo-muse-agent && npm ci
echo 'META_API_KEY=your-meta-key' > .env
YEBO_TODAY=2026-11-02 npm run web
```

Open http://127.0.0.1:3000, click **Use the demo set (7 invoices)**, **Run the agent**, **Open approval page (simulated)**, **Approve limits**. Expected: five ALLOW and two DENY from Yebo. Dry run only: no money moves.

## Results

Unforced catches (live, judge mode, dry run):

1. **Bank account not on file** (Larkspur shows 0000; the vendor file has 2207): Yebo DENY, *payee 'Larkspur Linen Service' is not in the approved mission*.
2. **Bill resent under a new number** (Nimbus NH-88317-R): Yebo DENY, *amount 89 exceeds the budget left (0)*.
3. **Split invoices** (ten $480 Juniper & Rye invoices against a $1,000-per-24-hours vendor limit): 2 ALLOW, 8 DENY.

Forced (a simulated hijack): both hidden payment requests from the Ridgeback invoice are denied by Yebo. Muse Spark Open also flagged both hidden payment requests.

Open misread a vendor name; Yebo refused to pay an unknown payee. It fails safe. In Open mode, Muse Spark Open read "Ridgeback Office Supplies" as "Ridgebacka" (or "Ridgebaka") Office Supplies in every run (6 of 6, Oct 27). That name is not on the vendor file, so the invoice was left out of the limits and Yebo denied the $240 payment: a real invoice went unpaid, and nothing was paid to a name nobody approved.

## Why now

Meta's own Muse Spark safety report says the model can be fooled by prompt injection in agent settings, and Meta guards its own Muse agent with Sentinel. Yebo gives developers building on the Muse Spark API the same protection for money.

- Meta, *Muse Spark Safety & Preparedness Report* (May 26, 2026): "Like many peer models, Muse Spark is susceptible to emerging risk factors related to adaptive jailbreak and prompt injection attacks in agentic settings." https://ai.meta.com/static-resource/muse-spark-safety-and-preparedness-report/
- Meta, *Introducing Muse* (Sep 8, 2026): "Nothing Muse does reaches the internet unless the Sentinel approves it, and it asks the person for permission when needed." https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/

## What's next (NOT BUILT)

- **Ad budgets:** an agent proposes ad spend; Yebo holds it to an approved budget.
- **Page posts:** an agent drafts business Page posts; only approved Pages and limits go through.
- **Business chats:** an agent answers customers; refunds, discounts and payment links stay within approved limits.

## Project name

Yebo AP Agent

## Description (150 words)

AI agents are starting to pay bills, and an invoice is a document anyone can write. Yebo AP Agent splits accounts payable in two. Muse Spark 1.3 reads invoice photos and PDFs with vision into validated JSON, flags payment requests hidden in invoice text, and plans the payments; Muse Voice Transcribe takes the instruction by voice, and Muse Spark Open runs Open mode. Trusted code builds the payment limits from the invoices and a vendor file of known payees and bank accounts. A human approves those limits once, and the Yebo gateway checks every payment. In the demo, five invoices are paid; an invoice with a bank account not on file and a bill resent under a new number are denied; and even when hidden requests are forced through, as if the agent were hijacked, Yebo denies them. Everything runs as a dry run, with only a Meta API key.

## Track and problem statement

- **Track:** Startup track (judged on technical execution and whether it holds up in production).
- **Problem statement:** **Build for Your World**: Yebo's own domain is authorizing payments made by AI agents, and this brings Meta's models to that domain.

## Meta models and how they are used

| Model | How it is used |
|---|---|
| **Muse Spark** (`muse-spark-1.3`, Meta Model API) | Reads invoice images and PDFs with vision into strict, schema-checked JSON; audits invoice text for hidden payment requests; default agent brain, proposing payments through tool calls |
| **Muse Spark Open** (`meta-models/muse-spark-open`, open weights, via Baseten) | Open mode: voice, reading invoice images, the hidden payment request check, and planning with tool calls. PDFs are read by Muse Spark 1.3 (Baseten does not accept PDFs) |
| **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) | Turns a spoken instruction ("Pay these invoices.") into the agent's goal; the browser records and encodes the WAV itself |

Every model name and API shape was checked against dev.meta.ai (and docs.baseten.co for Muse Spark Open) and confirmed with live calls; see `HACKATHON_LOG.md`.

## Built during the hackathon vs pre-existing

**Built Oct 26 to Nov 4, 2026 (everything in the repository):**
- Invoice reading and validation, the hidden payment request audit, voice instructions, Open mode on Muse Spark Open
- The agent loop: plan first, then one approval for the whole plan; limits built in code and only ever narrowed
- The vendor file (payees, bank accounts, per-vendor caps) and the duplicate check
- Judge mode: a local stand-in for the Yebo gateway with a simulated approval page
- The web app with the live decision timeline and the one-click demo set
- Replays of real recorded runs, and a hosted-demo mode with strict limits (replay site deployed at https://yebo-muse-demo-production.up.railway.app; live runs not deployed; see `HOSTING.md`)
- Sample and test invoices, 143 tests (including 18 adversarial payment tests), and a dated log of every change (`HACKATHON_LOG.md`)

**Pre-existing, not part of this submission:** the Yebo authorization gateway (`gateway.yebo.dev`) and the yebo.dev passkey approval page. The project calls the gateway over the network like any customer; its source is not in the repository. Small supporting changes were made to it during the hackathon (an agent-only key that can never approve missions, the approval page taking the approver from the signed-in account, and showing the agent's name and limits); those are not part of the submission either. Judge mode runs everything without them.

## Links

- **Repository:** https://github.com/Unclefole/yebo-muse-agent (public)
- **Release:** the latest release on the repository's Releases page
- **Hosted demo for judges:** https://yebo-muse-demo-production.up.railway.app (replays of real runs, no key needed)
- **Demo video:** https://youtu.be/QfSVHJDowAU (3 minutes, recorded from `DEMO_SCRIPT.md`)

## Bonus prizes we are entering

- **Best Open Weight:** Open mode runs voice, invoice image reading, the hidden payment request check and planning on Muse Spark Open via Baseten, and the app says plainly which steps are not open weights (PDF reading). Muse Spark Open flagged both hidden payment requests in every run.
- **Best Agentic:** the agent plans multi-step payments with tool calls, and a separate trusted layer (the vendor file, human-approved limits, and Yebo on every payment) keeps a fooled or hijacked agent from paying anyone else.
- **Most Viral:** a one-click demo and a simple story: "AI can be fooled. The payment can't." (post drafts in `X_POSTS.md`, not posted).
- **Community Vote:** the same one-click demo, and replays of real runs that need no key.

Eligibility and whether prizes can be combined follow the official rules.

## Deadline

Nov 4, 2026, 9:00 PM ET (6:00 PM PT), per the Cerebral Valley event page.
