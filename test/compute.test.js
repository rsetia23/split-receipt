import test from "node:test";
import assert from "node:assert/strict";
import { compute } from "../js/compute.js";

// compute() is a pure function of state, so these import it directly — no
// browser, no jsdom, no source slicing.

const person = (id, name) => ({ id, name });
const item = (id, name, price, shared) => ({ id, name, price, shared });

function stateOf(items, people, tax = 0, tip = 0) {
  return {
    people,
    items,
    tax: { mode: "amt", value: tax },
    tip: { mode: "amt", value: tip },
    open: {},
  };
}

test("splits an item evenly among its sharers", () => {
  const r = compute(
    stateOf(
      [item("1", "Pizza", 30, ["a", "b", "c"])],
      [person("a", "A"), person("b", "B"), person("c", "C")],
    ),
  );
  assert.equal(r.totals.a, 10);
  assert.equal(r.totals.b, 10);
  assert.equal(r.totals.c, 10);
});

test("allocates tax and tip in proportion to each subtotal", () => {
  // A has 75 of a 100 subtotal, so A carries 75% of the 20 in tax+tip.
  const r = compute(
    stateOf(
      [item("1", "Steak", 75, ["a"]), item("2", "Salad", 25, ["b"])],
      [person("a", "A"), person("b", "B")],
      10,
      10,
    ),
  );
  assert.equal(r.assigned, 100);
  assert.equal(r.extra, 20);
  assert.equal(r.totals.a, 90);
  assert.equal(r.totals.b, 30);
});

test("per-person totals sum to the exact bill (largest remainder)", () => {
  // The original main.py case: naive rounding gave 176.51 against a 176.52 bill.
  const all = ["a", "b", "c"];
  const r = compute(
    stateOf(
      [
        item("1", "Bounty", 31.34, all),
        item("2", "Cascade", 15.39, all),
        item("3", "TP", 23.09, all),
        item("4", "Toilet Cleaner", 8.24, all),
        item("5", "Tide", 27.49, ["a", "b"]),
        item("6", "GY", 8.24, ["a"]),
        item("7", "Milk", 2.83, ["a"]),
        item("8", "Eggs", 9.12, ["a"]),
        item("9", "Vodka", 24.39, all),
      ],
      [person("a", "Rahul"), person("b", "Smyan"), person("c", "Arjun")],
      18.88,
      7.51,
    ),
  );

  const sum = r.ids.reduce((s, id) => s + r.totals[id], 0);
  assert.equal(Number(sum.toFixed(2)), 176.52);
  assert.equal(r.totals.a, 80.05);
  assert.equal(r.totals.b, 56.32);
  assert.equal(r.totals.c, 40.15);
});

test("percentage tax and tip are computed off the subtotal", () => {
  const r = compute(
    stateOf([item("1", "Meal", 100, ["a"])], [person("a", "A")]),
  );
  const pct = compute({
    ...stateOf([item("1", "Meal", 100, ["a"])], [person("a", "A")]),
    tax: { mode: "pct", value: 10 },
    tip: { mode: "pct", value: 20 },
  });
  assert.equal(r.grand, 100);
  assert.equal(pct.tax, 10);
  assert.equal(pct.tip, 20);
  assert.equal(pct.grand, 130);
});

test("an item nobody shares is excluded and flagged", () => {
  const r = compute(
    stateOf(
      [item("1", "Mine", 10, ["a"]), item("2", "Orphan", 99, [])],
      [person("a", "A")],
    ),
  );
  assert.equal(r.assigned, 10);
  assert.equal(r.orphans.length, 1);
  assert.equal(r.orphans[0].name, "Orphan");
  assert.equal(
    r.itemsTotal,
    109,
    "itemsTotal still counts it, so the gap is visible",
  );
});

test("with no people at all, nothing is an orphan yet", () => {
  const r = compute(stateOf([item("1", "Thing", 10, [])], []));
  assert.equal(r.orphans.length, 0);
  assert.equal(r.grand, 0);
});

test("a sharer who was deleted is ignored", () => {
  const r = compute(
    stateOf([item("1", "Shared", 10, ["a", "ghost"])], [person("a", "A")]),
  );
  assert.equal(r.totals.a, 10, "price divides among surviving sharers only");
});

// -- bill-level discount ---------------------------------------------------

const discounted = (items, people, discount, tax = 0, tip = 0) => ({
  ...stateOf(items, people, tax, tip),
  discount,
});

test("a bill-level discount comes off in proportion to what each person ordered", () => {
  // A ordered 75 of the 100, so A absorbs 75% of the 20 off.
  const r = compute(
    discounted(
      [item("1", "Steak", 75, ["a"]), item("2", "Salad", 25, ["b"])],
      [person("a", "A"), person("b", "B")],
      { mode: "amt", value: 20 },
    ),
  );
  assert.equal(r.discount, 20);
  assert.equal(r.base, 80);
  assert.equal(r.grand, 80);
  assert.equal(r.totals.a, 60);
  assert.equal(r.totals.b, 20);
});

