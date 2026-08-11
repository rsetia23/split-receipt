import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

// One prompt and one schema for every provider, so a comparison between them
// is a comparison of the models rather than of two different prompts.

export const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description: "One entry per purchasable line item on the receipt.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The item name as printed, cleaned of barcodes and item codes." },
          price: { type: "number", description: "The extended line total in dollars, not the unit price." },
        },
        required: ["name", "price"],
        additionalProperties: false,
      },
    },
    subtotal: { anyOf: [{ type: "number" }, { type: "null" }] },
    tax: { anyOf: [{ type: "number" }, { type: "null" }] },
    tip: { anyOf: [{ type: "number" }, { type: "null" }] },
    total: { anyOf: [{ type: "number" }, { type: "null" }] },
  },
  required: ["items", "subtotal", "tax", "tip", "total"],
  additionalProperties: false,
};

export const SYSTEM = `You read photographs of receipts and return the purchased items.

Rules:
- One entry per purchasable line item, in the order printed.
- "price" is the extended line total (what that line contributed to the bill), never the unit price. A line reading "2 @ 4.12" that totals 8.24 has a price of 8.24.
- Keep the item name close to what is printed, minus leading barcodes, PLU codes, and department numbers. Expand obvious abbreviations only when you are confident.
- A discount or coupon line is an item with a negative price.
- Do NOT include subtotal, tax, tip, total, change, payment method, card digits, auth codes, loyalty numbers, or store contact details as items. Those belong in the dedicated fields, or nowhere.
- Report subtotal, tax, tip, and total only if they are printed and legible. Use null for any that are absent — never infer or compute them.
- If a price is genuinely unreadable, omit that item rather than guessing. A missing line is recoverable; an invented number is not.`;

export const ENGINES = {
  claude: { label: "Claude Haiku", key: "anthropic", model: process.env.CLAUDE_MODEL || "claude-haiku-4-5" },
  gemini: { label: "Gemini Flash", key: "gemini", model: process.env.GEMINI_MODEL || "gemini-2.5-flash" },
};

class ReaderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export { ReaderError };

async function readWithClaude({ apiKey, model, mediaType, data }) {
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data } },
          { type: "text", text: "Read this receipt." },
        ],
      },
    ],
  });

  if (message.stop_reason === "refusal") {
    throw new ReaderError(422, "The model declined to read that image.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new ReaderError(422, "That receipt was too long to read in one pass. Crop to part of it.");
  }

  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new ReaderError(502, "The model returned nothing readable.");
  return {
    text,
    usage: {
      input_tokens: message.usage?.input_tokens ?? null,
      output_tokens: message.usage?.output_tokens ?? null,
    },
  };
}

// Google retires model ids on its own schedule, so any hardcoded default goes
// stale — and asking the user to chase the new name just moves the chore. On a
// 404 we ask the key what it can actually call, pick a vision-capable Flash
// model, and retry once. The choice is cached per warm instance.
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

function pickGeminiModel(names) {
  const version = (n) => {
    const m = n.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };
  // Flash is the cost/latency point this app wants; exclude the variants that
  // aren't general vision models, and prefer plain ids over dated previews.
  const usable = names.filter(
    (n) =>
      /flash/i.test(n) &&
      !/embedding|aqa|tts|image|audio|native|live|thinking|lite/i.test(n),
  );
  const ranked = (usable.length ? usable : names.filter((n) => /pro/i.test(n) && !/vision/i.test(n)))
    .slice()
    .sort((a, b) => {
      const stable = (n) => (/preview|exp|\d{4}/i.test(n) ? 1 : 0);
      return (
        stable(a) - stable(b) ||
        version(b) - version(a) ||
        a.length - b.length
      );
    });
  return ranked[0] || null;
}

async function readWithGemini({ apiKey, model, mediaType, data }) {
  const ai = new GoogleGenAI({ apiKey });
  const first = resolvedGeminiModel || model;
  try {
    return { ...(await callGemini({ ai, model: first, mediaType, data })), model: first };
  } catch (err) {
    if (Number(err?.status) !== 404) throw err;

    let available = [];
    try {
      available = await listGeminiModels(apiKey);
    } catch {
      /* fall through to the error below */
    }
    const fallback = pickGeminiModel(available);
    if (!fallback || fallback === first) {
      throw new ReaderError(
        503,
        'Gemini model "' + first + '" is not available on this key.' +
          (available.length
            ? " Available: " + available.slice(0, 8).join(", ")
            : " Check the model list in Google AI Studio."),
      );
    }

    const result = { ...(await callGemini({ ai, model: fallback, mediaType, data })), model: fallback };
    resolvedGeminiModel = fallback; // only cache a model that actually worked
    console.log("[gemini] %s unavailable; using %s", first, fallback);
    return result;
  }
}

async function callGemini({ ai, model, mediaType, data }) {
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: mediaType, data } },
          { text: "Read this receipt." },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: "application/json",
      responseJsonSchema: SCHEMA,
    },
  });

  // `.text` is a convenience getter; fall back to walking the candidate parts
  // so an SDK change doesn't silently produce an empty read.
  let text = typeof response.text === "string" ? response.text : null;
  if (!text) {
    text = (response.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text)
      .filter(Boolean)
      .join("");
  }
  if (!text) throw new ReaderError(502, "The model returned nothing readable.");

  const usage = response.usageMetadata || {};
  return {
    text,
    usage: {
      input_tokens: usage.promptTokenCount ?? null,
      output_tokens: usage.candidatesTokenCount ?? null,
    },
  };
}

const IMPL = { claude: readWithClaude, gemini: readWithGemini };

export async function readReceipt({ engine, keys, mediaType, data }) {
  const spec = ENGINES[engine];
  if (!spec) throw new ReaderError(400, "Unknown reader.");

  const apiKey = keys[spec.key];
  if (!apiKey) {
    throw new ReaderError(503, spec.label + " isn't configured on this deployment.");
  }

  const called = await IMPL[engine]({ apiKey, model: spec.model, mediaType, data });
  const { text, usage } = called;
  const modelUsed = called.model || spec.model;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReaderError(502, "The model's response wasn't valid JSON.");
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const numberOrNull = (v) => (Number.isFinite(v) ? v : null);
  return {
    engine,
    model: modelUsed,
    items: items
      .filter((i) => i && typeof i.name === "string" && Number.isFinite(i.price))
      .map((i) => ({ name: i.name.slice(0, 60), price: i.price })),
    subtotal: numberOrNull(parsed.subtotal),
    tax: numberOrNull(parsed.tax),
    tip: numberOrNull(parsed.tip),
    total: numberOrNull(parsed.total),
    usage,
  };
}
