(() => {
  // js/util.js
  var PALETTE = ["var(--p1)", "var(--p2)", "var(--p3)", "var(--p4)", "var(--p5)", "var(--p6)"];
  function uid() {
    return Math.random().toString(36).slice(2, 9);
  }
  function money(n) {
    return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
  }
  function num(v) {
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
    return isFinite(n) ? n : 0;
  }
  function nameKey(n) {
    return String(n || "").trim().toLowerCase();
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // js/state.js
  var KEY = "split.receipt.v2";
  var PHOTO_KEY = "split.photo.v2";
  function seed() {
    return {
      people: [],
      items: [],
      tax: { mode: "amt", value: 0 },
      tip: { mode: "amt", value: 0 },
      discount: { mode: "amt", value: 0 },
      open: {}
    };
  }
  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      const state2 = saved && Array.isArray(saved.people) ? saved : seed();
      if (!state2.open) state2.open = {};
      if (!state2.discount) state2.discount = { mode: "amt", value: 0 };
      return state2;
    } catch (e) {
      return seed();
    }
  }
  function saveState(state2) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state2));
      return true;
    } catch (e) {
      return false;
    }
  }
  function loadPhoto() {
    try {
      return localStorage.getItem(PHOTO_KEY);
    } catch (e) {
      return null;
    }
  }
  function savePhoto(photo2) {
    try {
      if (photo2) localStorage.setItem(PHOTO_KEY, photo2);
      else localStorage.removeItem(PHOTO_KEY);
      return true;
    } catch (e) {
      return false;
    }
  }

  // js/compute.js
  function compute(state2) {
    const ids = state2.people.map((p) => p.id);
    const subtotals = {};
    const lines = {};
    ids.forEach((id) => {
      subtotals[id] = 0;
      lines[id] = [];
    });
    state2.items.forEach((it) => {
      const sharers = it.shared.filter((id) => ids.indexOf(id) !== -1);
      if (!sharers.length) return;
      const each = num(it.price) / sharers.length;
      sharers.forEach((id) => {
        subtotals[id] += each;
        lines[id].push({
          // The divisor only earns its place when it actually divided something:
          // "12.00/1" reads as a question rather than an explanation.
          label: (it.name || "Item") + ": " + num(it.price).toFixed(2) + (sharers.length > 1 ? "/" + sharers.length : ""),
          amount: each
        });
      });
    });
    const itemsTotal = state2.items.reduce((s, it) => s + num(it.price), 0);
    const assigned = ids.reduce((s, id) => s + subtotals[id], 0);
    const asked = state2.discount ? state2.discount.mode === "pct" ? assigned * num(state2.discount.value) / 100 : num(state2.discount.value) : 0;
    const discount = Math.max(0, Math.min(asked, assigned));
    const discountCapped = asked > assigned + 1e-9;
    const base = assigned - discount;
    const tax = state2.tax.mode === "pct" ? base * num(state2.tax.value) / 100 : num(state2.tax.value);
    const tip = state2.tip.mode === "pct" ? base * num(state2.tip.value) / 100 : num(state2.tip.value);
    const extra = tax + tip;
    const adjust = extra - discount;
    const totals = {};
    const shares = {};
    ids.forEach((id) => {
      shares[id] = assigned > 0 ? subtotals[id] / assigned : 0;
      totals[id] = subtotals[id] + shares[id] * adjust;
    });
    const grand = Math.round((assigned + adjust) * 100);
    const cents = ids.map((id) => {
      const raw = totals[id] * 100;
      return { id, floor: Math.floor(raw), frac: raw - Math.floor(raw) };
    });
    const placed = cents.reduce((s, c) => s + c.floor, 0);
    const left = grand - placed;
    cents.slice().sort((x, y) => y.frac - x.frac).forEach((c, i) => {
      c.extraCent = i < left ? 1 : 0;
    });
    const rounded = {};
    cents.forEach((c) => {
      rounded[c.id] = (c.floor + (c.extraCent || 0)) / 100;
    });
    const parts = {};
    ids.forEach((id) => {
      const off = shares[id] * discount;
      parts[id] = { discount: off, extra: rounded[id] - subtotals[id] + off };
    });
    const orphans = ids.length ? state2.items.filter((it) => !it.shared.filter((id) => ids.indexOf(id) !== -1).length) : [];
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
      extra,
      adjust,
      grand: assigned + adjust,
      orphans
    };
  }

  // js/parse.js
  var NOISE = /(sub\s*-?\s*total|total|balance|amount\s+due|tax|tip|gratuity|change|cash|debit|credit|visa|master|amex|discover|card\b|acct|account|auth|approv|\bref\b|tender|payment|savings|coupon|discount|promo|loyalty|member|reward|points|thank|welcome|receipt|invoice|survey|cashier|register|server|table|guest|\bqty\b|items? sold|item count|www\.|\.com|http|store\s*#|tel\b|phone)/i;
  var DISCOUNT = /discount|coupon|promo|savings|\bcomp(ed|limentary)?\b|\d\s*%\s*off|\boff\b/i;
  var PRICE_AT_END = /(-?\$?\s*\d{1,4}[.,]\d{2})\s*[A-Za-z]{0,2}$/;
  function toNumber(raw) {
    return num(String(raw).replace(/[^0-9.,\-]/g, "").replace(",", "."));
  }
  function parseReceipt(text) {
    var lines = text.split(/\r?\n/);
    var items = [], found = { tax: null, tip: null, total: null, subtotal: null, discount: null };
    lines.forEach(function(rawLine) {
      var line = rawLine.replace(/\s+/g, " ").trim();
      if (line.length < 4) return;
      var m = line.match(PRICE_AT_END);
      if (!m) return;
      var price = toNumber(m[1]);
      var label = line.slice(0, m.index).trim();
      if (NOISE.test(line)) {
        if (DISCOUNT.test(line) && found.discount === null) found.discount = Math.abs(price);
        else if (/\btips?\b|gratuity/i.test(line) && found.tip === null) found.tip = price;
        else if (/\btax\b/i.test(line) && !/taxable/i.test(line) && found.tax === null) found.tax = price;
        else if (/sub\s*-?\s*total/i.test(line) && found.subtotal === null) found.subtotal = price;
        else if (/total/i.test(line)) found.total = price;
        return;
      }
      label = label.replace(/^\d{5,}\s*/, "").replace(/\s*\d+\s*@\s*[\d.,]+$/, "").replace(/[\s.\-–—:*_]+$/, "").replace(/^[\s.\-–—:*_]+/, "").trim();
      if ((label.match(/[A-Za-z]/g) || []).length < 2) return;
      if (!(price > 0) || price > 2e3) return;
      items.push({
        name: label.length > 40 ? label.slice(0, 40).trim() : label,
        price,
        use: true
      });
    });
    return { items, found, raw: text };
  }

  // js/main.js
  var state = loadState();
  function save() {
    saveState(state);
  }
  var photo = loadPhoto();
  function savePhoto2() {
    if (!savePhoto(photo)) {
      say("Photo is too big to store \u2014 it'll stay until you reload the page.");
    }
  }
  var colorOf = function(id) {
    var i = state.people.findIndex(function(p) {
      return p.id === id;
    });
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  };
  var personById = function(id) {
    return state.people.find(function(p) {
      return p.id === id;
    });
  };
  var nameOf = function(id) {
    var p = personById(id);
    return p ? p.name || "Unnamed" : "?";
  };
  function compute2() {
    return compute(state);
  }
  var peopleList = document.getElementById("peopleList");
  var itemList = document.getElementById("itemList");
  var receipt = document.getElementById("receipt");
  var barTotal = document.getElementById("barTotal");
  var splitEvenBtn = document.getElementById("splitEven");
  function splitEvenlyOn() {
    return !!state.people.length && !!state.items.length && state.items.every(function(it) {
      return state.people.every(function(p) {
        return it.shared.indexOf(p.id) !== -1;
      });
    });
  }
  function renderSplitEven() {
    splitEvenBtn.hidden = !(state.people.length && state.items.length);
    splitEvenBtn.setAttribute("aria-pressed", splitEvenlyOn() ? "true" : "false");
  }
  function renderPeople() {
    renderSplitEven();
    peopleList.textContent = "";
    if (!state.people.length) {
      peopleList.appendChild(el("div", "empty", "Add the people splitting this receipt."));
      return;
    }
    state.people.forEach(function(p) {
      var tag = el("div", "person-tag");
      tag.style.setProperty("--c", colorOf(p.id));
      var input = document.createElement("input");
      input.value = p.name;
      input.setAttribute("aria-label", "Name");
      input.size = Math.max(4, p.name.length);
      input.addEventListener("input", function() {
        p.name = input.value;
        input.size = Math.max(4, input.value.length);
        renderItems();
        renderReceipt();
        save();
      });
      tag.appendChild(input);
      var del = el("button", "icon-btn", "\xD7");
      del.title = "Remove " + p.name;
      del.setAttribute("aria-label", "Remove " + p.name);
      del.addEventListener("click", function() {
        state.people = state.people.filter(function(q) {
          return q.id !== p.id;
        });
        state.items.forEach(function(it) {
          it.shared = it.shared.filter(function(id) {
            return id !== p.id;
          });
        });
        renderAll();
        save();
      });
      tag.appendChild(del);
      peopleList.appendChild(tag);
    });
  }
  function renderItems() {
    renderSplitEven();
    itemList.textContent = "";
    if (!state.items.length) {
      itemList.appendChild(el("div", "empty", state.people.length ? "No items yet \u2014 add the first line off the receipt, or scan it." : "Scan the receipt or add items, then describe who had what."));
      return;
    }
    state.items.forEach(function(it, idx) {
      var row = el("div", "item");
      var sharers = it.shared.filter(function(id) {
        return !!personById(id);
      });
      if (!sharers.length && state.people.length) row.classList.add("orphan");
      var top = el("div", "item-top");
      var name = document.createElement("input");
      name.className = "field field-name";
      name.value = it.name;
      name.placeholder = "Item";
      name.setAttribute("aria-label", "Item name");
      name.addEventListener("input", function() {
        it.name = name.value;
        renderReceipt();
        save();
      });
      name.addEventListener("keydown", function(e) {
        if (e.key === "Enter" && idx === state.items.length - 1) addItem();
      });
      top.appendChild(name);
      var price = document.createElement("input");
      price.className = "field field-price";
      price.type = "text";
      price.inputMode = "decimal";
      price.value = it.price === "" ? "" : Number(it.price).toFixed(2);
      price.placeholder = "0.00";
      price.setAttribute("aria-label", "Price");
      price.addEventListener("input", function() {
        it.price = num(price.value);
        updateNote(row, it);
        renderReceipt();
        save();
      });
      price.addEventListener("blur", function() {
        price.value = Number(num(price.value)).toFixed(2);
      });
      price.addEventListener("focus", function() {
        price.select();
      });
      top.appendChild(price);
      var del = el("button", "icon-btn", "\xD7");
      del.title = "Remove item";
      del.setAttribute("aria-label", "Remove item");
      del.addEventListener("click", function() {
        state.items = state.items.filter(function(x) {
          return x.id !== it.id;
        });
        renderItems();
        renderReceipt();
        save();
      });
      top.appendChild(del);
      row.appendChild(top);
      var chips = el("div", "chiprow");
      state.people.forEach(function(p) {
        var on = it.shared.indexOf(p.id) !== -1;
        var chip = el("button", "chip", p.name || "Unnamed");
        chip.type = "button";
        chip.style.setProperty("--c", colorOf(p.id));
        chip.setAttribute("aria-pressed", on ? "true" : "false");
        chip.addEventListener("click", function() {
          var i = it.shared.indexOf(p.id);
          if (i === -1) it.shared.push(p.id);
          else it.shared.splice(i, 1);
          chip.setAttribute("aria-pressed", i === -1 ? "true" : "false");
          row.classList.toggle("orphan", !it.shared.filter(function(id) {
            return !!personById(id);
          }).length);
          updateNote(row, it);
          renderSplitEven();
          renderReceipt();
          save();
        });
        chips.appendChild(chip);
      });
      if (state.people.length) {
        var all = el("button", "chip chip-all");
        all.type = "button";
        all.textContent = "Everyone";
        all.addEventListener("click", function() {
          var everyone = state.people.length && state.people.every(function(p) {
            return it.shared.indexOf(p.id) !== -1;
          });
          it.shared = everyone ? [] : state.people.map(function(p) {
            return p.id;
          });
          renderItems();
          renderReceipt();
          save();
        });
        chips.appendChild(all);
      }
      var note = el("span", "split-note");
      chips.appendChild(note);
      row.appendChild(chips);
      itemList.appendChild(row);
      updateNote(row, it);
    });
  }
  function updateNote(row, it) {
    var note = row.querySelector(".split-note");
    if (!note) return;
    var n = it.shared.filter(function(id) {
      return !!personById(id);
    }).length;
    if (!n) {
      note.textContent = state.people.length ? "unassigned" : "";
      note.classList.toggle("warn", !!state.people.length);
    } else {
      note.classList.remove("warn");
      note.textContent = n > 1 ? money(num(it.price) / n) + " each" : "";
    }
  }
  function renderCharges() {
    ["tax", "tip", "discount"].forEach(function(k) {
      var input = document.querySelector('[data-charge="' + k + '"]');
      if (document.activeElement !== input) {
        input.value = state[k].value === 0 ? "" : String(state[k].value);
      }
      input.placeholder = state[k].mode === "pct" ? "0" : "0.00";
      document.querySelectorAll('[data-mode^="' + k + ':"]').forEach(function(b) {
        b.setAttribute("aria-pressed", b.dataset.mode === k + ":" + state[k].mode ? "true" : "false");
      });
    });
  }
  function pctLabel(k) {
    return state[k].mode === "pct" ? " (" + num(state[k].value) + "%)" : "";
  }
  function allocLabel(r, id, amount) {
    return "(" + r.subtotals[id].toFixed(2) + "/" + r.assigned.toFixed(2) + ") * " + amount.toFixed(2);
  }
  function renderReceipt() {
    var r = compute2();
    receipt.textContent = "";
    var head = el("div", "receipt-head");
    head.appendChild(el("strong", null, "The damage"));
    head.appendChild(el("span", "eyebrow", state.people.length + (state.people.length === 1 ? " person" : " people")));
    receipt.appendChild(head);
    var tally = el("div", "tally");
    var line = function(label, amount, cls) {
      var row = el("div", "tally-row" + (cls ? " " + cls : ""));
      row.appendChild(el("span", null, label));
      row.appendChild(el("span", "amt", money(amount)));
      tally.appendChild(row);
    };
    line("Subtotal", r.assigned);
    if (r.discount > 0) line("Discount" + pctLabel("discount"), -r.discount, "credit");
    line("Tax" + pctLabel("tax"), r.tax);
    line("Tip" + pctLabel("tip"), r.tip);
    line("Total", r.grand, "total");
    receipt.appendChild(tally);
    if (r.discountCapped) {
      receipt.appendChild(el(
        "div",
        "flag",
        "That discount is bigger than the items, so it's capped at " + money(r.discount) + " \u2014 the bill can't go below zero."
      ));
    }
    if (r.orphans.length) {
      receipt.appendChild(el(
        "div",
        "flag",
        r.orphans.length + (r.orphans.length === 1 ? " item isn't" : " items aren't") + " assigned to anyone, so it's left out of the total."
      ));
    }
    var splits = el("div", "splits");
    if (!r.ids.length) {
      splits.appendChild(el("div", "empty", "Add people to see the split."));
    }
    r.ids.forEach(function(id) {
      var box = el("div", "split");
      box.style.setProperty("--c", colorOf(id));
      var h = el("div", "split-head");
      h.setAttribute("role", "button");
      h.tabIndex = 0;
      var open = !!state.open[id];
      h.setAttribute("aria-expanded", open ? "true" : "false");
      var left = el("div");
      left.appendChild(el("div", "split-name", nameOf(id)));
      left.appendChild(el(
        "div",
        "split-meta",
        r.lines[id].length + (r.lines[id].length === 1 ? " item" : " items") + " \xB7 " + Math.round(r.shares[id] * 100) + "% of " + (r.discount > 0 ? "the extras" : "tax+tip")
      ));
      h.appendChild(left);
      h.appendChild(el("div", "split-amt", money(r.totals[id])));
      var toggle = function() {
        state.open[id] = !state.open[id];
        renderReceipt();
        save();
      };
      h.addEventListener("click", toggle);
      h.addEventListener("keydown", function(e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
      box.appendChild(h);
      if (open) {
        var ul = el("ul", "lines");
        r.lines[id].forEach(function(l) {
          var li = document.createElement("li");
          li.appendChild(el("span", null, l.label));
          li.appendChild(el("span", null, money(l.amount)));
          ul.appendChild(li);
        });
        var sub = document.createElement("li");
        sub.className = "sub";
        sub.appendChild(el("span", null, "subtotal"));
        sub.appendChild(el("span", null, money(r.subtotals[id])));
        ul.appendChild(sub);
        if (r.discount > 0) {
          var disc = document.createElement("li");
          disc.className = "credit";
          disc.appendChild(el("span", null, "discount: " + allocLabel(r, id, r.discount)));
          disc.appendChild(el("span", null, money(-r.parts[id].discount)));
          ul.appendChild(disc);
        }
        var ex = document.createElement("li");
        ex.appendChild(el("span", null, "tax+tip: " + allocLabel(r, id, r.extra)));
        ex.appendChild(el("span", null, money(r.parts[id].extra)));
        ul.appendChild(ex);
        var tot = document.createElement("li");
        tot.className = "grand";
        tot.appendChild(el("span", null, "total"));
        tot.appendChild(el("span", null, money(r.totals[id])));
        ul.appendChild(tot);
        box.appendChild(ul);
      }
      splits.appendChild(box);
    });
    receipt.appendChild(splits);
    var shareRow = el("div", "receipt-foot");
    if (r.ids.length && state.items.length) {
      var shareBtn = el("button", "btn btn-solid", "Share the split");
      shareBtn.type = "button";
      shareBtn.style.width = "100%";
      shareBtn.style.justifyContent = "center";
      shareBtn.addEventListener("click", showShare);
      shareRow.appendChild(shareBtn);
    }
    shareRow.appendChild(el("div", "receipt-thanks", "\u2014 THANK YOU \u2014"));
    receipt.appendChild(shareRow);
    barTotal.textContent = money(r.grand);
    renderTipPresets(r);
  }
  var photoPanel = document.getElementById("photoPanel");
  var photoWrap = document.getElementById("photoWrap");
  function renderPhoto() {
    if (!photo) {
      photoPanel.hidden = true;
      return;
    }
    photoPanel.hidden = false;
    var open = state.photoOpen !== false;
    document.getElementById("photoToggle").textContent = open ? "Hide" : "Show";
    photoWrap.textContent = "";
    if (!open) return;
    var img = document.createElement("img");
    img.className = "photo";
    img.src = photo;
    img.alt = "Your receipt photo \u2014 tap to zoom";
    img.addEventListener("click", openZoom);
    photoWrap.appendChild(img);
    photoWrap.appendChild(el("p", "photo-note", "tap to zoom in"));
  }
  document.getElementById("photoToggle").addEventListener("click", function() {
    state.photoOpen = state.photoOpen === false;
    renderPhoto();
    save();
  });
  document.getElementById("photoRemove").addEventListener("click", function() {
    photo = null;
    savePhoto2();
    renderPhoto();
  });
  function makePhoto(bmp, rect) {
    var r = rect || { x: 0, y: 0, w: bmp.width, h: bmp.height };
    var scale = Math.min(1, 1200 / r.w);
    var cw = Math.round(r.w * scale), ch = Math.round(r.h * scale);
    var c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    var ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
    return c.toDataURL("image/jpeg", 0.72);
  }
  function attachPhoto(bmp, rect) {
    try {
      photo = makePhoto(bmp, rect);
      state.photoOpen = true;
      savePhoto2();
      renderPhoto();
      save();
    } catch (e) {
    }
  }
  var zoom = document.getElementById("zoom");
  var zoomImg = document.getElementById("zoomImg");
  var zoomHint = document.getElementById("zoomHint");
  var zs = 1;
  var zx = 0;
  var zy = 0;
  var pointers = {};
  var pinch = null;
  var panFrom = null;
  var hintTimer;
  function applyZoom() {
    zoomImg.style.transform = "translate(" + zx + "px," + zy + "px) scale(" + zs + ")";
  }
  function resetZoom() {
    zs = 1;
    zx = 0;
    zy = 0;
    applyZoom();
  }
  function openZoom() {
    zoomImg.src = photo;
    zoom.hidden = false;
    document.body.style.overflow = "hidden";
    resetZoom();
    zoomHint.style.opacity = "1";
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function() {
      zoomHint.style.opacity = "0";
    }, 2600);
  }
  function closeZoom() {
    zoom.hidden = true;
    if (scrim.hidden) document.body.style.overflow = "";
    pointers = {};
    pinch = null;
    panFrom = null;
  }
  document.getElementById("zoomClose").addEventListener("click", closeZoom);
  zoom.addEventListener("click", function(e) {
    if (e.target === zoom) closeZoom();
  });
  zoom.addEventListener("dblclick", function(e) {
    e.preventDefault();
    resetZoom();
  });
  zoom.addEventListener("wheel", function(e) {
    e.preventDefault();
    var next = Math.min(6, Math.max(1, zs * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    var b = zoomImg.getBoundingClientRect();
    var px = e.clientX - b.left, py = e.clientY - b.top;
    zx -= px * (next / zs - 1);
    zy -= py * (next / zs - 1);
    zs = next;
    if (zs === 1) {
      zx = 0;
      zy = 0;
    }
    applyZoom();
  }, { passive: false });
  zoom.addEventListener("pointerdown", function(e) {
    if (e.target === zoom) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointers);
    if (ids.length === 2) {
      var a = pointers[ids[0]], b2 = pointers[ids[1]];
      pinch = { d: Math.hypot(a.x - b2.x, a.y - b2.y), s: zs };
      panFrom = null;
    } else {
      panFrom = { x: e.clientX - zx, y: e.clientY - zy };
    }
    zoom.setPointerCapture(e.pointerId);
  });
  zoom.addEventListener("pointermove", function(e) {
    if (!pointers[e.pointerId]) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointers);
    if (pinch && ids.length === 2) {
      var a = pointers[ids[0]], b2 = pointers[ids[1]];
      var d = Math.hypot(a.x - b2.x, a.y - b2.y);
      zs = Math.min(6, Math.max(1, pinch.s * (d / pinch.d)));
      if (zs === 1) {
        zx = 0;
        zy = 0;
      }
      applyZoom();
    } else if (panFrom) {
      zx = e.clientX - panFrom.x;
      zy = e.clientY - panFrom.y;
      applyZoom();
    }
  });
  var dropPointer = function(e) {
    delete pointers[e.pointerId];
    if (Object.keys(pointers).length < 2) pinch = null;
    if (!Object.keys(pointers).length) panFrom = null;
  };
  zoom.addEventListener("pointerup", dropPointer);
  zoom.addEventListener("pointercancel", dropPointer);
  var askRow = document.getElementById("askRow");
  var askInput = document.getElementById("askInput");
  var askBtn = document.getElementById("askBtn");
  function renderAsk() {
    askRow.hidden = !state.items.length;
    askInput.placeholder = state.people.length ? "Who had what? e.g. Arjun and Smyan shared the seafood, we all had dessert" : "Describe the split \u2014 e.g. Rahul got the chicken, Arjun and Smyan shared the seafood";
  }
  function setAskBusy(busy) {
    askRow.classList.toggle("busy", busy);
    askInput.disabled = busy;
    askBtn.disabled = busy;
    askBtn.textContent = busy ? "Reading\u2026" : "Assign";
  }
  function showAssignPreview(instruction, data) {
    openSheet();
    document.getElementById("sheetTitle").textContent = "Who had what";
    sheetBody.textContent = "";
    var newPeople = (data.newPeople || []).filter(function(name) {
      return !state.people.some(function(p) {
        return nameKey(p.name) === nameKey(name);
      });
    });
    var prospectiveColor = function(name) {
      var i = state.people.findIndex(function(p) {
        return nameKey(p.name) === nameKey(name);
      });
      if (i < 0) i = state.people.length + newPeople.indexOf(name);
      return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
    };
    var changes = (data.assignments || []).filter(function(a) {
      var it = state.items[a.item];
      if (!it) return false;
      var next = a.people.map(nameKey).sort();
      var now = it.shared.filter(function(id) {
        return !!personById(id);
      }).map(function(id) {
        return nameKey(nameOf(id));
      }).sort();
      return next.join("\0") !== now.join("\0");
    });
    sheetBody.appendChild(el("p", "scan-hint", "\u201C" + instruction + "\u201D"));
    if (newPeople.length) {
      var add = el("div", "change");
      add.style.borderTop = "0";
      add.style.marginTop = "10px";
      add.appendChild(el("div", "change-name", newPeople.length === 1 ? "New person" : "New people"));
      var names = el("div", "change-who");
      newPeople.forEach(function(name, n) {
        if (n) names.appendChild(document.createTextNode(", "));
        var b = el("b", null, name);
        b.style.color = prospectiveColor(name);
        names.appendChild(b);
      });
      add.appendChild(names);
      sheetBody.appendChild(add);
    }
    if (!changes.length && !newPeople.length) {
      sheetBody.appendChild(el(
        "p",
        "scan-hint",
        data.note || "That didn't change anything. Try naming the people and items more directly."
      ));
    } else if (changes.length) {
      var list = el("div");
      list.style.marginTop = newPeople.length ? "4px" : "14px";
      changes.forEach(function(a) {
        var row = el("div", "change");
        row.appendChild(el("div", "change-name", state.items[a.item].name || "Item"));
        var who = el("div", "change-who");
        if (!a.people.length) {
          who.appendChild(el("span", "none", "nobody"));
        } else {
          a.people.forEach(function(name, n) {
            if (n) who.appendChild(document.createTextNode(", "));
            var b = el("b", null, name);
            b.style.color = prospectiveColor(name);
            who.appendChild(b);
          });
        }
        row.appendChild(who);
        list.appendChild(row);
      });
      sheetBody.appendChild(list);
    }
    var unmatched = (data.unmatched || []).map(function(i) {
      return state.items[i];
    }).filter(Boolean);
    if (unmatched.length) {
      var flag = el("div", "flag");
      flag.textContent = "Left alone: " + unmatched.map(function(i) {
        return i.name || "Item";
      }).join(", ") + " \u2014 say who had these and run it again.";
      sheetBody.appendChild(flag);
    }
    if (data.note && changes.length) {
      sheetBody.appendChild(el("p", "scan-hint", data.note));
    }
    var total = changes.length + newPeople.length;
    var cancel = el("button", "btn", total ? "Cancel" : "Back");
    cancel.type = "button";
    cancel.addEventListener("click", closeSheet);
    var foot = [cancel];
    if (total) {
      var label = changes.length ? "Apply " + changes.length + (changes.length === 1 ? " change" : " changes") : "Add " + newPeople.length + (newPeople.length === 1 ? " person" : " people");
      var apply = el("button", "btn btn-solid", label);
      apply.type = "button";
      apply.addEventListener("click", function() {
        newPeople.forEach(function(name) {
          state.people.push({ id: uid(), name });
        });
        var idFor = function(name) {
          var p = state.people.find(function(q) {
            return nameKey(q.name) === nameKey(name);
          });
          return p ? p.id : null;
        };
        changes.forEach(function(a) {
          var it = state.items[a.item];
          if (!it) return;
          it.shared = a.people.map(idFor).filter(Boolean);
        });
        renderAll();
        renderHints();
        save();
        closeSheet();
        askInput.value = "";
        var said = [];
        if (newPeople.length) said.push("added " + newPeople.length + (newPeople.length === 1 ? " person" : " people"));
        if (changes.length) said.push("assigned " + changes.length + (changes.length === 1 ? " item" : " items"));
        say(said.join(", ").replace(/^./, function(c) {
          return c.toUpperCase();
        }));
      });
      foot.push(apply);
    }
    setFoot(foot);
  }
  async function askAssign() {
    var instruction = askInput.value.trim();
    if (!instruction) return;
    setAskBusy(true);
    var res, body;
    try {
      res = await fetch("/api/assign", {
        method: "POST",
        headers: passHeaders(),
        body: JSON.stringify({
          instruction,
          people: state.people.map(function(p) {
            return p.name || "Unnamed";
          }),
          items: state.items.map(function(it) {
            return {
              name: it.name || "Item",
              price: num(it.price),
              shared: it.shared.filter(function(id) {
                return !!personById(id);
              }).map(function(id) {
                return nameOf(id);
              })
            };
          })
        })
      });
      body = await res.json().catch(function() {
        return {};
      });
    } catch (e) {
      setAskBusy(false);
      say("Couldn't reach the assistant");
      return;
    }
    setAskBusy(false);
    if (res.status === 401) {
      var hadPass = !!scanPass;
      scanPass = null;
      try {
        localStorage.removeItem(PASS_KEY);
      } catch (e) {
      }
      askPassphrase(
        function() {
          closeSheet();
          askAssign();
        },
        hadPass ? "That passphrase wasn't right." : null,
        closeSheet
      );
      return;
    }
    if (!res.ok) {
      say(body.error || "That didn't work");
      return;
    }
    showAssignPreview(instruction, body);
  }
  askRow.addEventListener("submit", function(e) {
    e.preventDefault();
    askAssign();
  });
  function renderAll() {
    renderPeople();
    renderItems();
    renderCharges();
    renderPhoto();
    renderAsk();
    renderReceipt();
  }
  function addItem() {
    state.items.push({
      id: uid(),
      name: "",
      price: 0,
      shared: state.people.map(function(p) {
        return p.id;
      })
    });
    renderItems();
    renderReceipt();
    save();
    var inputs = itemList.querySelectorAll(".field-name");
    if (inputs.length) inputs[inputs.length - 1].focus();
  }
  document.getElementById("addItem").addEventListener("click", addItem);
  splitEvenBtn.addEventListener("click", function() {
    var on = splitEvenlyOn();
    var everyone = state.people.map(function(p) {
      return p.id;
    });
    state.items.forEach(function(it) {
      it.shared = on ? [] : everyone.slice();
    });
    renderItems();
    renderReceipt();
    save();
    say(on ? "Cleared every assignment" : "Every item split across everyone");
  });
  document.getElementById("addPerson").addEventListener("click", function() {
    state.people.push({ id: uid(), name: "Person " + (state.people.length + 1) });
    renderAll();
    save();
    var inputs = peopleList.querySelectorAll("input");
    if (inputs.length) {
      var last = inputs[inputs.length - 1];
      last.focus();
      last.select();
    }
  });
  function startFresh(ask) {
    if (ask && !confirm("Clear every person, item, and charge?")) return false;
    state = seed();
    photo = null;
    savePhoto2();
    renderAll();
    renderHints();
    save();
    return true;
  }
  document.getElementById("clearBtn").addEventListener("click", function() {
    startFresh(true);
  });
  document.querySelectorAll("[data-charge]").forEach(function(input) {
    input.addEventListener("input", function() {
      var k = input.dataset.charge;
      state[k].value = num(input.value);
      renderReceipt();
      renderHints();
      save();
    });
  });
  document.querySelectorAll("[data-mode]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var parts = btn.dataset.mode.split(":");
      state[parts[0]].mode = parts[1];
      renderCharges();
      renderReceipt();
      renderHints();
      save();
    });
  });
  var TIP_PRESETS = [15, 18, 20, 22];
  var tipPresets = document.getElementById("tipPresets");
  function renderTipPresets(r) {
    tipPresets.textContent = "";
    if (!r || !(r.base > 0)) return;
    TIP_PRESETS.forEach(function(pct) {
      var amount = r.base * pct / 100;
      var b = el("button", null, pct + "%");
      b.type = "button";
      b.appendChild(el("span", null, money(amount)));
      b.setAttribute(
        "aria-pressed",
        state.tip.mode === "pct" && Math.abs(num(state.tip.value) - pct) < 1e-3 ? "true" : "false"
      );
      b.addEventListener("click", function() {
        state.tip = { mode: "pct", value: pct };
        renderCharges();
        renderReceipt();
        renderHints();
        save();
      });
      tipPresets.appendChild(b);
    });
  }
  function renderHints() {
    var r = compute2();
    var of = r.discount > 0 ? "% of the discounted " + r.base.toFixed(2) : "% of subtotal";
    var charge = function(k, amount) {
      document.getElementById(k + "Hint").textContent = state[k].mode === "pct" ? "= " + money(amount) : r.base > 0 ? (amount / r.base * 100).toFixed(2) + of : "";
    };
    charge("tax", r.tax);
    charge("tip", r.tip);
    var d = document.getElementById("discountHint");
    d.classList.toggle("warn", !!r.discountCapped);
    d.textContent = r.discountCapped ? "capped at " + money(r.discount) + " \u2014 the items only come to that much" : r.discount <= 0 ? "off the whole check, before tax and tip" : state.discount.mode === "pct" ? "= " + money(r.discount) + " off" : r.assigned > 0 ? (r.discount / r.assigned * 100).toFixed(2) + "% off the subtotal" : "";
  }
  var toast = document.getElementById("toast");
  var toastTimer;
  function say(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() {
      toast.classList.remove("show");
    }, 1900);
  }
  var IMG_FALLBACK = {
    bg: "#141A18",
    ink: "#EDF2ED",
    soft: "#B9C2BC",
    muted: "#8B968F",
    rule: "#39443F",
    faint: "#252D2A",
    accent: "#5FCCAC",
    people: ["#E07457", "#5A9BD0", "#9C80D2", "#C1992A", "#CE6791", "#2BA3B0"]
  };
  var IMG = IMG_FALLBACK;
  function imagePalette() {
    var cs = getComputedStyle(document.documentElement);
    var pick = function(token, fallback) {
      return cs.getPropertyValue(token).trim() || fallback;
    };
    return {
      bg: pick("--surface", IMG_FALLBACK.bg),
      ink: pick("--ink", IMG_FALLBACK.ink),
      soft: pick("--ink-soft", IMG_FALLBACK.soft),
      muted: pick("--muted", IMG_FALLBACK.muted),
      rule: pick("--rule", IMG_FALLBACK.rule),
      faint: pick("--rule-soft", IMG_FALLBACK.faint),
      accent: pick("--accent", IMG_FALLBACK.accent),
      people: IMG_FALLBACK.people.map(function(fallback, i) {
        return pick("--p" + (i + 1), fallback);
      })
    };
  }
  var SANS = 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
  var MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  function colorIndexOf(id) {
    var i = state.people.findIndex(function(p) {
      return p.id === id;
    });
    return (i < 0 ? 0 : i) % IMG.people.length;
  }
  function ellipsize(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + "\u2026").width > maxWidth) t = t.slice(0, -1);
    return t + "\u2026";
  }
  function paintSummary(ctx, W, r, draw) {
    var pad = 44, right = W - pad, y = pad;
    var put = function(text, x, font, color, align) {
      ctx.font = font;
      if (!draw) return;
      ctx.fillStyle = color;
      ctx.textAlign = align || "left";
      ctx.fillText(text, x, y);
    };
    var rule = function(color, dash) {
      if (!draw) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.moveTo(pad, y + 0.5);
      ctx.lineTo(right, y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    y += 18;
    put("S P L I T", pad, "600 15px " + SANS, IMG.muted);
    put(
      (/* @__PURE__ */ new Date()).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      right,
      "13px " + MONO,
      IMG.muted,
      "right"
    );
    y += 52;
    put(money(r.grand), pad, "700 44px " + SANS, IMG.accent);
    put(
      r.ids.length + (r.ids.length === 1 ? " person" : " people"),
      right,
      "14px " + MONO,
      IMG.muted,
      "right"
    );
    y += 24;
    put(
      "Subtotal " + money(r.assigned) + (r.discount > 0 ? "   \xB7   Discount \u2212" + money(r.discount) : "") + "   \xB7   Tax " + money(r.tax) + "   \xB7   Tip " + money(r.tip),
      pad,
      "13px " + MONO,
      IMG.muted
    );
    y += 22;
    rule(IMG.rule);
    r.ids.forEach(function(id) {
      var color = IMG.people[colorIndexOf(id)];
      y += 34;
      if (draw) {
        ctx.fillStyle = color;
        ctx.fillRect(pad, y - 15, 4, 20);
      }
      put(nameOf(id), pad + 16, "600 20px " + SANS, color);
      put(money(r.totals[id]), right, "700 22px " + SANS, IMG.ink, "right");
      y += 10;
      ctx.font = "13px " + MONO;
      var labelMax = W - pad * 2 - 16 - 110;
      r.lines[id].forEach(function(l) {
        y += 21;
        put(ellipsize(ctx, l.label, labelMax), pad + 16, "13px " + MONO, IMG.muted);
        put(l.amount.toFixed(2), right, "13px " + MONO, IMG.muted, "right");
      });
      y += 12;
      rule(IMG.faint);
      y += 20;
      put("subtotal", pad + 16, "13px " + MONO, IMG.soft);
      put(r.subtotals[id].toFixed(2), right, "13px " + MONO, IMG.soft, "right");
      if (r.discount > 0) {
        y += 21;
        put(
          ellipsize(ctx, "discount: " + allocLabel(r, id, r.discount), labelMax),
          pad + 16,
          "13px " + MONO,
          IMG.muted
        );
        put("-" + r.parts[id].discount.toFixed(2), right, "13px " + MONO, IMG.muted, "right");
      }
      y += 21;
      put(
        ellipsize(ctx, "tax+tip: " + allocLabel(r, id, r.extra), labelMax),
        pad + 16,
        "13px " + MONO,
        IMG.muted
      );
      put(r.parts[id].extra.toFixed(2), right, "13px " + MONO, IMG.muted, "right");
      y += 23;
      put("total", pad + 16, "600 14px " + MONO, IMG.ink);
      put(r.totals[id].toFixed(2), right, "600 14px " + MONO, IMG.ink, "right");
      y += 18;
      rule(IMG.rule, [3, 4]);
    });
    y += 30;
    put("split.rahulsetia.me", W / 2, "12px " + MONO, IMG.muted, "center");
    return y + pad - 12;
  }
  function summaryCanvas() {
    var r = compute2();
    IMG = imagePalette();
    var W = 880, scale = 2;
    var probe = document.createElement("canvas").getContext("2d");
    var H = Math.round(paintSummary(probe, W, r, false));
    var c = document.createElement("canvas");
    c.width = W * scale;
    c.height = H * scale;
    var ctx = c.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = IMG.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "alphabetic";
    paintSummary(ctx, W, r, true);
    return c;
  }
  function summaryBlob() {
    return new Promise(function(resolve, reject) {
      var canvas;
      try {
        canvas = summaryCanvas();
      } catch (e) {
        reject(e);
        return;
      }
      canvas.toBlob(function(b) {
        if (b) resolve(b);
        else reject(new Error("toBlob gave nothing"));
      }, "image/png");
    });
  }
  function copyImage() {
    if (!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem)) {
      shareImage();
      return;
    }
    var pending = summaryBlob();
    pending.catch(function() {
    });
    navigator.clipboard.write([new ClipboardItem({ "image/png": pending })]).then(
      function() {
        say("Image copied");
      },
      function() {
        say("Couldn't copy the image \u2014 try Share image");
      }
    );
  }
  async function shareImage() {
    var blob;
    try {
      blob = await summaryBlob();
    } catch (e) {
      say("Couldn't build the image");
      return;
    }
    var file = null;
    try {
      file = new File([blob], "split.png", { type: "image/png" });
    } catch (e) {
    }
    if (file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "split.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() {
      URL.revokeObjectURL(url);
    }, 1e4);
    say("Image saved");
  }
  function showShare() {
    var r = compute2();
    openSheet();
    document.getElementById("sheetTitle").textContent = "The split";
    sheetBody.textContent = "";
    if (!r.ids.length || !state.items.length) {
      sheetBody.appendChild(el(
        "p",
        "scan-hint",
        "Add people and items first \u2014 there's nothing to share yet."
      ));
      var close = el("button", "btn btn-solid", "Back");
      close.type = "button";
      close.addEventListener("click", closeSheet);
      setFoot([close]);
      return;
    }
    var head = el("div", "share-head");
    var left = el("div");
    left.appendChild(el("span", "eyebrow", "Total"));
    left.appendChild(el("div", null, money(r.assigned) + (r.discount > 0 ? " \u2212 " + money(r.discount) + " off" : "") + " + " + money(r.extra) + " tax & tip"));
    head.appendChild(left);
    head.appendChild(el("div", "amt", money(r.grand)));
    sheetBody.appendChild(head);
    r.ids.forEach(function(id) {
      var block = el("div", "share-block");
      block.style.setProperty("--c", colorOf(id));
      block.appendChild(el("div", "share-name", nameOf(id)));
      var body = el("div", "share-lines");
      var row = function(label, value, cls) {
        var d = el("div", cls || null);
        d.appendChild(el("span", null, label));
        d.appendChild(el("span", null, value));
        body.appendChild(d);
      };
      r.lines[id].forEach(function(l) {
        row(l.label, l.amount.toFixed(2));
      });
      row("subtotal", r.subtotals[id].toFixed(2), "sub");
      if (r.discount > 0) {
        row(
          "discount: " + allocLabel(r, id, r.discount),
          "-" + r.parts[id].discount.toFixed(2),
          "credit"
        );
      }
      row("tax+tip: " + allocLabel(r, id, r.extra), r.parts[id].extra.toFixed(2));
      row("total", r.totals[id].toFixed(2), "grand");
      block.appendChild(body);
      sheetBody.appendChild(block);
    });
    var done = el("div", "sheet-foot-wide");
    var fresh = el("button", "btn btn-quiet", "Done \u2014 start a new receipt");
    fresh.type = "button";
    fresh.addEventListener("click", function() {
      if (startFresh(true)) {
        closeSheet();
        say("Cleared \u2014 ready for the next one");
      }
    });
    done.appendChild(fresh);
    var canShareFiles = !!(navigator.canShare && navigator.share);
    var copy = el("button", "btn", "Copy image");
    copy.type = "button";
    copy.title = "Put the same picture straight on your clipboard";
    copy.addEventListener("click", copyImage);
    var image = el("button", "btn btn-solid", canShareFiles ? "Share image" : "Save image");
    image.type = "button";
    image.title = "A clean picture of this summary, ready to drop into a chat";
    image.addEventListener("click", shareImage);
    setFoot([copy, image, done]);
  }
  document.getElementById("barShareBtn").addEventListener("click", showShare);
  document.getElementById("stamp").textContent = (/* @__PURE__ */ new Date()).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toLowerCase() + " \xB7 who owes what, to the cent";
  var TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  var scrim = document.getElementById("scrim");
  var sheetBody = document.getElementById("sheetBody");
  var sheetFoot = document.getElementById("sheetFoot");
  var fileInput = document.getElementById("fileInput");
  var lastFocus = null;
  var tessLoad = null;
  var worker = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tessLoad) return tessLoad;
    tessLoad = new Promise(function(resolve, reject) {
      var s = document.createElement("script");
      s.src = TESSERACT_SRC;
      s.async = true;
      s.onload = function() {
        window.Tesseract ? resolve(window.Tesseract) : reject(new Error("loaded but empty"));
      };
      s.onerror = function() {
        reject(new Error("blocked"));
      };
      document.head.appendChild(s);
    });
    tessLoad.catch(function() {
      tessLoad = null;
    });
    return tessLoad;
  }
  function openSheet() {
    lastFocus = document.activeElement;
    scrim.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeSheet() {
    scrim.hidden = true;
    document.body.style.overflow = "";
    sheetBody.textContent = "";
    sheetFoot.textContent = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.getElementById("sheetClose").addEventListener("click", closeSheet);
  scrim.addEventListener("click", function(e) {
    if (e.target === scrim) closeSheet();
  });
  document.addEventListener("keydown", function(e) {
    if (e.key !== "Escape") return;
    if (!zoom.hidden) closeZoom();
    else if (!scrim.hidden) closeSheet();
  });
  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" }).catch(function() {
        return createImageBitmap(file);
      });
    }
    return new Promise(function(resolve, reject) {
      var img = new Image();
      img.onload = function() {
        resolve(img);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, thresh = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) {
        best = between;
        thresh = i;
      }
    }
    return thresh;
  }
  function preprocess(bmp, rect) {
    var r = rect || { x: 0, y: 0, w: bmp.width, h: bmp.height };
    var scale = 1;
    if (r.w > 1800) scale = 1800 / r.w;
    else if (r.w < 1e3) scale = Math.min(3, 1e3 / r.w);
    var cw = Math.round(r.w * scale), ch = Math.round(r.h * scale);
    var c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
    var img = ctx.getImageData(0, 0, cw, ch);
    var d = img.data;
    var hist = new Uint32Array(256);
    var i, g;
    for (i = 0; i < d.length; i += 4) {
      g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      hist[g]++;
    }
    var t = otsu(hist, cw * ch);
    var lo = Math.max(0, t - 28), hi = Math.min(255, t + 28);
    for (i = 0; i < d.length; i += 4) {
      g = d[i];
      var v = g <= lo ? 0 : g >= hi ? 255 : Math.round((g - lo) / (hi - lo) * 255);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  function setFoot(nodes) {
    sheetFoot.textContent = "";
    nodes.forEach(function(n) {
      sheetFoot.appendChild(n);
    });
  }
  function showPick() {
    sheetBody.textContent = "";
    var drop = el("div", "drop");
    drop.appendChild(el("div", "drop-icon", "\u{1F9FE}"));
    var pick = el("button", "btn btn-solid", "Choose a photo");
    pick.type = "button";
    pick.addEventListener("click", function() {
      fileInput.click();
    });
    drop.appendChild(pick);
    drop.appendChild(el("p", "scan-hint", "or drag one here, or paste from your clipboard"));
    sheetBody.appendChild(drop);
    ["dragenter", "dragover"].forEach(function(ev) {
      drop.addEventListener(ev, function(e) {
        e.preventDefault();
        drop.classList.add("over");
      });
    });
    ["dragleave", "drop"].forEach(function(ev) {
      drop.addEventListener(ev, function(e) {
        e.preventDefault();
        drop.classList.remove("over");
      });
    });
    drop.addEventListener("drop", function(e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    var tips = el("div");
    tips.style.marginTop = "16px";
    tips.appendChild(el(
      "p",
      "scan-hint",
      "Next you'll crop to the item list, then choose how to read it: Read with AI is far more accurate and sends the cropped image to this site's reader, while Scan offline runs entirely on this device and nothing leaves it."
    ));
    tips.appendChild(el(
      "p",
      "scan-hint",
      "Either way, flatten the receipt and shoot straight down in good light \u2014 and you'll get to check every line before anything is added."
    ));
    sheetBody.appendChild(tips);
    setFoot([]);
  }
  function showWork(hint) {
    sheetBody.textContent = "";
    var wrap = el("div");
    var status = el("div", "scan-status");
    var label = el("span", null, "Starting\u2026");
    var pct = el("span", null, "");
    status.appendChild(label);
    status.appendChild(pct);
    var bar = el("div", "progress");
    var fill = document.createElement("span");
    bar.appendChild(fill);
    wrap.appendChild(bar);
    wrap.appendChild(status);
    wrap.appendChild(el("p", "scan-hint", hint || "First scan downloads the recognizer (about 15 MB) \u2014 after that it's cached and starts instantly."));
    sheetBody.appendChild(wrap);
    setFoot([]);
    return function(text, ratio, note) {
      label.textContent = text;
      var busy = ratio === "busy";
      bar.classList.toggle("busy", busy);
      if (busy) {
        pct.textContent = note || "";
        fill.style.width = "";
      } else if (ratio == null) {
        pct.textContent = "";
        fill.style.width = "0%";
      } else {
        pct.textContent = Math.round(ratio * 100) + "%";
        fill.style.width = (ratio * 100).toFixed(1) + "%";
      }
    };
  }
  var PASS_KEY = "split.scanpass.v1";
  var scanPass = null;
  try {
    scanPass = localStorage.getItem(PASS_KEY);
  } catch (e) {
  }
  function passHeaders() {
    var h = { "Content-Type": "application/json" };
    if (scanPass) h["X-Split-Pass"] = scanPass;
    return h;
  }
  function scanImage(bmp, rect) {
    var r = rect || { x: 0, y: 0, w: bmp.width, h: bmp.height };
    var scale = Math.min(1, 1568 / Math.max(r.w, r.h));
    var cw = Math.max(1, Math.round(r.w * scale));
    var ch = Math.max(1, Math.round(r.h * scale));
    var c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    var ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
    return c.toDataURL("image/jpeg", 0.8);
  }
  function askPassphrase(onDone, message, onCancel) {
    openSheet();
    sheetBody.textContent = "";
    document.getElementById("sheetTitle").textContent = "Passphrase";
    sheetBody.appendChild(el(
      "p",
      "scan-hint",
      "Reading with AI runs on this site's own account, so it's behind a passphrase. You only need this once on this device \u2014 everything else in the app stays open."
    ));
    var form = el("div", "pass-form");
    if (message) form.appendChild(el("p", "pass-error", message));
    var input = document.createElement("input");
    input.type = "password";
    input.placeholder = "Passphrase";
    input.autocomplete = "current-password";
    input.setAttribute("aria-label", "Passphrase");
    form.appendChild(input);
    sheetBody.appendChild(form);
    setTimeout(function() {
      input.focus();
    }, 30);
    var submit = function() {
      var value = input.value.trim();
      if (!value) return;
      scanPass = value;
      try {
        localStorage.setItem(PASS_KEY, value);
      } catch (e) {
      }
      onDone();
    };
    input.addEventListener("keydown", function(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    var cancel = el("button", "btn", "Back");
    cancel.type = "button";
    cancel.addEventListener("click", onCancel || showPick);
    var go = el("button", "btn btn-solid", "Continue");
    go.type = "button";
    go.addEventListener("click", submit);
    setFoot([cancel, go]);
  }
  async function readWithAI(bmp, rect) {
    attachPhoto(bmp, rect);
    var setProgress = showWork(
      "The cropped photo goes to this site's reader, and on to Gemini. Usually about five seconds, up to a minute when the models are busy."
    );
    setProgress("Preparing the photo\u2026", "busy");
    var payload;
    try {
      payload = scanImage(bmp, rect);
    } catch (e) {
      showError("Couldn't prepare that image.", String(e && e.message || e));
      return;
    }
    var started = Date.now();
    var elapsed = function() {
      var secs = Math.round((Date.now() - started) / 1e3);
      setProgress(secs < 10 ? "Reading the receipt\u2026" : "A model is busy \u2014 trying another\u2026", "busy", secs + "s");
    };
    elapsed();
    var tick = setInterval(elapsed, 1e3);
    var res, body;
    try {
      res = await fetch("/api/scan", {
        method: "POST",
        headers: passHeaders(),
        body: JSON.stringify({ image: payload })
      });
      body = await res.json().catch(function() {
        return {};
      });
    } catch (e) {
      clearInterval(tick);
      showError(
        "Couldn't reach the reader.",
        "Check your connection, or use \u201CScan offline\u201D, which runs entirely on this device."
      );
      return;
    }
    clearInterval(tick);
    if (res.status === 401) {
      var hadPass = !!scanPass;
      scanPass = null;
      try {
        localStorage.removeItem(PASS_KEY);
      } catch (e) {
      }
      askPassphrase(
        function() {
          readWithAI(bmp, rect);
        },
        hadPass ? "That passphrase wasn't right." : null
      );
      return;
    }
    if (!res.ok) {
      showError(
        body.error || "The reader failed.",
        (body.detail ? body.detail + "\n\n" : "") + "You can still scan offline on this device, or add the items by hand."
      );
      return;
    }
    var result = {
      items: (body.items || []).map(function(i) {
        return { name: i.name, price: num(i.price), use: true };
      }),
      found: {
        tax: body.tax == null ? null : num(body.tax),
        tip: body.tip == null ? null : num(body.tip),
        discount: body.discount == null ? null : Math.abs(num(body.discount)),
        subtotal: body.subtotal == null ? null : num(body.subtotal),
        total: body.total == null ? null : num(body.total)
      },
      readBy: body.model || "the reader",
      secs: (Date.now() - started) / 1e3
    };
    showReview(result, null, bmp, rect);
  }
  function showCrop(bmp) {
    sheetBody.textContent = "";
    document.getElementById("sheetTitle").textContent = "Crop to the items";
    sheetBody.appendChild(el(
      "p",
      "scan-hint",
      "Drag a box around just the item list. Leaving out the store header and the payment lines makes the reading noticeably more accurate."
    ));
    var stage = el("div", "stage");
    stage.style.marginTop = "12px";
    var pw = Math.min(bmp.width, 1200);
    var ph = Math.round(bmp.height * (pw / bmp.width));
    var pc = document.createElement("canvas");
    pc.width = pw;
    pc.height = ph;
    pc.getContext("2d").drawImage(bmp, 0, 0, pw, ph);
    stage.appendChild(pc);
    var sel = el("div", "sel");
    ["nw", "ne", "sw", "se"].forEach(function(k) {
      sel.appendChild(el("div", "handle " + k));
    });
    stage.appendChild(sel);
    sheetBody.appendChild(stage);
    var box = { x: 0.06, y: 0.1, w: 0.88, h: 0.72 };
    function paint() {
      sel.style.left = box.x * 100 + "%";
      sel.style.top = box.y * 100 + "%";
      sel.style.width = box.w * 100 + "%";
      sel.style.height = box.h * 100 + "%";
    }
    paint();
    var drag = null;
    var MIN = 0.04;
    var clamp = function(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    };
    function pos(e) {
      var b = stage.getBoundingClientRect();
      return { x: clamp((e.clientX - b.left) / b.width, 0, 1), y: clamp((e.clientY - b.top) / b.height, 0, 1) };
    }
    stage.addEventListener("pointerdown", function(e) {
      var handle = e.target.classList && e.target.classList.contains("handle") ? e.target : null;
      var p = pos(e);
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
      if (handle) {
        var corner = handle.className.split(" ").pop();
        drag = { mode: "resize", corner };
      } else if (e.target === sel || sel.contains(e.target)) {
        drag = { mode: "move", dx: p.x - box.x, dy: p.y - box.y };
      } else {
        drag = { mode: "draw", ox: p.x, oy: p.y };
        box = { x: p.x, y: p.y, w: 0, h: 0 };
        paint();
      }
    });
    stage.addEventListener("pointermove", function(e) {
      if (!drag) return;
      var p = pos(e);
      if (drag.mode === "move") {
        box.x = clamp(p.x - drag.dx, 0, 1 - box.w);
        box.y = clamp(p.y - drag.dy, 0, 1 - box.h);
      } else if (drag.mode === "draw") {
        box.x = Math.min(drag.ox, p.x);
        box.y = Math.min(drag.oy, p.y);
        box.w = Math.abs(p.x - drag.ox);
        box.h = Math.abs(p.y - drag.oy);
      } else {
        var right = box.x + box.w, bottom = box.y + box.h;
        if (drag.corner === "nw" || drag.corner === "sw") {
          box.x = Math.min(p.x, right - MIN);
          box.w = right - box.x;
        } else {
          box.w = Math.max(MIN, clamp(p.x, 0, 1) - box.x);
        }
        if (drag.corner === "nw" || drag.corner === "ne") {
          box.y = Math.min(p.y, bottom - MIN);
          box.h = bottom - box.y;
        } else {
          box.h = Math.max(MIN, clamp(p.y, 0, 1) - box.y);
        }
      }
      paint();
    });
    var endDrag = function() {
      if (drag && drag.mode === "draw" && (box.w < MIN || box.h < MIN)) {
        box = { x: 0.06, y: 0.1, w: 0.88, h: 0.72 };
        paint();
      }
      drag = null;
    };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    function rect() {
      return {
        x: Math.round(box.x * bmp.width),
        y: Math.round(box.y * bmp.height),
        w: Math.max(1, Math.round(box.w * bmp.width)),
        h: Math.max(1, Math.round(box.h * bmp.height))
      };
    }
    var extras = el("div");
    extras.style.cssText = "display:flex; flex-wrap:wrap; gap:4px; margin-top:8px;";
    var whole = el("button", "btn btn-quiet", "Use the whole image");
    whole.type = "button";
    whole.addEventListener("click", function() {
      readWithAI(bmp, null);
    });
    extras.appendChild(whole);
    var keep = el("button", "btn btn-quiet", "Keep as reference only");
    keep.type = "button";
    keep.addEventListener("click", function() {
      attachPhoto(bmp, rect());
      closeSheet();
      say("Photo pinned above your items");
    });
    extras.appendChild(keep);
    sheetBody.appendChild(extras);
    var offline = el("button", "btn", "Scan offline");
    offline.type = "button";
    offline.title = "Reads on this device with OCR. Free, private, less accurate.";
    offline.addEventListener("click", function() {
      runScan(bmp, rect());
    });
    var ai = el("button", "btn btn-solid", "Read with AI");
    ai.type = "button";
    ai.addEventListener("click", function() {
      readWithAI(bmp, rect());
    });
    setFoot([offline, ai]);
  }
  function showError(title, detail) {
    sheetBody.textContent = "";
    sheetBody.appendChild(el("p", "scan-hint", title));
    if (detail) {
      var d = el("p", "scan-hint", detail);
      d.style.color = "var(--danger)";
      sheetBody.appendChild(d);
    }
    var again = el("button", "btn", "Try another photo");
    again.type = "button";
    again.addEventListener("click", showPick);
    var manual = el("button", "btn btn-solid", "Add items by hand");
    manual.type = "button";
    manual.addEventListener("click", function() {
      closeSheet();
      addItem();
    });
    setFoot([again, manual]);
  }
  function showReview(result, previewCanvas, bmp, rect) {
    sheetBody.textContent = "";
    document.getElementById("sheetTitle").textContent = "Review items";
    var shotSrc = previewCanvas ? previewCanvas.toDataURL("image/jpeg", 0.7) : photo;
    if (shotSrc) {
      var shot = document.createElement("img");
      shot.className = "shot";
      shot.alt = previewCanvas ? "The processed image the scanner read" : "The receipt that was read";
      shot.src = shotSrc;
      sheetBody.appendChild(shot);
    }
    if (!result.items.length) {
      sheetBody.appendChild(el(
        "p",
        "scan-hint",
        "No item lines came through clearly. That usually means the photo is angled, dim, or too small \u2014 a straight-on shot cropped to the item list works best."
      ));
      addRawBlock();
      var retry = el("button", "btn", bmp ? "Adjust crop" : "Try another photo");
      retry.type = "button";
      retry.addEventListener("click", function() {
        bmp ? showCrop(bmp) : showPick();
      });
      var byHand = el("button", "btn btn-solid", "Add items by hand");
      byHand.type = "button";
      byHand.addEventListener("click", function() {
        closeSheet();
        addItem();
      });
      setFoot([retry, byHand]);
      return;
    }
    sheetBody.appendChild(el("p", "scan-hint", result.readBy ? "Read by " + result.readBy + (result.secs ? " in " + result.secs.toFixed(1) + "s" : "") + ". Check the lines below \u2014 untick anything that isn't an item, and fix any price it got wrong." : "Check the lines below \u2014 untick anything that isn't an item, and fix any prices OCR got wrong."));
    var list = el("ul", "found");
    list.style.marginTop = "12px";
    result.items.forEach(function(row) {
      var li = document.createElement("li");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = row.use;
      cb.setAttribute("aria-label", "Include this line");
      cb.addEventListener("change", function() {
        row.use = cb.checked;
        li.classList.toggle("off", !cb.checked);
        countUp();
      });
      li.appendChild(cb);
      var nm = document.createElement("input");
      nm.className = "f-name";
      nm.value = row.name;
      nm.setAttribute("aria-label", "Item name");
      nm.addEventListener("input", function() {
        row.name = nm.value;
      });
      li.appendChild(nm);
      var pr = document.createElement("input");
      pr.className = "f-price";
      pr.type = "text";
      pr.inputMode = "decimal";
      pr.value = row.price.toFixed(2);
      pr.setAttribute("aria-label", "Price");
      pr.addEventListener("input", function() {
        row.price = num(pr.value);
        countUp();
      });
      pr.addEventListener("focus", function() {
        pr.select();
      });
      li.appendChild(pr);
      list.appendChild(li);
    });
    sheetBody.appendChild(list);
    var recon = el("div", "reconcile");
    sheetBody.appendChild(recon);
    var f = result.found;
    var applyTax = { on: f.tax != null }, applyTip = { on: f.tip != null };
    var applyDiscount = { on: f.discount != null };
    if (f.tax != null || f.tip != null || f.discount != null) {
      var det = el("div", "detected");
      det.appendChild(el("div", "eyebrow", "Also spotted"));
      var chargeRow = function(label, value, flag) {
        var r = el("label", "detected-row");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.addEventListener("change", function() {
          flag.on = cb.checked;
        });
        r.appendChild(cb);
        r.appendChild(el("span", null, label));
        r.appendChild(el("span", "amt", money(value)));
        det.appendChild(r);
      };
      if (f.discount != null) chargeRow("Take this off as a discount", f.discount, applyDiscount);
      if (f.tax != null) chargeRow("Use this as tax", f.tax, applyTax);
      if (f.tip != null) chargeRow("Use this as tip", f.tip, applyTip);
      sheetBody.appendChild(det);
    }
    addRawBlock();
    function addRawBlock() {
      if (!previewCanvas) return;
      var det2 = document.createElement("details");
      det2.className = "raw";
      var sum = document.createElement("summary");
      sum.textContent = "Show the raw text OCR read";
      det2.appendChild(sum);
      var pre = document.createElement("pre");
      pre.textContent = result.raw.trim() || "(nothing)";
      det2.appendChild(pre);
      sheetBody.appendChild(det2);
    }
    var back = el("button", "btn", bmp ? "Adjust crop" : "Different photo");
    back.type = "button";
    back.addEventListener("click", function() {
      bmp ? showCrop(bmp) : showPick();
    });
    var add = el("button", "btn btn-solid", "");
    add.type = "button";
    add.addEventListener("click", function() {
      var picked = result.items.filter(function(r) {
        return r.use && num(r.price) !== 0;
      });
      picked.forEach(function(r) {
        state.items.push({
          id: uid(),
          name: r.name || "Item",
          price: num(r.price),
          shared: state.people.map(function(p) {
            return p.id;
          })
        });
      });
      if (f.tax != null && applyTax.on) state.tax = { mode: "amt", value: f.tax };
      if (f.tip != null && applyTip.on) state.tip = { mode: "amt", value: f.tip };
      if (f.discount != null && applyDiscount.on) state.discount = { mode: "amt", value: f.discount };
      var tucked = false;
      if (result.readBy && photo && state.photoOpen !== false) {
        state.photoOpen = false;
        tucked = true;
      }
      renderAll();
      renderHints();
      save();
      closeSheet();
      say("Added " + picked.length + (picked.length === 1 ? " item" : " items") + (tucked ? " \u2014 photo tucked away" : " \u2014 assigned to everyone"));
    });
    function countUp() {
      var live = result.items.filter(function(r) {
        return r.use && num(r.price) !== 0;
      });
      var n = live.length;
      add.textContent = n ? "Add " + n + (n === 1 ? " item" : " items") : "Nothing selected";
      add.disabled = !n;
      add.style.opacity = n ? "1" : ".5";
      var sum = live.reduce(function(s, r) {
        return s + num(r.price);
      }, 0);
      recon.classList.remove("ok", "off");
      if (f.subtotal == null) {
        recon.textContent = "Selected lines add up to " + money(sum) + ". No printed subtotal was found to check that against.";
      } else {
        var diff = sum - f.subtotal;
        if (Math.abs(diff) < 5e-3) {
          recon.classList.add("ok");
          recon.textContent = "Adds up to " + money(sum) + ", matching the subtotal printed on the receipt.";
        } else {
          recon.classList.add("off");
          recon.textContent = "Selected lines add up to " + money(sum) + ", but the receipt says " + money(f.subtotal) + " \u2014 off by " + money(Math.abs(diff)) + ". Check for a misread price or a missing line.";
        }
      }
    }
    countUp();
    setFoot([back, add]);
  }
  async function handleFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      showError("That file isn't an image.", "Pick a photo of the receipt \u2014 JPEG, PNG, or HEIC.");
      return;
    }
    var setProgress = showWork();
    try {
      setProgress("Opening the photo\u2026", null);
      var bmp = await loadBitmap(file);
      showCrop(bmp);
    } catch (e) {
      showError("Couldn't read that image.", String(e && e.message || e));
    }
  }
  async function runScan(bmp, rect) {
    attachPhoto(bmp, rect);
    var setProgress = showWork();
    var canvas;
    try {
      setProgress("Preparing the image\u2026", null);
      canvas = preprocess(bmp, rect);
    } catch (e) {
      showError("Couldn't prepare that image.", String(e && e.message || e));
      return;
    }
    var Tess;
    try {
      setProgress("Loading the recognizer\u2026", null);
      Tess = await loadTesseract();
    } catch (e) {
      showError(
        "The text recognizer couldn't load.",
        "It's fetched from a CDN on first use, so this needs a network connection \u2014 and it won't run inside a preview that blocks outside scripts. The hosted site is the place to use scanning."
      );
      return;
    }
    try {
      if (!worker) {
        worker = await Tess.createWorker("eng", 1, {
          logger: function(m) {
            var label = /recogniz/i.test(m.status) ? "Reading the receipt\u2026" : /download|load|fetch/i.test(m.status) ? "Loading the recognizer\u2026" : /initial/i.test(m.status) ? "Warming up\u2026" : m.status;
            setProgress(label, typeof m.progress === "number" ? m.progress : null);
          }
        });
        await worker.setParameters({ tessedit_pageseg_mode: "6" });
      } else {
        setProgress("Reading the receipt\u2026", 0.1);
      }
      var res = await worker.recognize(canvas);
      var parsed = parseReceipt(res.data.text || "");
      showReview(parsed, canvas, bmp, rect);
    } catch (e) {
      if (worker) {
        try {
          await worker.terminate();
        } catch (x) {
        }
        worker = null;
      }
      showError("The scan failed partway through.", String(e && e.message || e));
    }
  }
  fileInput.addEventListener("change", function() {
    var f = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (f) handleFile(f);
  });
  document.getElementById("scanBtn").addEventListener("click", function() {
    openSheet();
    document.getElementById("sheetTitle").textContent = "Scan receipt";
    showPick();
  });
  document.addEventListener("paste", function(e) {
    if (scrim.hidden) return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") === 0) {
        var f = items[i].getAsFile();
        if (f) {
          e.preventDefault();
          handleFile(f);
          return;
        }
      }
    }
  });
  renderAll();
  renderHints();
})();
