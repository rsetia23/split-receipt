import { num } from "./util.js";

/**
 * OCR text in, candidate rows out. Pure, and separated from the UI so it can
 * be tested directly: the offline scanner's accuracy lives or dies here, and
 * every rule below was added because a real receipt broke without it.
 */
var NOISE = /(sub\s*-?\s*total|total|balance|amount\s+due|tax|tip|gratuity|change|cash|debit|credit|visa|master|amex|discover|card\b|acct|account|auth|approv|\bref\b|tender|payment|savings|coupon|discount|promo|loyalty|member|reward|points|thank|welcome|receipt|invoice|survey|cashier|register|server|table|guest|\bqty\b|items? sold|item count|www\.|\.com|http|store\s*#|tel\b|phone)/i;
var DISCOUNT = /discount|coupon|promo|savings|\bcomp(ed|limentary)?\b|\d\s*%\s*off|\boff\b/i;
var PRICE_AT_END = /(-?\$?\s*\d{1,4}[.,]\d{2})\s*[A-Za-z]{0,2}$/;

function toNumber(raw) {
  return num(String(raw).replace(/[^0-9.,\-]/g, "").replace(",", "."));
}

export function parseReceipt(text) {
  var lines = text.split(/\r?\n/);
  var items = [], found = { tax: null, tip: null, total: null, subtotal: null, discount: null };

  lines.forEach(function (rawLine) {
    var line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length < 4) return;

    var m = line.match(PRICE_AT_END);
    if (!m) return;
    var price = toNumber(m[1]);
    var label = line.slice(0, m.index).trim();

    if (NOISE.test(line)) {
      // Pull the useful totals out of the lines we're otherwise ignoring.
      // Discount first: "COUPON" lines get printed as a negative, and the
      // total-ish words below would otherwise claim a line like
      // "TOTAL SAVINGS -5.00". Stored positive — the sign is the field's job.
      if (DISCOUNT.test(line) && found.discount === null) found.discount = Math.abs(price);
      else if (/\btips?\b|gratuity/i.test(line) && found.tip === null) found.tip = price;
      else if (/\btax\b/i.test(line) && !/taxable/i.test(line) && found.tax === null) found.tax = price;
      else if (/sub\s*-?\s*total/i.test(line) && found.subtotal === null) found.subtotal = price;
      else if (/total/i.test(line)) found.total = price;
      return;
    }

    label = label
      .replace(/^\d{5,}\s*/, "")            // leading barcode / PLU
      .replace(/\s*\d+\s*@\s*[\d.,]+$/, "") // "2 @ 1.99" tail
      .replace(/[\s.\-–—:*_]+$/, "")
      .replace(/^[\s.\-–—:*_]+/, "")
      .trim();

    if ((label.match(/[A-Za-z]/g) || []).length < 2) return;
    if (!(price > 0) || price > 2000) return;

    items.push({
      name: label.length > 40 ? label.slice(0, 40).trim() : label,
      price: price,
      use: true
    });
  });

  return { items: items, found: found, raw: text };
}
