// Persistence only. The receipt and the photo live under separate keys: the
// photo is orders of magnitude bigger, and a quota failure writing it must
// never cost you the receipt itself.

export const KEY = "split.receipt.v2";
export const PHOTO_KEY = "split.photo.v2";

export function seed() {
  return {
    people: [],
    items: [],
    tax: { mode: "amt", value: 0 },
    tip: { mode: "amt", value: 0 },
    discount: { mode: "amt", value: 0 },
    fee: { mode: "amt", value: 0 },
    open: {},
  };
}

export function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    const state = saved && Array.isArray(saved.people) ? saved : seed();
    if (!state.open) state.open = {};
    // Backfilled rather than versioned: a receipt saved before discounts
    // existed is still a valid receipt, and reopening it must not lose it.
    if (!state.discount) state.discount = { mode: "amt", value: 0 };
    if (!state.fee) state.fee = { mode: "amt", value: 0 };
    return state;
  } catch (e) {
    return seed();
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

export function loadPhoto() {
  try {
    return localStorage.getItem(PHOTO_KEY);
  } catch (e) {
    return null;
  }
}

/** Returns false when the photo was too large to persist, so the caller can say so. */
export function savePhoto(photo) {
  try {
    if (photo) localStorage.setItem(PHOTO_KEY, photo);
    else localStorage.removeItem(PHOTO_KEY);
    return true;
  } catch (e) {
    return false;
  }
}
