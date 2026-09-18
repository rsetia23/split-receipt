// The model chain is the difference between a busy model and a failed scan,
// so it is tested against a fake caller rather than the live API: every
// failure below (404, 429, 503, a call that never answers) has happened in
// production, and none of them are reproducible on demand.
import test from "node:test";
import assert from "node:assert/strict";
import { tryModels, rankGeminiModels } from "../api/_providers.js";
import { upstreamDetail } from "../api/_shared.js";

const fail = (status) => Object.assign(new Error("status " + status), { status });
const noPause = () => Promise.resolve();

// script: { model: [outcome, ...] } where outcome is a status or "ok"
function fake(script) {
  const calls = [];
  const callOnce = async (model) => {
    calls.push(model);
    const next = script[model].shift();
    if (next === "ok") return { model };
    throw fail(next);
  };
  return { calls, callOnce };
}

test("busy primary retries once, then falls back", async () => {
  const { calls, callOnce } = fake({ a: [503, 503], b: ["ok"] });
  const r = await tryModels(["a", "b"], callOnce, { pause: noPause });
  assert.equal(r.model, "b");
  assert.deepEqual(calls, ["a", "a", "b"]);
});

test("a single blip on the primary is absorbed by the retry", async () => {
  const { calls, callOnce } = fake({ a: [503, "ok"], b: [] });
  const r = await tryModels(["a", "b"], callOnce, { pause: noPause });
  assert.equal(r.model, "a");
  assert.deepEqual(calls, ["a", "a"]);
});

test("429 skips the same-model retry", async () => {
  const { calls, callOnce } = fake({ a: [429], b: ["ok"] });
  await tryModels(["a", "b"], callOnce, { pause: noPause });
  assert.deepEqual(calls, ["a", "b"]);
});

test("404 on the primary throws at once for model lookup", async () => {
  const { calls, callOnce } = fake({ a: [404], b: ["ok"] });
  await assert.rejects(tryModels(["a", "b"], callOnce, { pause: noPause }), { status: 404 });
  assert.deepEqual(calls, ["a"]);
});

test("404 on a fallback is skipped and the overload error is reported", async () => {
  const { calls, callOnce } = fake({ a: [503, 503], b: [404], c: [503, 503] });
  await assert.rejects(tryModels(["a", "b", "c"], callOnce, { pause: noPause }), { status: 503 });
  assert.deepEqual(calls, ["a", "a", "b", "c", "c"]);
});

test("a model that timed out is not retried", async () => {
  // 504 is what a 15s timeout becomes; a second try would cost another 15s
  const { calls, callOnce } = fake({ a: [504], b: ["ok"] });
  const r = await tryModels(["a", "b"], callOnce, { pause: noPause });
  assert.equal(r.model, "b");
  assert.deepEqual(calls, ["a", "b"]);
});

test("a bad request is not retried", async () => {
  const { calls, callOnce } = fake({ a: [400], b: ["ok"] });
  await assert.rejects(tryModels(["a", "b"], callOnce, { pause: noPause }), { status: 400 });
  assert.deepEqual(calls, ["a"]);
});

test("stops starting attempts once the budget is spent", async () => {
  let t = 0;
  const { calls, callOnce } = fake({ a: [503, 503], b: ["ok"] });
  const slow = async (m) => { t += 15_000; return callOnce(m); };
  await assert.rejects(tryModels(["a", "b"], slow, { pause: noPause, deadline: 20_000, now: () => t }), { status: 503 });
  assert.deepEqual(calls, ["a", "a"]);
});

test("a deadline shared by two chains is not refreshed by the second", async () => {
  let t = 0;
  const now = () => t;
  const deadline = 20_000;
  const first = fake({ a: [503, 503] });
  const slow = async (m) => { t += 12_000; return first.callOnce(m); };
  await assert.rejects(tryModels(["a"], slow, { pause: noPause, deadline, now }), { status: 503 });
  // second pass, same deadline: the budget is already gone, so one attempt at most
  const second = fake({ b: [503, 503], c: ["ok"] });
  const slow2 = async (m) => { t += 12_000; return second.callOnce(m); };
  await assert.rejects(tryModels(["b", "c"], slow2, { pause: noPause, deadline, now, skip404: true }), { status: 503 });
  assert.deepEqual(second.calls, ["b"]);
});

test("skip404 keeps going when a discovered model 404s", async () => {
  const { calls, callOnce } = fake({ a: [404], b: ["ok"] });
  const r = await tryModels(["a", "b"], callOnce, { pause: noPause, skip404: true });
  assert.equal(r.model, "b");
  assert.deepEqual(calls, ["a", "b"]);
});

test("skip404 with every model missing still throws the 404", async () => {
  const { callOnce } = fake({ a: [404], b: [404] });
  await assert.rejects(tryModels(["a", "b"], callOnce, { pause: noPause, skip404: true }), { status: 404 });
});

test("ranking prefers newest plain Flash, then Lite, then Pro", () => {
  const got = rankGeminiModels([
    "gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.8-pro", "gemini-3.8-flash-lite",
    "gemini-embedding-001", "gemini-3.8-flash-preview-09-2026", "imagen-4.0-generate",
  ]);
  assert.deepEqual(got, [
    "gemini-3.8-flash", "gemini-2.5-flash", "gemini-3.8-flash-preview-09-2026",
    "gemini-3.8-flash-lite", "gemini-3.8-pro",
  ]);
});

test("ranking drops non-text and specialty models", () => {
  assert.deepEqual(rankGeminiModels(["gemini-embedding-001", "gemini-live-2.5", "veo-3"]), []);
});

test("upstreamDetail extracts the human message", () => {
  const raw = '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}';
  assert.equal(upstreamDetail(new Error(raw)), "This model is currently experiencing high demand.");
  assert.equal(upstreamDetail(new Error("got status: 503. " + raw)), "This model is currently experiencing high demand.");
  assert.equal(upstreamDetail(new Error("fetch failed")), "fetch failed");
});
