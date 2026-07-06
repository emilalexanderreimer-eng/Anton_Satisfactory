/* Anton Satisfactory Planner */
(function () {
  "use strict";

  const DATA = window.GAME_DATA;
  const ITEMS = DATA.items;
  const RECIPES = DATA.recipes;
  const BUILDINGS = DATA.buildings;

  // recipes indexed by product item
  const recipesByProduct = {};
  for (const r of RECIPES) {
    for (const [item] of r.out) {
      (recipesByProduct[item] = recipesByProduct[item] || []).push(r);
    }
  }
  const recipeById = {};
  for (const r of RECIPES) recipeById[r.id] = r;

  // items that can be produced, sorted by name (for target dropdown)
  const producibleItems = Object.keys(recipesByProduct)
    .filter((c) => ITEMS[c])
    .sort((a, b) => ITEMS[a].name.localeCompare(ITEMS[b].name));

  // ---------- state ----------
  const state = loadState() || {
    targets: [{ item: "Desc_IronPlateReinforced_C", rate: 10 }],
    recipeChoice: {}, // item className -> recipe id
    clock: 100, // percent
  };

  function saveState() {
    try { localStorage.setItem("anton-planner", JSON.stringify(state)); } catch (e) {}
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem("anton-planner"));
      if (s && Array.isArray(s.targets)) return s;
    } catch (e) {}
    return null;
  }

  // ---------- recipe selection ----------
  function defaultRecipeFor(item) {
    const list = recipesByProduct[item];
    if (!list || !list.length) return null;
    // prefer non-alternate whose primary (first) product is the item
    const std = list.filter((r) => !r.alt);
    const primary = std.find((r) => r.out[0][0] === item);
    return primary || std[0] || list[0];
  }

  function chosenRecipeFor(item) {
    const id = state.recipeChoice[item];
    if (id === "RAW") return null;
    if (id && recipeById[id]) {
      const r = recipeById[id];
      if (r.out.some(([i]) => i === item)) return r;
    }
    return defaultRecipeFor(item);
  }

  function isRaw(item) {
    const it = ITEMS[item];
    if (!it) return true;
    if (state.recipeChoice[item] === "RAW") return true;
    if (it.raw) return true;
    return !recipesByProduct[item];
  }

  // ---------- solver ----------
  // Returns { steps: Map(recipeId -> {recipe, machines, rate}), raws: Map(item->rate),
  //           byproducts: Map(item->rate), power }
  function solve(targets, clockFrac) {
    const demand = new Map(); // item -> remaining rate to produce
    const steps = new Map();
    const raws = new Map();
    const surplus = new Map(); // byproduct pool, credited against demand
    const queue = [];

    function addDemand(item, rate) {
      if (rate <= 1e-9) return;
      // credit from byproduct surplus first
      const s = surplus.get(item) || 0;
      if (s > 1e-9) {
        const used = Math.min(s, rate);
        surplus.set(item, s - used);
        rate -= used;
        if (rate <= 1e-9) return;
      }
      demand.set(item, (demand.get(item) || 0) + rate);
      queue.push(item);
    }

    for (const t of targets) {
      if (t.item && t.rate > 0) addDemand(t.item, t.rate);
    }

    let guard = 0;
    while (queue.length && guard++ < 20000) {
      const item = queue.shift();
      const rate = demand.get(item) || 0;
      if (rate <= 1e-9) continue;
      demand.set(item, 0);

      if (isRaw(item)) {
        raws.set(item, (raws.get(item) || 0) + rate);
        continue;
      }
      const rec = chosenRecipeFor(item);
      if (!rec) {
        raws.set(item, (raws.get(item) || 0) + rate);
        continue;
      }
      const prod = rec.out.find(([i]) => i === item);
      const perMachine = (prod[1] * 60 / rec.time) * clockFrac; // items/min at chosen clock
      const machines = rate / perMachine;

      const st = steps.get(rec.id) || { recipe: rec, machines: 0 };
      st.machines += machines;
      steps.set(rec.id, st);

      // byproducts
      for (const [oItem, oAmt] of rec.out) {
        if (oItem === item) continue;
        const oRate = (oAmt * 60 / rec.time) * clockFrac * machines;
        surplus.set(oItem, (surplus.get(oItem) || 0) + oRate);
      }
      // ingredients
      for (const [iItem, iAmt] of rec.in) {
        const iRate = (iAmt * 60 / rec.time) * clockFrac * machines;
        addDemand(iItem, iRate);
      }
    }

    // power: per-machine power scales with clock^exponent
    let power = 0;
    for (const st of steps.values()) {
      const b = BUILDINGS[st.recipe.bld];
      const base = st.recipe.pow != null ? st.recipe.pow : (b ? b.power : 0);
      const exp = b ? b.exp : 1.321929;
      power += st.machines * base * Math.pow(clockFrac, exp);
    }

    return { steps, raws, byproducts: surplus, power, unstable: guard >= 20000 };
  }

  // ---------- formatting ----------
  function fmt(n, digits) {
    if (digits === undefined) digits = 2;
    const s = n.toLocaleString("de-DE", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
    return s;
  }
  function itemName(c) { return ITEMS[c] ? ITEMS[c].name : c; }
  function unit(c) { return ITEMS[c] && ITEMS[c].liquid ? " m³/min" : " /min"; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }

  // ---------- UI: targets ----------
  const elTargets = document.getElementById("targets");
  const elAdd = document.getElementById("add-target");
  const elMod = document.getElementById("modifier-025");
  const elClock = document.getElementById("clock-input");

  function itemOptions(selected) {
    let html = "";
    for (const c of producibleItems) {
      html += `<option value="${c}"${c === selected ? " selected" : ""}>${esc(ITEMS[c].name)}</option>`;
    }
    return html;
  }

  function renderTargets() {
    elTargets.innerHTML = "";
    state.targets.forEach((t, idx) => {
      const row = document.createElement("div");
      row.className = "target-row";
      row.innerHTML =
        `<select class="item-select">${itemOptions(t.item)}</select>` +
        `<input type="number" min="0" step="any" value="${t.rate}"> <span class="muted">/min</span>` +
        `<button class="btn-remove" title="Ziel entfernen">✕</button>`;
      row.querySelector("select").addEventListener("change", (e) => {
        t.item = e.target.value; update();
      });
      row.querySelector("input").addEventListener("input", (e) => {
        t.rate = parseFloat(e.target.value) || 0; update();
      });
      row.querySelector(".btn-remove").addEventListener("click", () => {
        state.targets.splice(idx, 1);
        renderTargets(); update();
      });
      elTargets.appendChild(row);
    });
  }

  elAdd.addEventListener("click", () => {
    state.targets.push({ item: producibleItems[0], rate: 10 });
    renderTargets(); update();
  });

  // ---------- UI: modifier ----------
  function syncModifierUI() {
    elMod.checked = state.clock === 25;
    elClock.value = state.clock;
  }
  elMod.addEventListener("change", () => {
    state.clock = elMod.checked ? 25 : 100;
    syncModifierUI(); update();
  });
  elClock.addEventListener("input", () => {
    const v = parseFloat(elClock.value);
    if (v > 0 && v <= 250) {
      state.clock = v;
      elMod.checked = state.clock === 25;
      update();
    }
  });

  // ---------- UI: results ----------
  const elSummary = document.getElementById("summary");
  const elSteps = document.getElementById("steps");
  const elRaws = document.getElementById("raws");
  const elBy = document.getElementById("byproducts");
  const elTree = document.getElementById("tree");

  function recipeOptions(item, chosen) {
    const list = [...(recipesByProduct[item] || [])].sort(
      (a, b) => (a.alt - b.alt) || a.name.localeCompare(b.name)
    );
    let html = "";
    for (const r of list) {
      const label = (r.alt ? "ALT: " : "") + r.name.replace(/^Alternate:\s*/, "");
      html += `<option value="${r.id}"${r.id === chosen.id ? " selected" : ""}>${esc(label)}</option>`;
    }
    return html;
  }

  function renderSteps(result, clockFrac) {
    if (!result.steps.size) {
      elSteps.innerHTML = '<p class="muted">Keine Produktionsschritte.</p>';
      return;
    }
    let html = '<table><tr><th>Produkt</th><th>Rezept</th><th>Maschine</th>' +
      '<th class="num">Anzahl</th><th class="num">Ausstoß</th><th class="num">Leistung</th></tr>';
    for (const st of result.steps.values()) {
      const r = st.recipe;
      const mainItem = r.out[0][0];
      const b = BUILDINGS[r.bld];
      const base = r.pow != null ? r.pow : (b ? b.power : 0);
      const pw = st.machines * base * Math.pow(clockFrac, b ? b.exp : 1.321929);
      const outRate = (r.out[0][1] * 60 / r.time) * clockFrac * st.machines;
      html += `<tr><td>${esc(itemName(mainItem))}</td>` +
        `<td><select class="recipe-select" data-item="${mainItem}">${recipeOptions(mainItem, r)}</select></td>` +
        `<td>${esc(b ? b.name : "?")}</td>` +
        `<td class="num">${fmt(Math.ceil(st.machines * 1000) / 1000)} <span class="muted">(${Math.ceil(st.machines - 1e-9)}×)</span></td>` +
        `<td class="num">${fmt(outRate)}${unit(mainItem)}</td>` +
        `<td class="num">${fmt(pw, 1)} MW</td></tr>`;
    }
    html += "</table>";
    elSteps.innerHTML = html;
    elSteps.querySelectorAll(".recipe-select").forEach((sel) => {
      sel.addEventListener("change", () => {
        state.recipeChoice[sel.dataset.item] = sel.value;
        update();
      });
    });
  }

  function renderMap(el, map, emptyText) {
    const entries = [...map.entries()].filter(([, v]) => v > 1e-6);
    if (!entries.length) {
      el.innerHTML = `<p class="muted">${emptyText}</p>`;
      return;
    }
    entries.sort((a, b) => b[1] - a[1]);
    let html = "<table><tr><th>Item</th><th class=\"num\">Menge</th></tr>";
    for (const [item, rate] of entries) {
      html += `<tr><td>${esc(itemName(item))}</td><td class="num">${fmt(rate)}${unit(item)}</td></tr>`;
    }
    html += "</table>";
    el.innerHTML = html;
  }

  function renderSummary(result) {
    const machines = [...result.steps.values()].reduce((a, s) => a + Math.ceil(s.machines - 1e-9), 0);
    elSummary.innerHTML =
      '<div class="summary-cards">' +
      `<div class="card"><div class="label">Maschinen gesamt</div><div class="value">${machines}</div></div>` +
      `<div class="card"><div class="label">Leistung gesamt</div><div class="value">${fmt(result.power, 1)} MW</div></div>` +
      `<div class="card"><div class="label">Taktung</div><div class="value">${fmt(state.clock)} %</div></div>` +
      "</div>" +
      (result.unstable ? '<p class="t-cycle">⚠ Rezeptzyklus erkannt — Ergebnis evtl. unvollständig.</p>' : "");
  }

  function renderTree(clockFrac) {
    function node(item, rate, path, depth) {
      const liquid = unit(item);
      if (depth > 12 || path.has(item)) {
        return `<li><span class="t-item">${esc(itemName(item))}</span> ` +
          `<span class="t-rate">${fmt(rate)}${liquid}</span> ` +
          `<span class="t-cycle">(Zyklus/Tiefe — als Eingang behandelt)</span></li>`;
      }
      if (isRaw(item) || !chosenRecipeFor(item)) {
        return `<li><span class="t-item t-raw">⛏ ${esc(itemName(item))}</span> ` +
          `<span class="t-rate">${fmt(rate)}${liquid}</span></li>`;
      }
      const rec = chosenRecipeFor(item);
      const prod = rec.out.find(([i]) => i === item);
      const perMachine = (prod[1] * 60 / rec.time) * clockFrac;
      const machines = rate / perMachine;
      const b = BUILDINGS[rec.bld];
      let html = `<li><span class="t-item">${esc(itemName(item))}</span> ` +
        `<span class="t-rate">${fmt(rate)}${liquid}</span> ` +
        `<span class="t-machine">— ${fmt(machines)}× ${esc(b ? b.name : "?")}` +
        `${rec.alt ? " · ALT: " + esc(rec.name.replace(/^Alternate:\s*/, "")) : ""}</span>`;
      const next = new Set(path); next.add(item);
      html += "<ul>";
      for (const [iItem, iAmt] of rec.in) {
        const iRate = (iAmt * 60 / rec.time) * clockFrac * machines;
        html += node(iItem, iRate, next, depth + 1);
      }
      html += "</ul></li>";
      return html;
    }

    let html = '<div class="tree"><ul>';
    for (const t of state.targets) {
      if (t.item && t.rate > 0) html += node(t.item, t.rate, new Set(), 0);
    }
    html += "</ul></div>";
    elTree.innerHTML = html;
  }

  // ---------- main ----------
  function update() {
    const clockFrac = state.clock / 100;
    const result = solve(state.targets, clockFrac);
    renderSummary(result);
    renderSteps(result, clockFrac);
    renderMap(elRaws, result.raws, "Keine Rohstoffe benötigt.");
    renderMap(elBy, result.byproducts, "Keine Nebenprodukte.");
    renderTree(clockFrac);
    saveState();
  }

  syncModifierUI();
  renderTargets();
  update();
})();
