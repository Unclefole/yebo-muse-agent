// Voice: WAV checks, the Muse Voice Transcribe request shape (mocked), and transcript cleanup.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkWav, cleanTranscript, transcribe, VOICE_MODEL } from "../src/voice.js";

const SAMPLE = readFileSync("demo/voice/pay-this-weeks-invoices.wav");
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function wav({ rate = 16000, channels = 1, bits = 16, format = 1, samples = 1600 } = {}): Buffer {
  const dataBytes = samples * channels * (bits / 8);
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0); b.writeUInt32LE(36 + dataBytes, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(format, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * (bits / 8), 28); b.writeUInt16LE(channels * (bits / 8), 32); b.writeUInt16LE(bits, 34);
  b.write("data", 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}

test("checkWav accepts what the API takes and explains what it refuses", () => {
  assert.deepEqual(checkWav(SAMPLE), { sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: checkWav(SAMPLE).durationMs });
  assert.ok(checkWav(SAMPLE).durationMs > 1000);
  assert.equal(checkWav(wav({ rate: 24000 })).sampleRate, 24000);
  assert.throws(() => checkWav(Buffer.from("not audio at all, definitely not a wav file header")), /not a WAV/);
  assert.throws(() => checkWav(wav({ channels: 2 })), /mono/);
  assert.throws(() => checkWav(wav({ rate: 44100 })), /16 kHz or 24 kHz/);
  assert.throws(() => checkWav(wav({ bits: 8 })), /16-bit PCM/);
  assert.throws(() => checkWav(wav({ samples: 0 })), /empty/);
});

test("transcribe sends the documented multipart request and returns the transcript", async () => {
  process.env.META_API_KEY = "test-key";
  process.env.META_API_BASE = "https://api.meta.test/v1";
  type Sent = { url: string; headers: Record<string, string>; settings: any; audio: Blob | null };
  const captured: { sent?: Sent } = {};
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    captured.sent = {
      url,
      headers: init.headers as Record<string, string>,
      settings: JSON.parse(await (form.get("request") as Blob).text()),
      audio: form.get("audio") as Blob | null,
    };
    return new Response(JSON.stringify({ sessionId: "s", transcript: "pay this week's invoices.。", audioDurationMs: 1600, turns: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  assert.equal(await transcribe(SAMPLE), "Pay this week's invoices.");
  const s = captured.sent;
  assert.ok(s);
  assert.equal(s.url, "https://api.meta.test/v1/asr/transcribe");
  assert.equal(s.headers.Authorization, "Bearer test-key");
  assert.deepEqual(s.settings, { model: VOICE_MODEL, audioEncoding: "WAV", mode: "PUSH_TO_TALK", languageBias: ["English"] });
  assert.equal(s.audio?.type, "audio/wav");
  assert.equal(s.audio?.size, SAMPLE.length);
});

test("transcribe refuses a bad clip before uploading and reports API errors", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("busy", { status: 429 });
  }) as unknown as typeof fetch;
  await assert.rejects(transcribe(wav({ channels: 2 })), /mono/);
  assert.equal(calls, 0);
  await assert.rejects(transcribe(SAMPLE), /Muse Voice Transcribe 429/);
});

test("cleanTranscript: one capitalised sentence with a single full stop", () => {
  assert.equal(cleanTranscript("pay this week's invoices.."), "Pay this week's invoices.");
  assert.equal(cleanTranscript("  pay the overdue ones 。 "), "Pay the overdue ones.");
  assert.equal(cleanTranscript("..."), "");
});
