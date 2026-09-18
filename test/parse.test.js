import test from "node:test";
import assert from "node:assert/strict";
import { parseReceipt } from "../js/parse.js";

// The offline scanner's accuracy is this function. OCR text goes in as it
// comes off thermal paper — shouting, ragged spacing, payment noise — and
// what comes out is proposed straight to the user for review.

const names = (r) => r.items.map((i) => i.name);

test("items and printed totals come off a plain receipt", () => {
  const r = parseReceipt([
    "BREAKFAST BURRITO      9.50",
    "ICED LATTE             4.75",
    "SUBTOTAL              14.25",
    "TAX                    1.13",
    "TOTAL                 15.38",
  ].join("\n"));
  assert.deepEqual(r.items, [
    { name: "BREAKFAST BURRITO", price: 9.5, use: true },
    { name: "ICED LATTE", price: 4.75, use: true },
  ]);
  assert.deepEqual(r.found, { tax: 1.13, tip: null, total: 15.38, subtotal: 14.25, discount: null });
});

test("a coupon is a discount, not the total", () => {
  const r = parseReceipt("TOTAL SAVINGS        -5.00\nTOTAL                25.00");
  assert.equal(r.found.discount, 5);
  assert.equal(r.found.total, 25);
  assert.deepEqual(r.items, []);
});

test("only the first discount line is taken", () => {
  const r = parseReceipt("COUPON    -2.00\nPROMO 10% OFF    -3.00");
  assert.equal(r.found.discount, 2);
});

test("a quantity tail is stripped from the name, and the line total kept", () => {
  const r = parseReceipt("ICED LATTE 2 @ 3.25      6.50");
  assert.deepEqual(r.items, [{ name: "ICED LATTE", price: 6.5, use: true }]);
});

test("a leading barcode is dropped", () => {
  assert.deepEqual(names(parseReceipt("0123456 CHOCOLATE CROISSANT   4.25")), ["CHOCOLATE CROISSANT"]);
});

test("payment and store noise never becomes an item", () => {
  const r = parseReceipt([
    "VISA ****4417         33.34",
    "CHANGE DUE             0.66",
    "CASHIER: SAM           1.00",
    "WWW.CORNERDELI.COM",
    "AUTH 004512",
  ].join("\n"));
  assert.deepEqual(r.items, []);
});

test("implausible prices are left out rather than guessed at", () => {
  const r = parseReceipt("WIDE SCREEN THING   2500.00\nFREE SAMPLE     0.00\nREAL ITEM    12.00");
  assert.deepEqual(names(r), ["REAL ITEM"]);
});

test("a label without letters is not an item", () => {
  assert.deepEqual(parseReceipt("12    3.00").items, []);
});

test("a long name is truncated rather than dropped", () => {
  const long = "EXTRA LARGE DELUXE BREAKFAST BURRITO SUPREME WITH EVERYTHING";
  const r = parseReceipt(long + "   9.50");
  assert.equal(r.items.length, 1);
  assert.ok(r.items[0].name.length <= 40);
  assert.ok(long.startsWith(r.items[0].name));
});

test("tip and gratuity are pulled out of the noise", () => {
  const r = parseReceipt("GRATUITY      5.00\nTAX           2.29");
  assert.equal(r.found.tip, 5);
  assert.equal(r.found.tax, 2.29);
});
