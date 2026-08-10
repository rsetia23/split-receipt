import Anthropic from "@anthropic-ai/sdk";
import { createHash, timingSafeEqual } from "node:crypto";

// Vision calls on a big receipt can take longer than the 10s default.
export const config = { maxDuration: 60 };

const MODEL = "claude-haiku-4-5";
const MAX_IMAGE_BYTES = 4_000_000;
const DAILY_LIMIT = Number(process.env.SCAN_DAILY_LIMIT || 200);

// Best-effort ceiling. Serverless instances are ephemeral and can run in
// parallel, so this bounds one warm instance rather than the deployment —
// a backstop against a runaway client loop, not a billing guarantee. The
// passphrase and the size cap are the real controls.
let windowDay = "";
let windowCount = 0;

const SCHEMA = {
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

const SYSTEM = `You read photographs of receipts and return the purchased items.

Rules:
- One entry per purchasable line item, in the order printed.
- "price" is the extended line total (what that line contributed to the bill), never the unit price. A line reading "2 @ 4.12" that totals 8.24 has a price of 8.24.
- Keep the item name close to what is printed, minus leading barcodes, PLU codes, and department numbers. Expand obvious abbreviations only when you are confident.
- A discount or coupon line is an item with a negative price.
- Do NOT include subtotal, tax, tip, total, change, payment method, card digits, auth codes, loyalty numbers, or store contact details as items. Those belong in the dedicated fields, or nowhere.
- Report subtotal, tax, tip, and total only if they are printed and legible. Use null for any that are absent — never infer or compute them.
- If a price is genuinely unreadable, omit that item rather than guessing. A missing line is recoverable; an invented number is not.`;

function hash(value) {
  return createHash("sha256").update(String(value)).digest();
}

function passphraseOk(given, expected) {
  if (!given || !expected) return false;
  return timingSafeEqual(hash(given), hash(expected));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  const expected = process.env.SCAN_PASSWORD;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!expected || !apiKey) {
    return res.status(503).json({
      error: "Scanning isn't configured on this deployment yet.",
    });
  }

  if (!passphraseOk(req.headers["x-split-pass"], expected)) {
    return res.status(401).json({ error: "That passphrase isn't right." });
  }

  const day = new Date().toISOString().slice(0, 10);
  if (day !== windowDay) {
    windowDay = day;
    windowCount = 0;
  }
  if (windowCount >= DAILY_LIMIT) {
    return res.status(429).json({
      error: "Daily scan limit reached. Try again tomorrow, or enter the items by hand.",
    });
  }

  const body = req.body || {};
  const image = typeof body.image === "string" ? body.image : "";
  const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: "Send a base64 JPEG, PNG, or WebP data URL as `image`." });
  }

  const mediaType = match[1];
  const data = match[2];
  if (data.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: "That image is too large. Crop tighter and try again." });
  }

  windowCount += 1;

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: MODEL,
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
      return res.status(422).json({ error: "The model declined to read that image." });
    }
    if (message.stop_reason === "max_tokens") {
      return res.status(422).json({ error: "That receipt was too long to read in one pass. Crop to part of it." });
    }

    const text = message.content.find((b) => b.type === "text")?.text;
    if (!text) {
      return res.status(502).json({ error: "The model returned nothing readable." });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "The model's response wasn't valid JSON." });
    }

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return res.status(200).json({
      items: items
        .filter((i) => i && typeof i.name === "string" && Number.isFinite(i.price))
        .map((i) => ({ name: i.name.slice(0, 60), price: i.price })),
      subtotal: Number.isFinite(parsed.subtotal) ? parsed.subtotal : null,
      tax: Number.isFinite(parsed.tax) ? parsed.tax : null,
      tip: Number.isFinite(parsed.tip) ? parsed.tip : null,
      total: Number.isFinite(parsed.total) ? parsed.total : null,
      usage: {
        input_tokens: message.usage?.input_tokens ?? null,
        output_tokens: message.usage?.output_tokens ?? null,
      },
    });
  } catch (err) {
    const status = err?.status;
    if (status === 401) return res.status(503).json({ error: "The server's API key was rejected." });
    if (status === 429) return res.status(429).json({ error: "Rate limited upstream. Try again in a moment." });
    return res.status(502).json({ error: "Couldn't reach the reader. Try again, or scan offline." });
  }
}
