import { GoogleGenAI } from "@google/genai";

// One schema-constrained JSON call, two providers. Everything feature-specific
// (prompts, schemas, validation) lives in _readers.js / _assist.js so that a
// comparison between engines is a comparison of models, not of prompts.

export const ENGINES = {
  gemini: { label: "Gemini Flash", key: "gemini", model: process.env.GEMINI_MODEL || "gemini-2.5-flash" },
};

export class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- Google ------------------------------------------------------------------

// Google retires model ids on its own schedule, so a hardcoded default goes
// stale — and pushing that chore onto the user just relocates it. When the
// configured id 404s we ask the key what it can call and work down that list,
// remembering the replacement per warm instance, only after a success.
let resolvedGeminiModel = null;

async function listGeminiModels(apiKey) {
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(apiKey),
  );
  if (!r.ok) return [];
  const json = await r.json();
  return (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name || "").replace(/^models\//, ""));
}

export function rankGeminiModels(names) {
  const version = (n) => {
    const m = n.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };
  // Vision-capable general models only, best first: full Flash, then Flash
  // Lite, then Pro. Within a tier, a plain id beats a dated or preview one,
  // and a newer version beats an older.
  const tier = (n) =>
    /flash/i.test(n) ? (/lite/i.test(n) ? 1 : 0) : /pro/i.test(n) && !/vision/i.test(n) ? 2 : 3;
  const stable = (n) => (/preview|exp|\d{4}/i.test(n) ? 1 : 0);
  return names
    .filter((n) => !/embedding|aqa|tts|image|audio|native|live|thinking/i.test(n))
    .filter((n) => tier(n) < 3)
    .slice()
    .sort(
      (a, b) =>
        tier(a) - tier(b) || stable(a) - stable(b) || version(b) - version(a) || a.length - b.length,
    );
}

export function pickGeminiModel(names) {
  return rankGeminiModels(names)[0] || null;
}

function geminiParts(parts) {
  return parts.map((p) =>
    p.type === "image" ? { inlineData: { mimeType: p.mediaType, data: p.data } } : { text: p.text },
  );
}

async function callGeminiOnce({ ai, model, system, schema, parts }) {
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: geminiParts(parts) }],
    config: {
      systemInstruction: system,
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    },
  });

  // `.text` is a convenience getter; fall back to walking the candidate parts
  // so an SDK change doesn't silently produce an empty result.
  let text = typeof response.text === "string" ? response.text : null;
  if (!text) {
    text = (response.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text)
      .filter(Boolean)
      .join("");
  }
  if (!text) throw new ProviderError(502, "The model returned nothing readable.");

  const usage = response.usageMetadata || {};
  return {
    text,
    model,
    usage: {
      input_tokens: usage.promptTokenCount ?? null,
      output_tokens: usage.candidatesTokenCount ?? null,
    },
  };
}

// Overload ("503 This model is currently experiencing high demand") is per
// model and usually passes within seconds, so a busy model gets one short
// retry and then the request moves down this chain instead of failing. A 429
// skips the retry: free-tier quotas are per model per minute, so waiting a
// second won't help but another model might. GEMINI_FALLBACK_MODELS is an
// optional hand-written chain; left empty, the key's own model list is used
// instead, which is the only source that can't name a model the key lacks.
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// No new attempt starts after this long. The worst case is this plus one
// full attempt (35 + 15 = 50s), inside the routes' 60s maxDuration. At 40s a
// live scan finished at 54s — too close to a hard kill. The budget covers
// every chain in one request, including the second pass over the key's own
// model list — measured from the request, not from each chain, or two passes
// double it and Vercel kills the function instead.
const RETRY_WINDOW_MS = 35_000;
// The SDK sets no request timeout and does not retry unless asked, so a call
// that never comes back blocks until the platform kills the whole function.
// That happened in production: 60s, no answer, nothing logged. Each attempt is
// now bounded, and a timeout is just another busy model to step past.
const ATTEMPT_TIMEOUT_MS = 15_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls `callOnce(model)` down `models` until one succeeds. A 404 on the first
 * model is thrown at once so the caller can look up a replacement, unless
 * `skip404` says the list itself came from the key; a 404 further down is
 * skipped without replacing the earlier, more telling error.
 */
