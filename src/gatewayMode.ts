// Picks where payments are checked:
//   live   the real Yebo gateway (YEBO_GATEWAY_URL), when YEBO_HMAC_SECRET is set
//   judge  a local stand-in (src/judge/gateway.ts), when YEBO_HMAC_SECRET is empty or
//          YEBO_MODE=judge, so anyone can run this repo with only a Meta API key
// In judge mode the agent's client (src/yebo.ts) runs unchanged against the local
// gateway with a random per-run secret.

import { randomBytes } from "node:crypto";
import { JudgeGateway } from "./judge/gateway.js";

export type GatewayMode = { mode: "live" | "judge"; url: string; stop: () => Promise<void> };

export async function startGateway(): Promise<GatewayMode> {
  const forced = (process.env.YEBO_MODE ?? "").toLowerCase();
  if (forced && forced !== "judge" && forced !== "live") throw new Error(`YEBO_MODE must be "judge" or "live", not "${forced}"`);
  const live = forced === "live" || (forced !== "judge" && !!process.env.YEBO_HMAC_SECRET);

  if (live) {
    if (!process.env.YEBO_HMAC_SECRET) throw new Error("YEBO_MODE=live needs YEBO_HMAC_SECRET");
    const url = process.env.YEBO_GATEWAY_URL || "https://gateway.yebo.dev";
    return { mode: "live", url, stop: async () => {} };
  }

  const secret = randomBytes(32).toString("hex");
  const judge = new JudgeGateway({
    secret,
    port: Number(process.env.YEBO_JUDGE_PORT ?? 4400),
    autoApprove: process.env.YEBO_JUDGE_AUTO_APPROVE === "true",
  });
  const url = await judge.start();
  process.env.YEBO_GATEWAY_URL = url;
  process.env.YEBO_HMAC_SECRET = secret;
  return { mode: "judge", url, stop: () => judge.stop() };
}

export function modeBanner(g: GatewayMode): string {
  return g.mode === "judge"
    ? `JUDGE MODE: payments are checked by a local stand-in for the Yebo gateway (${g.url}).\n` +
        "Same mission rules; approval is simulated on a local page (no passkey). Dry run: no money moves."
    : `LIVE MODE: payments are checked by the Yebo gateway (${g.url}). Dry run: no money moves.`;
}
