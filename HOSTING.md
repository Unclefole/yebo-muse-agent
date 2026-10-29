# Hosting plan: a live link for judges (until Nov 16, 2026)

> **Replay mode is deployed (Oct 29, 2026):** https://yebo-muse-demo-production.up.railway.app
> Railway project `yebo-muse-demo`, separate from Yebo's. One variable: `YEBO_SITE=replay`. No API keys. Live mode is **not** deployed and needs Francis's approval.
> Deployed from a clean `git archive` of `main` with `railway up`. `railway.json` and `.nvmrc` pin the build (`npm ci --include=dev`, `npm start`, Node 22).

The goal is one link judges can open without cloning the repo or bringing a key, kept up until **Nov 16, 2026**, and then switched off.

## What the link shows

The same web app, in one of two hosted modes (`YEBO_SITE`):

| Mode | What a visitor can do | Model calls | Keys on the host | Cost |
|---|---|---|---|---|
| `replay` (start here) | Play back real recorded runs: the 7-invoice catches, the split invoices, and a voice + Muse Spark Open run. Each is labelled as a replay of a real run, with its recording date. | None | None (the server removes any it finds) | Hosting only |
| `live` (optional, later) | The replays, plus live runs of the bundled invoices: the 5 samples, the demo set, or a Controls Lab scenario, with Muse Spark or Muse Spark Open | Yes, behind the limits below | `META_API_KEY` (and optionally `BASETEN_API_KEY`), as host variables | Hosting + capped model spend |

Both modes are always **judge mode** and **dry run**: payments are checked by the built-in stand-in for the Yebo gateway (bound to 127.0.0.1 inside the container), approval is simulated automatically, and the hosted app never talks to the real Yebo gateway. No uploads and no microphone on the hosted demo: visitors can only run the bundled, fictional invoices.

## The limits on live runs (built, tested, in `src/web/hosted.ts`)

- **Keys stay on the server.** They are host variables, never sent to the browser. `/api/config` reports only whether live runs are on and today's spend.
- **Per visitor:** at most `YEBO_LIVE_RUNS_PER_VISITOR_PER_HOUR` live runs an hour (default 3). Behind Railway's or Render's proxy set `YEBO_TRUST_PROXY=true`; the visitor is then the address the proxy itself added (the last `X-Forwarded-For` entry), so a forged header does not reset the count.
- **Hard daily spend cap:** `YEBO_LIVE_DAILY_USD` (default $5, per UTC day). Every model call's reported tokens are priced at the published rates ($1.25 per million input tokens, $0.15 cached, $4.25 output, for both Muse Spark 1.3 and Muse Spark Open). A run may start only if today's spend, plus a reserve for every run still going, plus its own reserve (`YEBO_LIVE_RUN_RESERVE_USD`, default $0.50) stays within the cap. Spend is kept in a file (`YEBO_LIVE_SPEND_FILE`), so a restart does not reset it; if that file cannot be read, live runs stop for the day.
- **At most two runs at once** (`YEBO_LIVE_MAX_CONCURRENT`).
- **Each run is bounded:** at most 10 bundled invoices, 8 planning turns, a 200-character instruction.
- **Off switch:** `YEBO_LIVE=off` turns live runs off; the replays keep working. Removing `META_API_KEY` does the same.

**How hard is "hard"?** The cap is checked before each run starts, with a reserve held for every run in progress. A run could only push the day over the cap if it cost more than its $0.50 reserve. Measured runs cost $0.07 to $0.09. The provider's own bill is the final word: use a **separate Meta API key just for this demo**, so it can be revoked on its own.

## Recommended setup

**Phase 1, now: replay only, free.**

- **Render free web service** (recommended for replay): $0. 750 free instance hours a month. It spins down after 15 minutes without traffic and takes about a minute to wake, which is acceptable for a replay. Its disk is temporary, which does not matter for replays.
- Or **Railway**, as a new project separate from Yebo's: about 0.1 GB of memory for this small Node server, roughly $1 a month at Railway's $10 per GB-month. The Free plan's $1 monthly credit may just cover it; a Hobby plan ($5 a month including $5 of usage) covers it with room to spare.

**Phase 2, only if you want live runs: Railway with a volume.**

- Live runs need the spend file to survive restarts, so the hard cap holds. Render's free tier has temporary disk only, and it resets whenever the service spins down, so it is **not** suitable for live runs. Railway volumes persist (0.5 GB on Free and Trial, 5 GB on Hobby).
- Mount a volume (for example at `/data`) and set `YEBO_LIVE_SPEND_FILE=/data/live-spend.json`.

## Cost estimate (to Nov 16)

| Item | Estimate |
|---|---|
| Hosting, replay only (Render free) | $0 |
| Hosting, Railway | about $1 a month for this service; covered by a Hobby plan's included $5 |
| Model spend per live run | **measured** Oct 27: $0.089 for the 7-invoice demo set on Muse Spark 1.3 (11 calls, 29.4k input tokens of which 24.3k cached, 18.5k output); $0.065 on Muse Spark Open; $0.073 for a 6-invoice Controls Lab scenario. The 10-invoice split scenario is probably about $0.12 (not measured). |
| Model spend, realistic | 50 to 150 judge runs in total: about **$5 to $15** |
| Model spend, worst case | the cap every day. At $5 a day for 12 days (Nov 4 to Nov 16): **$60**. At $2 a day: **$24**. Recommended: start at `YEBO_LIVE_DAILY_USD=2` and raise it only if judges hit it. |

Prices checked on Oct 27, 2026: dev.meta.ai/docs/pricing-rate-limits, baseten.co/pricing, render.com/docs/free, docs.railway.com/reference/pricing/plans. Neither Meta's nor Baseten's pricing page mentions a spending limit, which is why the app enforces its own.

## Steps (replay: done Oct 29; live: not done)

1. Create the service from the GitHub repo `Unclefole/yebo-muse-agent`, branch `main`.
2. Build: `npm ci --include=dev` (the server runs through `tsx`, a dev dependency). Start: `npm start` (`npm run web`). Node 22. `railway.json` and `.nvmrc` set these.
3. Variables for replay: `YEBO_SITE=replay`. That's all; no keys.
4. Variables for live (later): `YEBO_SITE=live`, `YEBO_TRUST_PROXY=true`, `YEBO_LIVE_DAILY_USD=2`, `YEBO_LIVE_SPEND_FILE=/data/live-spend.json`, `YEBO_TODAY=2026-11-02` (so "this week" matches the demo), and a **new, demo-only** `META_API_KEY` (optional `BASETEN_API_KEY` for Open mode). Never `YEBO_HMAC_SECRET`, never `YEBO_EXECUTION_LIVE`. The hosted mode ignores the HMAC secret and always runs judge mode, but it should not be on the host at all.
5. Open the link: the badge reads *Replays · no API calls* (or *Hosted demo · judge mode*), and the footer says it is a hosted demo, dry run.

## How to shut it off

- **Stop live runs, keep the replays:** set `YEBO_LIVE=off` (Railway and Render restart the service with the new variable), or delete `META_API_KEY`.
- **Stop all spending at once:** revoke the demo-only Meta API key (and the Baseten key) in the providers' consoles. Live runs then fail; replays keep working.
- **Take the link down (Nov 16):** delete the service (Railway: Settings → Delete service; Render: Settings → Delete web service). Nothing else depends on it: the repo, the release and the real Yebo gateway are untouched.
