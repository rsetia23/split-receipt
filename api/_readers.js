import { generateJSON } from "./_providers.js";

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
- Write names in Title Case, not the receipt's usual all-caps: "BOUNTY PAPER TOWELS" becomes "Bounty Paper Towels". Preserve casing that is genuinely part of the name — acronyms and short codes stay upper ("TP", "GY"), brands keep their own form ("iPhone", "McDonald's"), and unit suffixes stay as printed ("92OZ").
- A discount or coupon line is an item with a negative price.
- Do NOT include subtotal, tax, tip, total, change, payment method, card digits, auth codes, loyalty numbers, or store contact details as items. Those belong in the dedicated fields, or nowhere.
- Report subtotal, tax, tip, and total only if they are printed and legible. Use null for any that are absent — never infer or compute them.
- If a price is genuinely unreadable, omit that item rather than guessing. A missing line is recoverable; an invented number is not.`;

/**
 * Safety net for when the model ignores the Title Case instruction. Fires only
 * on names that are entirely uppercase — the receipt-shouting case — and only
 * on purely alphabetic words of four letters or more. That deliberately leaves
 * "TP", "GY", "92OZ", and anything the model already cased alone, because a
 * regex has no idea which short tokens are acronyms and which are words.
 */
export function titleCase(name) {
  const s = String(name).trim();
  if (/[a-z]/.test(s)) return s; // already cased by the model — don't touch it
  return s.replace(/\S+/g, (word) =>
    /^[A-Z]{4,}$/.test(word) ? word[0] + word.slice(1).toLowerCase() : word,
  );
}

export async function readReceipt({ engine, keys, mediaType, data }) {
  const { parsed, model, usage } = await generateJSON({
    engine,
    keys,
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 8192,
    parts: [
      { type: "image", mediaType, data },
      { type: "text", text: "Read this receipt." },
    ],
  });

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const numberOrNull = (v) => (Number.isFinite(v) ? v : null);
  return {
    engine,
    model,
    items: items
      .filter((i) => i && typeof i.name === "string" && Number.isFinite(i.price))
      .map((i) => ({ name: titleCase(i.name).slice(0, 60), price: i.price })),
    subtotal: numberOrNull(parsed.subtotal),
    tax: numberOrNull(parsed.tax),
    tip: numberOrNull(parsed.tip),
    total: numberOrNull(parsed.total),
    usage,
  };
}
