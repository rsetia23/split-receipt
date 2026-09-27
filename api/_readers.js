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
          name: {
            type: "string",
            description:
              "The item name as printed, cleaned of barcodes and item codes.",
          },
          price: {
            type: "number",
            description:
              "The extended line total in dollars, not the unit price.",
          },
        },
        required: ["name", "price"],
        additionalProperties: false,
      },
    },
    subtotal: { anyOf: [{ type: "number" }, { type: "null" }] },
    discount: {
      description:
        "A check-wide discount, coupon, or promotion, as a positive number of dollars taken off.",
      anyOf: [{ type: "number" }, { type: "null" }],
    },
    tax: { anyOf: [{ type: "number" }, { type: "null" }] },
    tip: { anyOf: [{ type: "number" }, { type: "null" }] },
    fee: {
      description:
        "A card surcharge or non-cash adjustment added on top of the item prices, in dollars.",
      anyOf: [{ type: "number" }, { type: "null" }],
    },
    total: { anyOf: [{ type: "number" }, { type: "null" }] },
  },
  required: ["items", "subtotal", "discount", "tax", "tip", "fee", "total"],
  additionalProperties: false,
};

export const SYSTEM = `You read photographs of receipts and return the purchased items.

Rules:
- One entry per purchasable line item, in the order printed.
- "price" is the extended line total (what that line contributed to the bill), never the unit price. A line reading "2 @ 4.12" that totals 8.24 has a price of 8.24.
- Keep the item name close to what is printed, minus leading barcodes, PLU codes, and department numbers. Expand obvious abbreviations only when you are confident.
- Write names in Title Case, not the receipt's usual all-caps: "BOUNTY PAPER TOWELS" becomes "Bounty Paper Towels". Preserve casing that is genuinely part of the name — acronyms and short codes stay upper ("TP", "GY"), brands keep their own form ("iPhone", "McDonald's"), and unit suffixes stay as printed ("92OZ").
- A discount that applies to the whole check — a coupon, a promotion, "20% OFF", a comped amount — goes in "discount" as a positive number of dollars taken off, not as an item. If several such lines are printed, report their sum.
- A discount attached to one specific line item stays with that item: either as the item's own negative-priced line, exactly as printed, or folded into that item's price if the receipt already shows it net.
- Do NOT include subtotal, tax, tip, fee, total, change, payment method, card digits, auth codes, loyalty numbers, or store contact details as items. Those belong in the dedicated fields, or nowhere.
- Report subtotal, discount, tax, tip, fee, and total only if they are printed and legible. Use null for any that are absent — never infer or compute them.
- Some receipts print two prices for the same bill — "Total (Cash)" and "Total (Non-cash)", "Cash Price" and "Card Price", or a total plus a "non-cash adjustment" or "card surcharge". Report exactly one set, the one that was actually paid: look at the tender lines near the bottom (card brand, last four digits, "CASH", change given). If no tender is shown, use the non-cash (card) figures. Take subtotal, tax, and total all from that same set — never mix a cash subtotal with a card total. A non-cash adjustment or surcharge line is not an item.
- If the items are priced at the cash price and the paid (card) total adds a separate surcharge, service fee for card use, or non-cash adjustment on top, report that amount in "fee" as a positive number of dollars. Leave "fee" null when the item prices already include it, when cash was paid, or when no such line is printed.
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
      .filter(
        (i) => i && typeof i.name === "string" && Number.isFinite(i.price),
      )
      .map((i) => ({ name: titleCase(i.name).slice(0, 60), price: i.price })),
    subtotal: numberOrNull(parsed.subtotal),
    // Receipts print discounts as negatives and models copy that faithfully;
    // the field's meaning is "amount taken off", so the sign is stripped here
    // rather than left for the client to guess at.
    discount: Number.isFinite(parsed.discount) ? Math.abs(parsed.discount) : null,
    tax: numberOrNull(parsed.tax),
    tip: numberOrNull(parsed.tip),
    fee: Number.isFinite(parsed.fee) ? Math.abs(parsed.fee) : null,
    total: numberOrNull(parsed.total),
    usage,
  };
}