export async function tryModels(
  models,
  callOnce,
  { pause = wait, now = Date.now, skip404 = false, deadline = now() + RETRY_WINDOW_MS } = {},
) {
  let lastErr;
  for (const [index, model] of models.entries()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (lastErr && now() > deadline) throw lastErr;
      try {
        return await callOnce(model);
      } catch (err) {
        const status = Number(err?.status);
        if (status === 404 && (skip404 || index > 0)) {
          if (!lastErr) lastErr = err;
          break;
        }
        lastErr = err;
        if (!TRANSIENT.has(status)) throw err;
        // 429: the quota is per model, so waiting won't refill it. 504: the
        // model already spent a whole attempt not answering, and a second
        // try usually costs the same again. Both move straight on.
        if (status === 429 || status === 504 || attempt === 1) break;
        await pause(700 + Math.random() * 800);
      }
    }
  }
  throw lastErr;
}

async function callGemini({ apiKey, model, system, schema, parts }) {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: ATTEMPT_TIMEOUT_MS } });
  const started = Date.now();
  const callOnce = async (m) => {
    try {
      return await callGeminiOnce({ ai, model: m, system, schema, parts });
    } catch (err) {
      const aborted = err?.name === "AbortError" || /abort|timed? ?out/i.test(String(err?.message || ""));
      // One line per failed attempt: the summary line only names the model
      // that finally answered, which can't explain where 50 seconds went.
      const shown = Number(err?.status) || (aborted ? "timeout" : "?");
      console.log("[gemini] %s → %s at %dms", m, shown, Date.now() - started);
      // An aborted fetch carries no HTTP status, so it would otherwise read as
      // a permanent failure and stop the chain.
      if (aborted && !Number(err?.status)) {
        throw new ProviderError(504, m + " did not answer within " + ATTEMPT_TIMEOUT_MS / 1000 + "s.");
      }
      throw err;
    }
  };
  const first = resolvedGeminiModel || model;
  const tried = [first, ...FALLBACK_MODELS.filter((m) => m !== first)];
  const deadline = Date.now() + RETRY_WINDOW_MS;

  try {
    return await tryModels(tried, callOnce, { deadline });
  } catch (err) {
    const status = Number(err?.status);
    // Two different failures, one answer. A 404 means the configured id is
    // gone; a 503 or 429 means everything we already knew about is busy.
    // Either way, ask the key what it can call today and work down that list —
    // a hardcoded fallback can name a model the key doesn't have, and this
    // can't. Anything else (a bad request, a rejected key) is the caller's.
    if (status !== 404 && !TRANSIENT.has(status)) throw err;
    if (Date.now() > deadline) throw err;

    let available = [];
    try {
      available = await listGeminiModels(apiKey);
    } catch {
      /* keep the original failure — the lookup is a bonus, not the point */
    }
    const chain = rankGeminiModels(available)
      .filter((m) => !tried.includes(m))
      .slice(0, 3);

    if (!chain.length) {
      if (status !== 404) throw err;
      throw new ProviderError(
        503,
        'Gemini model "' + first + '" is not available on this key.' +
          (available.length
            ? " Available: " + available.slice(0, 8).join(", ")
            : " Check the model list in Google AI Studio."),
      );
    }

    const result = await tryModels(chain, callOnce, { skip404: true, deadline });
    // Only a retired model is worth remembering. An overloaded one will be
    // back shortly, and pinning this instance to a fallback would outlast the
    // spike that caused it.
    if (status === 404) resolvedGeminiModel = result.model;
    console.log("[gemini] %s failed with %s; using %s", first, status || "?", result.model);
    return result;
  }
}

// --- dispatch ----------------------------------------------------------------

const IMPL = { gemini: callGemini };

export async function generateJSON({ engine, keys, system, schema, parts, maxTokens = 4096 }) {
  const spec = ENGINES[engine];
  if (!spec) throw new ProviderError(400, "Unknown engine.");

  const apiKey = keys[spec.key];
  if (!apiKey) throw new ProviderError(503, spec.label + " isn't configured on this deployment.");

  const result = await IMPL[engine]({ apiKey, model: spec.model, system, schema, parts, maxTokens });

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new ProviderError(502, "The model's response wasn't valid JSON.");
  }
  return { parsed, engine, model: result.model, usage: result.usage };
}
