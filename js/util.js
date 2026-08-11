// Small helpers with no state and no DOM dependency beyond `el`.

export const PALETTE = ["var(--p1)", "var(--p2)", "var(--p3)", "var(--p4)", "var(--p5)", "var(--p6)"];

export function uid() {
  return Math.random().toString(36).slice(2, 9);
}

export function money(n) {
  return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
}

/** Parse a user-typed amount, tolerating currency symbols and stray text. */
export function num(v) {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : 0;
}

/** Case- and whitespace-insensitive key for matching person names. */
export function nameKey(n) {
  return String(n || "").trim().toLowerCase();
}

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
