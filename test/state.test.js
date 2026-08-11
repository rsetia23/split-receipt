import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { seed, loadState, saveState, loadPhoto, savePhoto, KEY, PHOTO_KEY } from "../js/state.js";

// state.js only touches localStorage, so a bare jsdom window is enough.
function withStorage(fn, { failWrites = false } = {}) {
  const dom = new JSDOM("", { url: "https://split.local/" });
  const real = dom.window.localStorage;
  global.localStorage = failWrites
    ? {
        getItem: (k) => real.getItem(k),
        removeItem: (k) => real.removeItem(k),
        setItem: () => { throw new Error("QuotaExceededError"); },
      }
    : real;
  try {
    return fn(real);
  } finally {
    delete global.localStorage;
    dom.window.close();
  }
}

test("a fresh receipt starts empty", () => {
  const s = seed();
  assert.deepEqual(s.people, []);
  assert.deepEqual(s.items, []);
  assert.equal(s.tax.value, 0);
  assert.equal(s.tip.value, 0);
});

test("round-trips a receipt through storage", () => {
  withStorage(() => {
    const s = seed();
    s.people.push({ id: "a", name: "Rahul" });
    s.items.push({ id: "1", name: "Milk", price: 2.83, shared: ["a"] });
    assert.equal(saveState(s), true);

    const back = loadState();
    assert.equal(back.people[0].name, "Rahul");
    assert.equal(back.items[0].price, 2.83);
  });
});

test("corrupt stored data falls back to a fresh receipt instead of throwing", () => {
  withStorage((real) => {
    real.setItem(KEY, "{not json");
    const s = loadState();
    assert.deepEqual(s.people, []);
  });
});

test("stored data of the wrong shape is rejected", () => {
  withStorage((real) => {
    real.setItem(KEY, JSON.stringify({ people: "not an array" }));
    assert.deepEqual(loadState().people, []);
  });
});

test("a quota failure is reported rather than thrown", () => {
  withStorage(() => {
    assert.equal(saveState(seed()), false, "caller decides what to say");
    assert.equal(savePhoto("data:image/jpeg;base64,AAAA"), false);
  }, { failWrites: true });
});

test("the photo lives under its own key, so it cannot take the receipt down", () => {
  withStorage((real) => {
    const s = seed();
    s.people.push({ id: "a", name: "Rahul" });
    saveState(s);
    savePhoto("data:image/jpeg;base64,AAAA");

    assert.ok(!real.getItem(KEY).includes("data:image"), "receipt key stays free of image data");
    assert.equal(loadPhoto(), "data:image/jpeg;base64,AAAA");
    assert.notEqual(KEY, PHOTO_KEY);
  });
});

test("clearing the photo removes it", () => {
  withStorage(() => {
    savePhoto("data:image/jpeg;base64,AAAA");
    savePhoto(null);
    assert.equal(loadPhoto(), null);
  });
});
