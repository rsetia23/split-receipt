import { createHash, timingSafeEqual } from "node:crypto";

// Files prefixed with _ are not routed by Vercel, so this stays a helper.

function hash(value) {
  return createHash("sha256").update(String(value)).digest();
}

/**
 * Returns { apiKey } when the caller is allowed through, or { status, error }
 * describing exactly how they failed. Compared over SHA-256 digests so the
 * comparison is constant-time regardless of passphrase length.
 */
export function authorize(req) {
  const keys = { gemini: process.env.GEMINI_API_KEY || null };
  if (!keys.gemini) {
    return { status: 503, error: "Scanning isn't configured on this deployment yet." };
  }
  // The passphrase is optional: enforced only while SCAN_PASSWORD is set. On a
  // free key the gate protects a daily quota rather than a bill, so it stays
  // off by default — set the variable again the day a paid key is attached.
  const expected = process.env.SCAN_PASSWORD;
  if (expected) {
    const given = req.headers["x-split-pass"];
    if (!given || !timingSafeEqual(hash(given), hash(expected))) {
      return { status: 401, error: "That passphrase isn't right." };
    }
  }
  return { keys };
}

/**
 * The Gemini SDK puts the raw JSON error body in `message`. Pull out the human
 * sentence so the client doesn't show `{"error":{"code":503,...}}` verbatim.
 */
export function upstreamDetail(err) {
  const raw = String(err?.message || err || "");
  const start = raw.indexOf("{");
  if (start !== -1) {
    try {
      const msg = JSON.parse(raw.slice(start))?.error?.message;
      if (typeof msg === "string" && msg) return msg.slice(0, 400);
    } catch {
      /* not JSON — use it as is */
    }
  }
  return raw.slice(0, 400);
}

/**
 * Best-effort daily ceiling. Serverless instances are ephemeral and can run in
 * parallel, so this bounds one warm instance rather than the deployment — a
 * backstop against a runaway client loop, not a billing guarantee.
 */
export function makeDailyLimiter(limit) {
  let day = "";
  let count = 0;
  return function consume() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      count = 0;
    }
    if (count >= limit) return false;
    count += 1;
    return true;
  };
}
