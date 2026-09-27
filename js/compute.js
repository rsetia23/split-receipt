import { num } from "./util.js";

/**
 * The whole split, derived from state. Pure: same state in, same result out,
 * no DOM and no storage — which is what makes it testable on its own.
 *
 * Each item is divided evenly among the people sharing it. A bill-level
 * discount, then tax and tip, are allocated in proportion to what each person's
 * items came to — as is a card surcharge, which scales with the bill the
 * same way tax does — and per-person totals are rounded by largest remainder so the
 * shares sum to the exact bill rather than drifting a cent.
 */
export function compute(state) {
  const ids = state.people.map((p) => p.id);
  const subtotals = {};
  const lines = {};
  ids.forEach((id) => {
    subtotals[id] = 0;
    lines[id] = [];
  });

  state.items.forEach((it) => {
    const sharers = it.shared.filter((id) => ids.indexOf(id) !== -1);
    if (!sharers.length) return;
    const each = num(it.price) / sharers.length;
    sharers.forEach((id) => {
      subtotals[id] += each;
      lines[id].push({
        // The divisor only earns its place when it actually divided something:
        // "12.00/1" reads as a question rather than an explanation.
        label: (it.name || "Item") + ": " + num(it.price).toFixed(2) +
          (sharers.length > 1 ? "/" + sharers.length : ""),
        amount: each,
      });
    });
  });

  const itemsTotal = state.items.reduce((s, it) => s + num(it.price), 0);
  const assigned = ids.reduce((s, id) => s + subtotals[id], 0);

  // A discount comes off the whole check before anything else, and cannot take
  // the bill past zero: a coupon bigger than the food is a typo, not a refund.
  // It is capped rather than rejected so the number you typed stays on screen
  // next to a note saying what was actually used.
  const asked = state.discount
    ? state.discount.mode === "pct"
      ? (assigned * num(state.discount.value)) / 100
      : num(state.discount.value)
    : 0;
  const discount = Math.max(0, Math.min(asked, assigned));
  const discountCapped = asked > assigned + 1e-9;

  // Percentage tax and tip run off what's left after the discount — the base
  // the register itself charges tax on.
  const base = assigned - discount;
  const tax = state.tax.mode === "pct" ? (base * num(state.tax.value)) / 100 : num(state.tax.value);
  const tip = state.tip.mode === "pct" ? (base * num(state.tip.value)) / 100 : num(state.tip.value);
  // Receipts print a card surcharge in dollars, so it has no percentage mode.
  // Read defensively: a state built before fees existed has no such key.
  const fee = state.fee ? num(state.fee.value) : 0;
  const extra = tax + tip + fee;
  const adjust = extra - discount;

  const totals = {};
  const shares = {};
  ids.forEach((id) => {
    shares[id] = assigned > 0 ? subtotals[id] / assigned : 0;
    totals[id] = subtotals[id] + shares[id] * adjust;
  });

  // Largest-remainder rounding: whoever is closest to the next cent gets it,
  // so the per-person cents add up to the printed bill.
  const grand = Math.round((assigned + adjust) * 100);
  const cents = ids.map((id) => {
    const raw = totals[id] * 100;
    return { id, floor: Math.floor(raw), frac: raw - Math.floor(raw) };
  });
  const placed = cents.reduce((s, c) => s + c.floor, 0);
  const left = grand - placed;
  cents
    .slice()
    .sort((x, y) => y.frac - x.frac)
    .forEach((c, i) => {
      c.extraCent = i < left ? 1 : 0;
    });
  const rounded = {};
  cents.forEach((c) => {
    rounded[c.id] = (c.floor + (c.extraCent || 0)) / 100;
  });

  // The three numbers a person's breakdown prints under their items. The
  // rounding is absorbed into the tax+tip line so that, whatever it did,
  // subtotal − discount + tax+tip is exactly the total shown beside the name.
  const parts = {};
  ids.forEach((id) => {
    const off = shares[id] * discount;
    parts[id] = { discount: off, extra: rounded[id] - subtotals[id] + off };
  });

  // An item nobody shares is excluded from the total and flagged, so a
  // data-entry mistake surfaces instead of silently vanishing. With no people
  // at all there is nothing to have gone wrong yet.
  const orphans = ids.length
    ? state.items.filter((it) => !it.shared.filter((id) => ids.indexOf(id) !== -1).length)
    : [];

  return {
    ids,
    subtotals,
    lines,
    shares,
    parts,
    totals: rounded,
    assigned,
    itemsTotal,
    discount,
    discountCapped,
    base,
    tax,
    tip,
    fee,
    extra,
    adjust,
    grand: assigned + adjust,
    orphans,
  };
}
