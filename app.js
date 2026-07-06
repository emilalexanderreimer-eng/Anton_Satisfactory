/* Anton Satisfactory Planner */
(function () {
  "use strict";

  const DATA = window.GAME_DATA;
  const ITEMS = DATA.items;
  const RECIPES = DATA.recipes;
  const BUILDINGS = DATA.buildings;

  // ── index ──────────────────────────────────────────────────────────────────
  const recipesByProduct = {};
  const recipeById = {};
  for (const r of RECIPES) {
    recipeById[r.id] = r;
    for (const [item] of r.out)
      (recipesByProduct[item] = recipesByProduct[item] || []).push(r);
  }
  const producibleItems = Object.keys(recipesByProduct)
    .filter(c => ITEMS[c])
    .sort((a, b) => ITEMS[a].name.localeCompare(ITEMS[b].name));

  // ── state ──────────────────────────────────────────────────────────────────
  const state = loadState() || {
    targets:     [{ item: "Desc_IronPlateReinforced_C", rate: 10 }],
    recipeChoice:{},
    stepClocks:  {},
    globalClock: 100,
    costMult:    1,
    resources:   {},
  };
  if (!state.stepClocks)  state.stepClocks  = {};
  if (!state.globalClock) state.globalClock = state.clock || 100;
  if (!state.costMult)    state.costMult    = 1;
  if (!state.resources)   state.resources   = {};

  function saveState() {
    try { localStorage.setItem("anton-v3", JSON.stringify(state)); } catch(_) {}
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem("anton-v3") || localStorage.getItem("anton-planner-v2"));
      if (s && Array.isArray(s.targets)) return s;
    } catch(_) {}
    return null;
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function fmt(n, d) {
    if (n == null || isNaN(n)) return "–";
    return n.toLocaleString("de-DE", { maximumFractionDigits: d ?? 2, minimumFractionDigits: 0 });
  }
  function itemName(c)   { return ITEMS[c] ? ITEMS[c].name : c; }
  function isLiq(c)      { return !!(ITEMS[c] && ITEMS[c].liquid); }
  function unit(c)       { return isLiq(c) ? " m³/min" : " /min"; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[ch]));
  }
  function hexCol(item) {
    if (isLiq(item))              return "#56cfe1";
    if (ITEMS[item] && ITEMS[item].raw) return "#f2c94c";
    return "#6fcf7c";
  }
  function abbr(name) {
    return name.split(/[\s\-]+/).map(w => w[0] || "").join("").slice(0, 2).toUpperCase();
  }
  function wikiUrl(item) {
    const it = ITEMS[item];
    if (!it) return "";
    return "https://satisfactory.wiki.gg/wiki/Special:FilePath/" +
      encodeURIComponent(it.name.replace(/ /g, "_")) + ".png";
  }
  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  // ── recipe helpers ─────────────────────────────────────────────────────────
  function defaultRecipeFor(item) {
    const list = recipesByProduct[item];
    if (!list?.length) return null;
    const std = list.filter(r => !r.alt);
    return std.find(r => r.out[0][0] === item) || std[0] || list[0];
  }
  function chosenRecipeFor(item) {
    const id = state.recipeChoice[item];
    if (id === "RAW") return null;
    if (id && recipeById[id]?.out.some(([i]) => i === item)) return recipeById[id];
    return defaultRecipeFor(item);
  }
  function isRaw(item) {
    if (state.recipeChoice[item] === "RAW") return true;
    if (ITEMS[item]?.raw) return true;
    return !recipesByProduct[item];
  }
  function clockFor(rid) {
    return (state.stepClocks[rid] !== undefined ? state.stepClocks[rid] : state.globalClock) / 100;
  }

  // ── solver ─────────────────────────────────────────────────────────────────
  function solve(targets) {
    const demand = new Map(), steps = new Map(), raws = new Map(), surplus = new Map();
    const queue = [];

    function addDemand(item, rate) {
      if (rate <= 1e-9) return;
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

    for (const t of targets) if (t.item && t.rate > 0) addDemand(t.item, t.rate);

    let guard = 0;
    while (queue.length && guard++ < 20000) {
      const item = queue.shift();
      const rate = demand.get(item) || 0;
      if (rate <= 1e-9) continue;
      demand.set(item, 0);

      if (isRaw(item)) { raws.set(item, (raws.get(item) || 0) + rate); continue; }
      const rec = chosenRecipeFor(item);
      if (!rec) { raws.set(item, (raws.get(item) || 0) + rate); continue; }

      const cf   = clockFor(rec.id);
      const prod = rec.out.find(([i]) => i === item);
      const mach = rate / ((prod[1] * 60 / rec.time) * cf);

      const st = steps.get(rec.id) || { recipe: rec, machines: 0 };
      st.machines += mach;
      steps.set(rec.id, st);

      for (const [oItem, oAmt] of rec.out) {
        if (oItem === item) continue;
        surplus.set(oItem, (surplus.get(oItem) || 0) + (oAmt * 60 / rec.time) * cf * mach);
      }
      for (const [iItem, iAmt] of rec.in)
        // costMult scales ingredient amounts only — output and machine count are unaffected
        addDemand(iItem, (iAmt * 60 / rec.time) * cf * mach * state.costMult);
    }

    let power = 0;
    for (const st of steps.values()) {
      const r = st.recipe, b = BUILDINGS[r.bld], cf = clockFor(r.id);
      const base = r.pow != null ? r.pow : (b ? b.power : 0);
      power += st.machines * base * Math.pow(cf, b ? b.exp : 1.321929);
    }
    return { steps, raws, byproducts: surplus, power, unstable: guard >= 20000 };
  }

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const elTargets   = document.getElementById("targets");
  const elAdd       = document.getElementById("add-target");
  const elGlobalCk  = document.getElementById("clock-global");
  const elApplyAll  = document.getElementById("apply-all");
  const elApply025  = document.getElementById("apply-025");
  const elCostMult  = document.getElementById("cost-mult");
  const elResInputs = document.getElementById("resource-inputs");
  const elBtnCalc   = document.getElementById("btn-calc-max");
  const elBtnClear  = document.getElementById("btn-clear-res");
  const elResResult = document.getElementById("resource-result");
  const elSummary   = document.getElementById("summary");
  const elSteps     = document.getElementById("steps");
  const elRaws      = document.getElementById("raws");
  const elBy        = document.getElementById("byproducts");
  const elFlowWrap  = document.getElementById("flowchart-wrap");
  const elFlow      = document.getElementById("flowchart");
  const elFlowFit   = document.getElementById("flow-fit");
  const elFlowReset = document.getElementById("flow-reset");

  // ── Target UI ──────────────────────────────────────────────────────────────
  function itemOptions(sel) {
    return producibleItems.map(c =>
      `<option value="${c}"${c === sel ? " selected" : ""}>${esc(ITEMS[c].name)}</option>`
    ).join("");
  }
  function renderTargets() {
    elTargets.innerHTML = "";
    state.targets.forEach((t, idx) => {
      const row = document.createElement("div");
      row.className = "target-row";
      row.innerHTML =
        `<select class="item-select">${itemOptions(t.item)}</select>` +
        `<input type="number" min="0" step="any" value="${t.rate}">` +
        `<span class="muted">/min</span><button class="btn-remove">✕</button>`;
      row.querySelector("select").addEventListener("change", e => { t.item = e.target.value; update(); });
      row.querySelector("input").addEventListener("input", e => { t.rate = parseFloat(e.target.value) || 0; update(); });
      row.querySelector(".btn-remove").addEventListener("click", () => { state.targets.splice(idx, 1); renderTargets(); update(); });
      elTargets.appendChild(row);
    });
  }
  elAdd.addEventListener("click", () => { state.targets.push({ item: producibleItems[0], rate: 10 }); renderTargets(); update(); });

  // ── Settings UI ────────────────────────────────────────────────────────────
  elGlobalCk.value = state.globalClock;
  elGlobalCk.addEventListener("input", () => {
    const v = parseFloat(elGlobalCk.value);
    if (v >= 1 && v <= 250) { state.globalClock = v; update(); }
  });
  elApplyAll.addEventListener("click", () => {
    const v = parseFloat(elGlobalCk.value);
    if (v >= 1 && v <= 250) { state.stepClocks = {}; state.globalClock = v; update(); }
  });

  // Cost multiplier (Update 1.2 Game Mode)
  elCostMult.value = String(state.costMult);
  elCostMult.addEventListener("change", () => {
    state.costMult = parseFloat(elCostMult.value) || 1;
    update();
  });

  // ── Ingredient pills ───────────────────────────────────────────────────────
  function ingrPills(rec, machines) {
    if (!rec.in.length) return "";
    const cf = clockFor(rec.id);
    const pills = rec.in.map(([item, amt]) => {
      const rate = (amt * 60 / rec.time) * cf * machines * state.costMult;
      const lq   = isLiq(item);
      const col  = hexCol(item);
      return `<span class="ingr-pill">
        <img src="${esc(wikiUrl(item))}" alt="" loading="lazy"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <span class="pill-fb" style="display:none;background:${col}22;color:${col};border:1px solid ${col}">${esc(abbr(itemName(item)))}</span>
        <span>${esc(itemName(item))}</span>
        <span class="pill-rate${lq ? " liq" : ""}">${fmt(rate)}${unit(item)}</span>
      </span>`;
    }).join("");
    return `<div class="ingr-list">${pills}</div>`;
  }

  // ── Steps table ────────────────────────────────────────────────────────────
  function recipeOpts(item, chosen) {
    const list = [...(recipesByProduct[item] || [])].sort((a, b) => (a.alt - b.alt) || a.name.localeCompare(b.name));
    return list.map(r => {
      const label = (r.alt ? "ALT: " : "") + r.name.replace(/^Alternate:\s*/, "");
      return `<option value="${r.id}"${r.id === chosen.id ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
  }
  function renderSteps(result) {
    if (!result.steps.size) { elSteps.innerHTML = '<p class="muted">Keine Schritte.</p>'; return; }
    let html = `<table><tr><th>Produkt</th><th>Rezept &amp; Zutaten</th><th>Maschine</th>
      <th class="num">Anzahl</th><th class="num">Ausstoß</th><th>Taktung</th><th class="num">Leistung</th></tr>`;
    for (const [, st] of result.steps) {
      const r = st.recipe, b = BUILDINGS[r.bld], cf = clockFor(r.id);
      const ck   = state.stepClocks[r.id] !== undefined ? state.stepClocks[r.id] : state.globalClock;
      const base = r.pow != null ? r.pow : (b ? b.power : 0);
      const pw   = st.machines * base * Math.pow(cf, b ? b.exp : 1.321929);
      const main = r.out[0][0];
      const out  = (r.out[0][1] * 60 / r.time) * cf * st.machines;
      html += `<tr>
        <td><strong>${esc(itemName(main))}</strong></td>
        <td><select class="recipe-select" data-item="${main}">${recipeOpts(main, r)}</select>${ingrPills(r, st.machines)}</td>
        <td>${esc(b ? b.name : "?")}</td>
        <td class="num">${fmt(st.machines, 3)}<br><span class="muted">(${Math.ceil(st.machines - 1e-9)}×)</span></td>
        <td class="num">${fmt(out)}${unit(main)}</td>
        <td class="clock-cell"><input type="number" class="step-clock" data-rid="${esc(r.id)}" min="1" max="250" step="1" value="${ck}" style="width:62px"> %</td>
        <td class="num">${fmt(pw, 1)} MW</td>
      </tr>`;
    }
    html += "</table>";
    elSteps.innerHTML = html;
    elSteps.querySelectorAll(".recipe-select").forEach(s => {
      s.addEventListener("change", () => { state.recipeChoice[s.dataset.item] = s.value; update(); });
    });
    elSteps.querySelectorAll(".step-clock").forEach(inp => {
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        if (v >= 1 && v <= 250) { state.stepClocks[inp.dataset.rid] = v; update(); }
      });
    });
  }

  // ── Raw/byproduct tables ───────────────────────────────────────────────────
  function renderMap(el, map, emptyText) {
    const entries = [...map.entries()].filter(([, v]) => v > 1e-6).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { el.innerHTML = `<p class="muted">${emptyText}</p>`; return; }
    let html = `<table class="small-table"><tr><th>Item</th><th class="num">Menge</th></tr>`;
    for (const [item, rate] of entries)
      html += `<tr><td>
        <span style="display:inline-flex;align-items:center;gap:5px">
          <img src="${esc(wikiUrl(item))}" alt="" loading="lazy" width="18" height="18"
            style="object-fit:contain;vertical-align:middle" onerror="this.style.display='none'">
          ${esc(itemName(item))}
        </span></td>
        <td class="num" style="color:${hexCol(item)}">${fmt(rate)}${unit(item)}</td></tr>`;
    el.innerHTML = html + "</table>";
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  function renderSummary(result) {
    const machines = [...result.steps.values()].reduce((a, s) => a + Math.ceil(s.machines - 1e-9), 0);
    const multLabel = state.costMult !== 1
      ? `<div class="card"><div class="label">Rezeptkosten-Mult.</div><div class="value" style="color:var(--warn)">${fmt(state.costMult, 2)}×</div></div>`
      : "";
    elSummary.innerHTML =
      `<div class="summary-cards">
        <div class="card"><div class="label">Maschinen gesamt</div><div class="value">${machines}</div></div>
        <div class="card"><div class="label">Leistung gesamt</div><div class="value">${fmt(result.power, 1)} MW</div></div>
        <div class="card"><div class="label">Produktionsschritte</div><div class="value">${result.steps.size}</div></div>
        ${multLabel}
      </div>` +
      (result.unstable ? '<p class="warn">⚠ Möglicher Rezeptzyklus erkannt.</p>' : "");
  }

  // ── Resource calculator ────────────────────────────────────────────────────
  function renderResourceInputs(result) {
    if (!result.raws.size) {
      elResInputs.innerHTML = '<p class="muted">Keine Rohstoffe benötigt.</p>';
      return;
    }
    const entries = [...result.raws.entries()].sort((a, b) => b[1] - a[1]);
    let html = '<div class="resource-grid">';
    for (const [item, needed] of entries) {
      const col  = hexCol(item);
      const avail = state.resources[item];
      const ab   = abbr(itemName(item));
      html += `<div class="resource-row">
        <img src="${esc(wikiUrl(item))}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <span class="r-icon" style="display:none;background:${col}22;color:${col};border:1px solid ${col}">${esc(ab)}</span>
        <span class="r-name">${esc(itemName(item))}</span>
        <span class="r-needed">benötigt: ${fmt(needed)}${unit(item)}</span>
        <input type="number" min="0" step="any" placeholder="∞"
          value="${avail !== undefined ? avail : ""}"
          data-item="${esc(item)}">
      </div>`;
    }
    html += "</div>";
    elResInputs.innerHTML = html;

    elResInputs.querySelectorAll("input[data-item]").forEach(inp => {
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        if (!isNaN(v) && v >= 0) state.resources[inp.dataset.item] = v;
        else delete state.resources[inp.dataset.item];
        saveState();
      });
    });
  }

  function calculateMax(result) {
    elResResult.innerHTML = "";
    const entries = [...result.raws.entries()];
    const limited = entries
      .filter(([item]) => state.resources[item] !== undefined)
      .map(([item, needed]) => ({
        item, needed,
        avail: state.resources[item],
        mult: needed > 0 ? state.resources[item] / needed : Infinity,
      }));

    if (!limited.length) {
      elResResult.innerHTML = '<p class="muted">Gib zuerst verfügbare Rohstoffmengen ein.</p>';
      return;
    }

    limited.sort((a, b) => a.mult - b.mult);
    const maxMult = limited[0].mult;
    const bottleneck = limited[0];

    // Target rates at max
    const maxTargets = state.targets.map(t => ({ ...t, rate: t.rate * maxMult }));
    const maxRes = solve(maxTargets);

    let html = `<div class="result-box">
      <div>Maximaler Multiplikator: <span class="r-mult">${fmt(maxMult, 3)}×</span></div>
      <div class="r-bottleneck">⚠ Engpass: <strong>${esc(itemName(bottleneck.item))}</strong>
        — ${fmt(bottleneck.avail)}${unit(bottleneck.item)} verfügbar ÷ ${fmt(bottleneck.needed)}${unit(bottleneck.item)} benötigt = ${fmt(maxMult, 2)}×
      </div>
      <div><strong>Maximale Produktionsraten:</strong></div>
      <div class="r-targets">`;
    for (const t of state.targets) {
      if (!t.item || !t.rate) continue;
      html += `<div class="r-target-pill">${esc(itemName(t.item))}: <span>${fmt(t.rate * maxMult)}/min</span></div>`;
    }
    html += `</div>
      <button id="btn-apply-max" class="btn btn-sm" style="margin-top:10px">Diese Werte als Ziele übernehmen</button>
      <div class="result-all-mult" style="margin-top:10px"><strong>Alle Rohstoffe:</strong>`;
    const barMax = Math.max(...limited.map(l => l.mult), 1);
    for (const l of limited) {
      const pct = Math.min(100, (l.mult / barMax) * 100);
      const isBot = l === bottleneck;
      html += `<div class="mult-row${isBot ? " bottleneck" : ""}">
        <div class="m-bar" style="width:${pct.toFixed(0)}px"></div>
        <span>${esc(itemName(l.item))}: ${fmt(l.avail)}/${fmt(l.needed)} = ${fmt(l.mult, 2)}×</span>
      </div>`;
    }
    html += "</div></div>";
    elResResult.innerHTML = html;

    document.getElementById("btn-apply-max").addEventListener("click", () => {
      state.targets.forEach(t => { t.rate = t.rate * maxMult; });
      renderTargets();
      update();
    });
  }

  elBtnCalc.addEventListener("click", () => { if (lastResult) calculateMax(lastResult); });
  elBtnClear.addEventListener("click", () => { state.resources = {}; elResResult.innerHTML = ""; if (lastResult) renderResourceInputs(lastResult); });

  // ── Flowchart (SVG mindmap) ────────────────────────────────────────────────
  const NODE = { IW: 162, IH: 48, MW: 196, MH: 80, colGap: 52, rowGap: 18 };

  // Pan/zoom
  let fc = { tx: 20, ty: 20, scale: 1, drag: false, ox: 0, oy: 0 };
  function fcApply() {
    const g = document.getElementById("fc-vp");
    if (g) g.setAttribute("transform", `translate(${fc.tx},${fc.ty}) scale(${fc.scale})`);
  }
  function fcFit(bounds) {
    const cW = elFlowWrap.clientWidth  || 900;
    const cH = elFlowWrap.clientHeight || 620;
    const pad = 28;
    const scaleW = (cW - pad * 2) / Math.max(bounds.w, 1);
    const scaleH = (cH - pad * 2) / Math.max(bounds.h, 1);
    // Aim for at least 0.45 so nodes are readable; don't exceed 1.5
    fc.scale = Math.max(0.45, Math.min(scaleW, scaleH, 1.5));
    const rendW = bounds.w * fc.scale;
    const rendH = bounds.h * fc.scale;
    // Horizontal: center if it fits, else align to left edge
    fc.tx = rendW < cW - pad * 2
      ? pad + (cW - pad * 2 - rendW) / 2 - bounds.minX * fc.scale
      : pad - bounds.minX * fc.scale;
    // Vertical: center
    fc.ty = pad + Math.max(0, (cH - pad * 2 - rendH) / 2) - bounds.minY * fc.scale;
  }

  function initFcInteraction() {
    elFlowWrap.addEventListener("wheel", e => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      fc.scale = Math.max(0.1, Math.min(5, fc.scale * f));
      fcApply();
    }, { passive: false });
    elFlowWrap.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      fc.drag = true; fc.ox = e.clientX - fc.tx; fc.oy = e.clientY - fc.ty;
    });
    window.addEventListener("mousemove", e => {
      if (!fc.drag) return;
      fc.tx = e.clientX - fc.ox; fc.ty = e.clientY - fc.oy; fcApply();
    });
    window.addEventListener("mouseup", () => { fc.drag = false; });
    // Touch
    let pinchD = 0;
    elFlowWrap.addEventListener("touchstart", e => {
      if (e.touches.length === 1) { fc.drag = true; fc.ox = e.touches[0].clientX - fc.tx; fc.oy = e.touches[0].clientY - fc.ty; }
      else if (e.touches.length === 2) { fc.drag = false; pinchD = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }
    }, { passive: true });
    elFlowWrap.addEventListener("touchmove", e => {
      if (e.touches.length === 1 && fc.drag) { fc.tx = e.touches[0].clientX - fc.ox; fc.ty = e.touches[0].clientY - fc.oy; fcApply(); }
      else if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        fc.scale = Math.max(0.1, Math.min(5, fc.scale * (d / pinchD))); pinchD = d; fcApply();
      }
    }, { passive: true });
    elFlowWrap.addEventListener("touchend", () => { fc.drag = false; });
  }

  elFlowFit.addEventListener("click", () => {
    if (lastResult) renderFlowchart(lastResult, true);
  });
  elFlowReset.addEventListener("click", () => {
    fc = { tx: 20, ty: 20, scale: 1, drag: false, ox: 0, oy: 0 };
    if (lastResult) renderFlowchart(lastResult, false);
    else fcApply();
  });

  // Build graph from solver result
  function buildGraph(result) {
    const nodes = new Map();   // id → node
    const edges = [];

    function ensureItem(item) {
      const id = "I:" + item;
      if (!nodes.has(id))
        nodes.set(id, { id, kind: "item", item, label: itemName(item), liq: isLiq(item), raw: result.raws.has(item), inRate: 0, outRate: 0 });
      return id;
    }

    for (const [rid, st] of result.steps) {
      const r  = st.recipe;
      const b  = BUILDINGS[r.bld];
      const cf = clockFor(r.id);
      const ck = state.stepClocks[r.id] !== undefined ? state.stepClocks[r.id] : state.globalClock;
      const base = r.pow != null ? r.pow : (b ? b.power : 0);
      const pw = st.machines * base * Math.pow(cf, b ? b.exp : 1.321929);
      const mid = "M:" + rid;

      nodes.set(mid, {
        id: mid, kind: "machine",
        bld: b ? b.name : "?",
        rec: r.name.replace(/^Alternate:\s*/, ""),
        machines: st.machines, clock: ck, power: pw,
      });

      for (const [item, amt] of r.in) {
        const rate = (amt * 60 / r.time) * cf * st.machines * state.costMult;
        const iid  = ensureItem(item);
        nodes.get(iid).outRate += rate;
        edges.push({ from: iid, to: mid, rate, liq: isLiq(item) });
      }
      for (const [item, amt] of r.out) {
        const rate = (amt * 60 / r.time) * cf * st.machines;
        const iid  = ensureItem(item);
        nodes.get(iid).inRate += rate;
        edges.push({ from: mid, to: iid, rate, liq: isLiq(item) });
      }
    }
    for (const [item, rate] of result.raws) {
      const iid = ensureItem(item);
      nodes.get(iid).outRate = rate;
    }
    return { nodes, edges };
  }

  // Layered layout: raw items=rank 0, propagate through edges
  function layout(nodes, edges) {
    const rank = new Map();
    for (const [id, n] of nodes)
      if (n.kind === "item" && n.raw) rank.set(id, 0);

    let changed = true;
    for (let i = 0; changed && i < 600; i++) {
      changed = false;
      for (const e of edges) {
        const sr = rank.get(e.from);
        if (sr === undefined) continue;
        const tr = rank.get(e.to), need = sr + 1;
        if (tr === undefined || tr < need) { rank.set(e.to, need); changed = true; }
      }
    }
    for (const [id] of nodes) if (!rank.has(id)) rank.set(id, 0);

    // Group by rank
    const layers = new Map();
    for (const [id] of nodes) {
      const r = rank.get(id);
      (layers.has(r) ? layers.get(r) : layers.set(r, []).get(r)).push(id);
    }

    // Column x positions (items narrower, machines wider)
    const maxRank = Math.max(...rank.values(), 0);
    const colX = [];
    let x = 0;
    for (let r = 0; r <= maxRank; r++) {
      colX[r] = x;
      const isMach = (layers.get(r) || []).some(id => nodes.get(id).kind === "machine");
      x += (isMach ? NODE.MW : NODE.IW) + NODE.colGap;
    }

    // Initial y positions
    const pos = new Map();
    for (const [r, ids] of layers)
      ids.forEach((id, i) => pos.set(id, { x: colX[r], y: i * (NODE.IH + NODE.rowGap) + 10 }));

    // 4 passes of barycenter ordering + enforce minimum spacing
    for (let pass = 0; pass < 4; pass++) {
      for (const [r, ids] of layers) {
        const scored = ids.map(id => {
          const nbr = edges
            .filter(e => e.from === id || e.to === id)
            .map(e => e.from === id ? e.to : e.from)
            .map(nid => (pos.get(nid) || { y: 0 }).y);
          const avg = nbr.length ? nbr.reduce((a, b) => a + b, 0) / nbr.length : (pos.get(id) || { y: 0 }).y;
          return { id, avg };
        }).sort((a, b) => a.avg - b.avg);

        let curY = 10;
        for (const { id } of scored) {
          const h = nodes.get(id).kind === "machine" ? NODE.MH : NODE.IH;
          pos.set(id, { x: colX[r], y: curY });
          curY += h + NODE.rowGap;
        }
      }
    }

    // Compute content bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [id, n] of nodes) {
      const p = pos.get(id);
      if (!p) continue;
      const w = n.kind === "machine" ? NODE.MW : NODE.IW;
      const h = n.kind === "machine" ? NODE.MH : NODE.IH;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
    }
    return { pos, bounds: { minX: minX || 0, minY: minY || 0, w: (maxX - minX) || 100, h: (maxY - minY) || 100 } };
  }

  // Render SVG
  function renderFlowchart(result, fit) {
    if (!result || !result.steps.size) {
      elFlow.innerHTML = `<text x="20" y="40" fill="#9aa3b2" font-size="14" font-family="Segoe UI,sans-serif">Füge Produktionsziele hinzu, um den Fluss zu sehen.</text>`;
      return;
    }

    const { nodes, edges } = buildGraph(result);
    const { pos, bounds }  = layout(nodes, edges);

    if (fit) fcFit(bounds);

    const cW = elFlowWrap.clientWidth  || 900;
    const cH = elFlowWrap.clientHeight || 560;
    elFlow.setAttribute("viewBox", `0 0 ${cW} ${cH}`);
    elFlow.setAttribute("width",  cW);
    elFlow.setAttribute("height", cH);

    const defs = `<defs>
      <marker id="arr"     markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
        <path d="M0,0 L0,8 L10,4 z" fill="#4a5568"/>
      </marker>
      <marker id="arr-liq" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
        <path d="M0,0 L0,8 L10,4 z" fill="#56cfe1"/>
      </marker>
    </defs>`;

    // ── Edges ──
    let edgeSvg = "";
    for (const e of edges) {
      const sp = pos.get(e.from), tp = pos.get(e.to);
      if (!sp || !tp) continue;
      const sn = nodes.get(e.from), tn = nodes.get(e.to);
      const sw = sn.kind === "machine" ? NODE.MW : NODE.IW;
      const sh = sn.kind === "machine" ? NODE.MH : NODE.IH;
      const th = tn.kind === "machine" ? NODE.MH : NODE.IH;
      const sx = sp.x + sw, sy = sp.y + sh / 2;
      const tx = tp.x,     ty = tp.y + th / 2;
      const dx = (tx - sx) * 0.45;
      const stroke = e.liq ? "#56cfe1" : "#4a5568";
      const marker = e.liq ? "url(#arr-liq)" : "url(#arr)";
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      edgeSvg += `
        <path d="M${sx},${sy} C${sx+dx},${sy} ${tx-dx},${ty} ${tx},${ty}"
          fill="none" stroke="${stroke}" stroke-width="2" marker-end="${marker}" opacity="0.8"/>
        <text x="${mx}" y="${my - 5}" text-anchor="middle" font-size="9.5"
          fill="${stroke}" font-family="Segoe UI,sans-serif" opacity="0.95">
          ${fmt(e.rate)}${e.liq ? " m³" : ""}/min
        </text>`;
    }

    // ── Nodes ──
    let nodeSvg = "";
    for (const [id, n] of nodes) {
      const p = pos.get(id);
      if (!p) continue;

      if (n.kind === "machine") {
        const { x, y } = p;
        const W = NODE.MW, H = NODE.MH;
        nodeSvg += `
          <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="8"
            fill="#2b303b" stroke="#fa9549" stroke-width="1.8"/>
          <rect x="${x+1}" y="${y+1}" width="${W-2}" height="24" rx="7"
            fill="#fa954930"/>
          <rect x="${x+1}" y="${y+18}" width="${W-2}" height="8"
            fill="#fa954318"/>
          <text x="${x+W/2}" y="${y+17}" text-anchor="middle" dominant-baseline="middle"
            font-size="12" font-weight="700" fill="#fa9549" font-family="Segoe UI,sans-serif">
            ${esc(n.bld)}
          </text>
          <text x="${x+W/2}" y="${y+38}" text-anchor="middle" dominant-baseline="middle"
            font-size="10" fill="#c5c9d4" font-family="Segoe UI,sans-serif">
            ${esc(trunc(n.rec, 28))}
          </text>
          <text x="${x+W/2}" y="${y+56}" text-anchor="middle" dominant-baseline="middle"
            font-size="11" fill="#6fcf7c" font-family="Segoe UI,sans-serif">
            ${fmt(n.machines, 2)}× (${Math.ceil(n.machines - 1e-9)} Stk.)
          </text>
          <text x="${x+W/2}" y="${y+72}" text-anchor="middle" dominant-baseline="middle"
            font-size="9.5" fill="#9aa3b2" font-family="Segoe UI,sans-serif">
            Taktung ${n.clock} % · ${fmt(n.power, 1)} MW
          </text>`;
      } else {
        const { x, y } = p;
        const W = NODE.IW, H = NODE.IH;
        const col  = hexCol(n.item);
        const ab   = abbr(n.label);
        const r    = H / 2;
        // Display rate: raw items show their outRate, products show inRate
        const displayRate = n.raw ? n.outRate : n.inRate;
        const rateStr = (displayRate > 0 ? fmt(displayRate) : "–") + (n.liq ? " m³" : "") + "/min";

        nodeSvg += `
          <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="${r}"
            fill="${col}18" stroke="${col}" stroke-width="1.8"/>
          <circle cx="${x+r}" cy="${y+r}" r="${r-5}"
            fill="${col}30" stroke="${col}" stroke-width="1.2"/>
          <text x="${x+r}" y="${y+r}" text-anchor="middle" dominant-baseline="middle"
            font-size="11" font-weight="800" fill="${col}" font-family="Segoe UI,sans-serif">
            ${esc(ab)}
          </text>
          <text x="${x+H+4}" y="${y+16}" dominant-baseline="middle"
            font-size="10.5" font-weight="600" fill="${col}" font-family="Segoe UI,sans-serif">
            ${esc(trunc(n.label, 17))}
          </text>
          <text x="${x+H+4}" y="${y+34}" dominant-baseline="middle"
            font-size="9.5" fill="${col}bb" font-family="Segoe UI,sans-serif">
            ${esc(rateStr)}
          </text>
          ${n.raw ? `<text x="${x+W-6}" y="${y+H/2}" text-anchor="end" dominant-baseline="middle"
            font-size="8" fill="${col}88" font-family="Segoe UI,sans-serif">Rohstoff</text>` : ""}`;
      }
    }

    elFlow.innerHTML = defs +
      `<g id="fc-vp" transform="translate(${fc.tx},${fc.ty}) scale(${fc.scale})">${edgeSvg}${nodeSvg}</g>`;
  }

  // ── Main update ────────────────────────────────────────────────────────────
  let lastResult = null;

  function update() {
    const result = solve(state.targets);
    lastResult = result;
    renderSummary(result);
    renderSteps(result);
    renderMap(elRaws, result.raws, "Keine Rohstoffe benötigt.");
    renderMap(elBy, result.byproducts, "Keine Nebenprodukte.");
    renderResourceInputs(result);
    renderFlowchart(result, false);
    saveState();
  }

  initFcInteraction();
  renderTargets();
  // First render with auto-fit so the graph is visible
  const firstResult = solve(state.targets);
  lastResult = firstResult;
  renderSummary(firstResult);
  renderSteps(firstResult);
  renderMap(elRaws, firstResult.raws, "Keine Rohstoffe benötigt.");
  renderMap(elBy, firstResult.byproducts, "Keine Nebenprodukte.");
  renderResourceInputs(firstResult);
  renderFlowchart(firstResult, true);
  saveState();
})();
