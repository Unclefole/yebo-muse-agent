# Submission draft (not submitted)

> **Draft only.** Nothing here has been submitted. Review it, then paste it into the hackathon form yourself. Items marked **TO CONFIRM** could not be checked against the official rules.

## Project name

Yebo AP Agent

## One-line pitch

AI pays your invoices. It cannot be tricked into paying anyone else.

## Description (150 words)

AI agents are starting to pay bills, and an invoice is a document anyone can write. Yebo AP Agent splits accounts payable in two. Muse Spark 1.3 reads invoice photos and PDFs with vision into validated JSON, flags payment requests hidden in invoice text, and plans the payments; Muse Voice Transcribe takes the instruction by voice, and Muse Spark Open can plan instead. Trusted code builds the payment limits from the invoices and a vendor file of known payees and bank accounts. A human approves those limits once, and the Yebo gateway checks every payment. In the demo, five invoices are paid; an invoice with a bank account not on file and a bill resent under a new number are denied; and even when hidden requests are forced through, as if the agent were hijacked, Yebo denies them. Everything runs as a dry run, with only a Meta API key.

## Track and problem statement

- **Track:** Startup track (judged on technical execution and whether it holds up in production).
- **Problem statement:** **Build for Your World**: Yebo's own domain is authorizing payments made by AI agents, and this brings Meta's models to that domain. It could also be argued under **Push the Frontier** (safe autonomy for AI agents that move money), but "Build for Your World" is the closer fit. **Your call.**

## Meta models and how they are used

| Model | How it is used |
|---|---|
| **Muse Spark** (`muse-spark-1.3`, Meta Model API) | Reads invoice images and PDFs with vision into strict, schema-checked JSON; audits invoice text for hidden payment requests; default agent brain, proposing payments through tool calls |
| **Muse Spark Open** (`meta-models/muse-spark-open`, open weights, via Baseten) | Optional agent brain for planning and tool calls |
| **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) | Turns a spoken instruction ("Pay these invoices.") into the agent's goal; the browser records and encodes the WAV itself |

Every model name and API shape was checked against dev.meta.ai (and docs.baseten.co for Muse Spark Open) and confirmed with live calls; see `HACKATHON_LOG.md`.

## Built during the hackathon vs pre-existing

**Built Oct 26 to Nov 4, 2026 (everything in the repository):**
- Invoice reading and validation, the hidden payment request audit, voice instructions, Muse Spark Open as an optional brain
- The agent loop: plan first, then one approval for the whole plan; limits built in code and only ever narrowed
- The vendor file (payees, bank accounts, per-vendor caps) and the duplicate check
- Judge mode: a local stand-in for the Yebo gateway with a simulated approval page
- The web app with the live decision timeline and the one-click demo set
- Sample and test invoices, 74 tests, and a dated log of every change (`HACKATHON_LOG.md`)

**Pre-existing, not part of this submission:** the Yebo authorization gateway (`gateway.yebo.dev`) and the yebo.dev passkey approval page. The project calls the gateway over the network like any customer; its source is not in the repository. Small supporting changes were made to it during the hackathon (an agent-only key that can never approve missions, the approval page taking the approver from the signed-in account, and showing the agent's name and limits); those are not part of the submission either. Judge mode runs everything without them.

## How to run it (about 2 minutes, only a Meta API key)

```bash
git clone https://github.com/Unclefole/yebo-muse-agent.git
cd yebo-muse-agent
npm ci
echo 'META_API_KEY=your-meta-key' > .env
npm run web    # open http://127.0.0.1:3000
```

Click **Use the demo set (7 invoices)**, then **Run the agent**, then **Open approval page (simulated)** and **Approve limits**. Expected: five ALLOW and two DENY from Yebo. Then **Use the 5 sample invoices**, tick **Attack demo** and run again: the hidden requests are forced through and denied. Dry run only: no money moves.

## Links

- **Repository:** https://github.com/Unclefole/yebo-muse-agent (public)
- **Release:** the latest release on the repository's Releases page
- **Demo video:** **TO ADD** (3 minutes, recorded from `DEMO_SCRIPT.md`)

## Bonus prizes it could target

**TO CONFIRM.** The Cerebral Valley event page lists no bonus prizes, and the Official Rules were not linked from it when this was written. One secondary source (aimagazine.blog) mentions bonus prizes of up to $50,000, such as a community vote or most viral project. If those exist:
- **Community vote / most viral:** the one-click demo and the "AI can be fooled; the payment can't" story are easy to share (see `X_POSTS.md`, drafts only).
- Check the official rules or participant portal for any model-specific bonus (for example best use of Muse Spark or of the Meta Model API) before claiming one.

## Deadline

Nov 4, 2026, 9:00 PM ET (6:00 PM PT), per the Cerebral Valley event page.