test("a percentage discount is a percentage of the subtotal", () => {
  const r = compute(
    discounted([item("1", "Meal", 82, ["a"])], [person("a", "A")], {
      mode: "pct",
      value: 20,
    }),
  );
  assert.equal(r.discount, 16.4);
  assert.equal(r.base, 65.6);
});

test("percentage tax and tip run off the discounted subtotal", () => {
  const withPct = compute({
    ...discounted([item("1", "Meal", 100, ["a"])], [person("a", "A")], {
      mode: "pct",
      value: 20,
    }),
    tax: { mode: "pct", value: 10 },
    tip: { mode: "pct", value: 20 },
  });
  assert.equal(withPct.base, 80);
  assert.equal(withPct.tax, 8, "10% of 80, not of 100");
  assert.equal(withPct.tip, 16);
  assert.equal(withPct.grand, 104);
});

test("a discount larger than the bill is capped instead of paying people back", () => {
  const r = compute(
    discounted([item("1", "Coffee", 4, ["a"])], [person("a", "A")], {
      mode: "amt",
      value: 50,
    }),
  );
  assert.equal(r.discount, 4);
  assert.equal(r.discountCapped, true);
  assert.equal(r.grand, 0);
  assert.equal(r.totals.a, 0);
});

test("a discount does not disturb the exact-cent rounding", () => {
  const all = ["a", "b", "c"];
  const r = compute(
    discounted(
      [
        item("1", "Bounty", 31.34, all),
        item("2", "Cascade", 15.39, all),
        item("3", "TP", 23.09, all),
        item("4", "Tide", 27.49, ["a", "b"]),
        item("5", "Milk", 2.83, ["a"]),
      ],
      [person("a", "Rahul"), person("b", "Smyan"), person("c", "Arjun")],
      { mode: "pct", value: 15 },
      6.11,
      9.37,
    ),
  );

  const sum = r.ids.reduce((s, id) => s + r.totals[id], 0);
  assert.equal(Number(sum.toFixed(2)), Number(r.grand.toFixed(2)));
});

test("each breakdown adds up to the rounded total beside the name", () => {
  const all = ["a", "b", "c"];
  const r = compute(
    discounted(
      [
        item("1", "Bounty", 31.34, all),
        item("2", "Tide", 27.49, ["a", "b"]),
        item("3", "Milk", 2.83, ["a"]),
      ],
      [person("a", "A"), person("b", "B"), person("c", "C")],
      { mode: "amt", value: 7.77 },
      4.13,
      8.29,
    ),
  );

  r.ids.forEach((id) => {
    const shown = r.subtotals[id] - r.parts[id].discount + r.parts[id].extra;
    assert.equal(
      Number(shown.toFixed(4)),
      r.totals[id],
      "the three printed lines must reconcile to the printed total",
    );
  });
});

test("no discount leaves the parts and the old totals identical", () => {
  const r = compute(
    stateOf(
      [item("1", "Meal", 40, ["a", "b"])],
      [person("a", "A"), person("b", "B")],
      4,
      6,
    ),
  );
  r.ids.forEach((id) => {
    assert.equal(r.parts[id].discount, 0);
    assert.equal(r.parts[id].extra, r.totals[id] - r.subtotals[id]);
  });
});

test("negative prices (discounts) flow through", () => {
  const r = compute(
    stateOf(
      [item("1", "Item", 20, ["a"]), item("2", "Coupon", -5, ["a"])],
      [person("a", "A")],
    ),
  );
  assert.equal(r.totals.a, 15);
});

test("zero subtotal does not divide by zero", () => {
  const r = compute(stateOf([], [person("a", "A")], 5, 5));
  assert.equal(r.shares.a, 0);
  assert.ok(Number.isFinite(r.totals.a));
});

test("line labels show the division that produced each share", () => {
  const r = compute(
    stateOf(
      [item("1", "Bounty", 31.34, ["a", "b", "c"])],
      [person("a", "A"), person("b", "B"), person("c", "C")],
    ),
  );
  assert.equal(r.lines.a[0].label, "Bounty: 31.34/3");
  assert.equal(Number(r.lines.a[0].amount.toFixed(2)), 10.45);
});

test("an item one person had is not divided by one", () => {
  const r = compute(
    stateOf([item("1", "Espresso", 4.5, ["a"])], [person("a", "A")]),
  );
  assert.equal(r.lines.a[0].label, "Espresso: 4.50");
});

test("a card fee is split in proportion, like tax", () => {
  // A has 75 of a 100 subtotal, so A carries 75% of the 4 fee.
  const state = stateOf(
    [item("1", "Steak", 75, ["a"]), item("2", "Salad", 25, ["b"])],
    [person("a", "A"), person("b", "B")],
  );
  state.fee = { mode: "amt", value: 4 };
  const r = compute(state);
  assert.equal(r.fee, 4);
  assert.equal(r.grand, 104);
  assert.equal(r.totals.a, 78);
  assert.equal(r.totals.b, 26);
});

test("a state saved before fees existed computes with no fee", () => {
  const r = compute(stateOf([item("1", "Pizza", 20, ["a"])], [person("a", "A")]));
  assert.equal(r.fee, 0);
  assert.equal(r.grand, 20);
});
