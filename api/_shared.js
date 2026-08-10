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
  const expected = process.env.SCAN_PASSWORD;
  const keys = {
    anthropic: process.env.ANTHROPIC_API_KEY || null,
    gemini: process.env.GEMINI_API_KEY || null,
  };
  if (!expected || !(keys.anthropic || keys.gemini)) {
    return { status: 503, error: "Scanning isn't configured on this deployment yet." };
  }
  const given = req.headers["x-split-pass"];
  if (!given || !timingSafeEqual(hash(given), hash(expected))) {
    return { status: 401, error: "That passphrase isn't right." };
  }
  return { keys };
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
