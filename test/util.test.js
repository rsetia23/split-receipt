import test from "node:test";
import assert from "node:assert/strict";
import { money, num, nameKey, uid, PALETTE } from "../js/util.js";

test("money formats with a leading sign, not a minus inside", () => {
  assert.equal(money(0), "$0.00");
  assert.equal(money(10.5), "$10.50");
  assert.equal(money(-4.2), "-$4.20");
  assert.equal(money(1234.567), "$1234.57");
});

test("num tolerates what people actually type", () => {
  assert.equal(num("12.34"), 12.34);
  assert.equal(num("$12.34"), 12.34);
  assert.equal(num(" 12.34 "), 12.34);
  assert.equal(num("-5"), -5);
  assert.equal(num(""), 0, "empty is zero, never NaN");
  assert.equal(num("abc"), 0);
  assert.equal(num(undefined), 0);
  assert.equal(num(null), 0);
});

test("nameKey matches names case- and whitespace-insensitively", () => {
  assert.equal(nameKey("Rahul"), nameKey(" rahul "));
  assert.notEqual(nameKey("Rahul"), nameKey("Raul"));
  assert.equal(nameKey(null), "");
  assert.equal(nameKey(undefined), "");
});

test("uid produces distinct ids", () => {
  const ids = new Set(Array.from({ length: 500 }, uid));
  assert.equal(ids.size, 500);
});

test("palette has six distinct colours", () => {
  assert.equal(PALETTE.length, 6);
  assert.equal(new Set(PALETTE).size, 6);
});
