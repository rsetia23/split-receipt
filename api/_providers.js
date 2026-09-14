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
// stale — and pushing that chore onto the user just relocates it. On a 404 we
// ask the key what it can call, pick a stable vision-capable Flash model, and
// retry once. Cached per warm instance, and only after a success.
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

export function pickGeminiModel(names) {
  const version = (n) => {
    const m = n.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };
  const usable = names.filter(
    (n) => /flash/i.test(n) && !/embedding|aqa|tts|image|audio|native|live|thinking|lite/i.test(n),
  );
  const ranked = (usable.length ? usable : names.filter((n) => /pro/i.test(n) && !/vision/i.test(n)))
    .slice()
    .sort((a, b) => {
      const stable = (n) => (/preview|exp|\d{4}/i.test(n) ? 1 : 0);
      return stable(a) - stable(b) || version(b) - version(a) || a.length - b.length;
    });
  return ranked[0] || null;
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
// second won't help but another model might. Fallbacks missing from the key
// are skipped, so a retired id here costs one quick 404, not an outage.
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash-lite,gemini-flash-latest")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// No new attempt starts after this long, so the chain fits inside the route's
// maxDuration (30s for assign, 60s for scan) with room for the final call.
const RETRY_WINDOW_MS = 20_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls `callOnce(model)` down `models` until one succeeds. A 404 on the first
 * model is thrown at once so the caller can look up a replacement; a 404 on a
 * fallback is skipped without replacing the earlier, more telling error.
 */
export async function tryModels(models, callOnce, { pause = wait, windowMs = RETRY_WINDOW_MS, now = Date.now } = {}) {
  const started = now();
  let lastErr;
  for (const [index, model] of models.entries()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (lastErr && now() - started > windowMs) throw lastErr;
      try {
        return await callOnce(model);
      } catch (err) {
        const status = Number(err?.status);
        if (status === 404 && index > 0) break;
        lastErr = err;
        if (!TRANSIENT.has(status)) throw err;
        if (status === 429 || attempt === 1) break;
        await pause(700 + Math.random() * 800);
      }
    }
  }
  throw lastErr;
}

async function callGemini({ apiKey, model, system, schema, parts }) {
  const ai = new GoogleGenAI({ apiKey });
  const first = resolvedGeminiModel || model;
  const chain = [first, ...FALLBACK_MODELS.filter((m) => m !== first)];
  try {
    const result = await tryModels(chain, (m) => callGeminiOnce({ ai, model: m, system, schema, parts }));
    if (result.model !== first) console.log("[gemini] %s busy; answered by %s", first, result.model);
    return result;
  } catch (err) {
    if (Number(err?.status) !== 404) throw err;

    let available = [];
    try {
      available = await listGeminiModels(apiKey);
    } catch {
      /* fall through */
    }
    const fallback = pickGeminiModel(available);
    if (!fallback || fallback === first) {
      throw new ProviderError(
        503,
        'Gemini model "' + first + '" is not available on this key.' +
          (available.length
            ? " Available: " + available.slice(0, 8).join(", ")
            : " Check the model list in Google AI Studio."),
      );
    }

    const result = await callGeminiOnce({ ai, model: fallback, system, schema, parts });
    resolvedGeminiModel = fallback;
    console.log("[gemini] %s unavailable; using %s", first, fallback);
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
