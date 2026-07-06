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
  const allItems = Object.keys(ITEMS).sort((a, b) => ITEMS[a].name.localeCompare(ITEMS[b].name));
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
    resources:   {},  // item → available rate (both plan-required and manually added)
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
    if (isLiq(item))                    return "#56cfe1";
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
  function sid(id) { return "fc_" + id.replace(/[^a-zA-Z0-9]/g, "_"); }

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
  const elCostMult  = document.getElementById("cost-mult");
  const elResInputs = document.getElementById("resource-inputs");
  const elBtnAddRes = document.getElementById("btn-add-resource");
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
      row.querySelector("select").addEventListener("change", e => { t.item = e.target.value; fcCustomPos = {}; update(); });
      row.querySelector("input").addEventListener("input", e => { t.rate = parseFloat(e.target.value) || 0; update(); });
      row.querySelector(".btn-remove").addEventListener("click", () => { state.targets.splice(idx, 1); renderTargets(); fcCustomPos = {}; update(); });
      elTargets.appendChild(row);
    });
  }
  elAdd.addEventListener("click", () => { state.targets.push({ item: producibleItems[0], rate: 10 }); renderTargets(); fcCustomPos = {}; update(); });

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
      s.addEventListener("change", () => { state.recipeChoice[s.dataset.item] = s.value; fcCustomPos = {}; update(); });
    });
    elSteps.querySelectorAll(".step-clock").forEach(inp => {
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        if (v >= 1 && v <= 250) { state.stepClocks[inp.dataset.rid] = v; update(); }
      });
    });
  }

  // ── Map tables ─────────────────────────────────────────────────────────────
  function renderMap(el, map, emptyText) {
    const entries = [...map.entries()].filter(([, v]) => v > 1e-6).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { el.innerHTML = `<p class="muted">${emptyText}</p>`; return; }
    let html = `<table class="small-table"><tr><th>Item</th><th class="num">Menge</th></tr>`;
    for (const [item, rate] of entries)
      html += `<tr><td><span style="display:inline-flex;align-items:center;gap:5px">
        <img src="${esc(wikiUrl(item))}" alt="" loading="lazy" width="18" height="18"
          style="object-fit:contain;vertical-align:middle" onerror="this.style.display='none'">
        ${esc(itemName(item))}</span></td>
        <td class="num" style="color:${hexCol(item)}">${fmt(rate)}${unit(item)}</td></tr>`;
    el.innerHTML = html + "</table>";
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  function renderSummary(result) {
    const machines = [...result.steps.values()].reduce((a, s) => a + Math.ceil(s.machines - 1e-9), 0);
    const multCard = state.costMult !== 1
      ? `<div class="card"><div class="label">Rezeptkosten-Mult.</div><div class="value" style="color:var(--warn)">${fmt(state.costMult, 2)}×</div></div>`
      : "";
    elSummary.innerHTML =
      `<div class="summary-cards">
        <div class="card"><div class="label">Maschinen gesamt</div><div class="value">${machines}</div></div>
        <div class="card"><div class="label">Leistung gesamt</div><div class="value">${fmt(result.power, 1)} MW</div></div>
        <div class="card"><div class="label">Produktionsschritte</div><div class="value">${result.steps.size}</div></div>
        ${multCard}
      </div>` +
      (result.unstable ? '<p class="warn">⚠ Möglicher Rezeptzyklus erkannt.</p>' : "");
  }

  // ── Resource panel ─────────────────────────────────────────────────────────
  function renderResourceInputs(result) {
    // Collect all items to show: union of plan-required raws + manually set resources
    const planRaws = new Map(result.raws);
    const allResItems = new Set([...planRaws.keys(), ...Object.keys(state.resources)]);

    if (!allResItems.size) {
      elResInputs.innerHTML = '<p class="muted">Keine Rohstoffe vorhanden.</p>';
      return;
    }

    const entries = [...allResItems].sort((a, b) => {
      // Plan-required first, then manual-only
      const ap = planRaws.has(a) ? 0 : 1, bp = planRaws.has(b) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return itemName(a).localeCompare(itemName(b));
    });

    let html = '<div class="resource-grid">';
    for (const item of entries) {
      const needed = planRaws.get(item) || 0;
      const avail  = state.resources[item];
      const col    = hexCol(item);
      const manualOnly = !planRaws.has(item);
      html += `<div class="resource-row${manualOnly ? " manual-row" : ""}">
        <img src="${esc(wikiUrl(item))}" alt="" loading="lazy"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <span class="r-icon" style="display:none;background:${col}22;color:${col};border:1px solid ${col}">${esc(abbr(itemName(item)))}</span>
        <span class="r-name">${esc(itemName(item))}${manualOnly ? ' <em class="muted" style="font-size:.75rem">(manuell)</em>' : ''}</span>
        <span class="r-needed">${needed > 0 ? "benötigt: " + fmt(needed) + unit(item) : "—"}</span>
        <input type="number" min="0" step="any" placeholder="∞"
          value="${avail !== undefined ? avail : ""}"
          data-item="${esc(item)}">
        <button class="btn-remove r-remove" data-item="${esc(item)}" title="Entfernen">✕</button>
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
    elResInputs.querySelectorAll(".r-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        delete state.resources[btn.dataset.item];
        saveState();
        if (lastResult) renderResourceInputs(lastResult);
      });
    });
  }

  // Add-resource form
  function showAddResourceForm() {
    const existing = document.getElementById("add-res-form");
    if (existing) { existing.remove(); return; }

    const form = document.createElement("div");
    form.id = "add-res-form";
    form.className = "add-res-form";
    form.innerHTML =
      `<select id="add-res-item" style="min-width:200px">
        <option value="">— Item wählen —</option>
        ${allItems.map(c => `<option value="${c}">${esc(itemName(c))}</option>`).join("")}
      </select>
      <input type="number" id="add-res-amt" min="0" step="any" placeholder="Menge/min" style="width:110px">
      <button id="confirm-add-res" class="btn btn-sm">Hinzufügen</button>
      <button id="cancel-add-res" class="btn btn-sm btn-alt">✕</button>`;
    elBtnAddRes.insertAdjacentElement("afterend", form);

    document.getElementById("confirm-add-res").addEventListener("click", () => {
      const item = document.getElementById("add-res-item").value;
      const amt  = parseFloat(document.getElementById("add-res-amt").value);
      if (!item) return;
      state.resources[item] = isNaN(amt) || amt < 0 ? undefined : amt;
      if (state.resources[item] === undefined) delete state.resources[item];
      else saveState();
      form.remove();
      if (lastResult) renderResourceInputs(lastResult);
    });
    document.getElementById("cancel-add-res").addEventListener("click", () => form.remove());
  }

  function calculateMax(result) {
    elResResult.innerHTML = "";
    const limited = [...result.raws.entries()]
      .filter(([item]) => state.resources[item] !== undefined)
      .map(([item, needed]) => ({
        item, needed, avail: state.resources[item],
        mult: needed > 0 ? state.resources[item] / needed : Infinity,
      }));

    // Also check manually-added resources not in plan (they're unlimited sources, ignored)
    if (!limited.length) {
      elResResult.innerHTML = '<p class="muted">Gib verfügbare Mengen bei Rohstoffen ein, dann berechnen.</p>';
      return;
    }
    limited.sort((a, b) => a.mult - b.mult);
    const maxMult = limited[0].mult;
    const bottleneck = limited[0];

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
      <div class="result-all-mult" style="margin-top:10px"><strong>Alle eingetragenen Rohstoffe:</strong>`;
    const barMax = Math.max(...limited.map(l => l.mult), 1);
    for (const l of limited) {
      const pct = Math.min(100, (l.mult / barMax) * 100).toFixed(0);
      html += `<div class="mult-row${l === bottleneck ? " bottleneck" : ""}">
        <div class="m-bar" style="width:${pct}px"></div>
        <span>${esc(itemName(l.item))}: ${fmt(l.avail)} ÷ ${fmt(l.needed)} = ${fmt(l.mult, 2)}×</span>
      </div>`;
    }
    html += "</div></div>";
    elResResult.innerHTML = html;

    document.getElementById("btn-apply-max").addEventListener("click", () => {
      state.targets.forEach(t => { t.rate = parseFloat(fmt(t.rate * maxMult, 4).replace(",", ".")) || t.rate * maxMult; });
      renderTargets(); fcCustomPos = {}; update();
    });
  }

  elBtnAddRes.addEventListener("click", showAddResourceForm);
  elBtnCalc.addEventListener("click", () => { if (lastResult) calculateMax(lastResult); });
  elBtnClear.addEventListener("click", () => {
    state.resources = {}; elResResult.innerHTML = "";
    if (lastResult) renderResourceInputs(lastResult);
    saveState();
  });

  // ── Flowchart ──────────────────────────────────────────────────────────────
  const NODE = { IW: 162, IH: 48, MW: 196, MH: 80, colGap: 52, rowGap: 18 };

  // Pan/zoom transform
  let fc = { tx: 20, ty: 20, scale: 1, drag: false, ox: 0, oy: 0 };
  // Custom node positions set by dragging
  let fcCustomPos = {};
  // Current graph + layout (for edge redraws on drag)
  let fcGraph     = null;
  let fcLayoutPos = {};  // nodeId → {x, y} from auto-layout

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
    fc.scale = Math.max(0.45, Math.min(scaleW, scaleH, 1.5));
    const rendW = bounds.w * fc.scale;
    const rendH = bounds.h * fc.scale;
    fc.tx = rendW < cW - pad * 2
      ? pad + (cW - pad * 2 - rendW) / 2 - bounds.minX * fc.scale
      : pad - bounds.minX * fc.scale;
    fc.ty = pad + Math.max(0, (cH - pad * 2 - rendH) / 2) - bounds.minY * fc.scale;
  }

  // Convert screen coords to SVG-viewport coords (accounting for pan/zoom)
  function screenToSvg(clientX, clientY) {
    const r = elFlowWrap.getBoundingClientRect();
    return {
      x: (clientX - r.left - fc.tx) / fc.scale,
      y: (clientY - r.top  - fc.ty) / fc.scale,
    };
  }

  // Get effective position of a node (custom if dragged, else auto-layout)
  function nodePos(id) {
    return fcCustomPos[id] || fcLayoutPos[id] || { x: 0, y: 0 };
  }

  // Recalculate and update SVG path for one edge
  function refreshEdge(edge) {
    if (!fcGraph) return;
    const fp = nodePos(edge.from);
    const tp = nodePos(edge.to);
    const fn = fcGraph.nodes.get(edge.from);
    const tn = fcGraph.nodes.get(edge.to);
    if (!fp || !tp || !fn || !tn) return;
    const sw = fn.kind === "machine" ? NODE.MW : NODE.IW;
    const sh = fn.kind === "machine" ? NODE.MH : NODE.IH;
    const th = tn.kind === "machine" ? NODE.MH : NODE.IH;
    const sx = fp.x + sw, sy = fp.y + sh / 2;
    const tx = tp.x,     ty = tp.y + th / 2;
    const dx = (tx - sx) * 0.45;
    const eid = sid(edge.from) + "__" + sid(edge.to);
    const pathEl = document.getElementById("ep_" + eid);
    if (pathEl) pathEl.setAttribute("d", `M${sx},${sy} C${sx+dx},${sy} ${tx-dx},${ty} ${tx},${ty}`);
    const lblEl = document.getElementById("el_" + eid);
    if (lblEl) {
      lblEl.setAttribute("x", (sx + tx) / 2);
      lblEl.setAttribute("y", (sy + ty) / 2 - 5);
    }
  }

  // ── Interaction (pan + node drag) ──────────────────────────────────────────
  let dragNodeId   = null;
  let dragSvgStart = null;
  let dragNodeStart= null;

  function initFcInteraction() {
    // Wheel zoom
    elFlowWrap.addEventListener("wheel", e => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      fc.scale = Math.max(0.1, Math.min(5, fc.scale * f));
      fcApply();
    }, { passive: false });

    // Mouse down
    elFlowWrap.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      const nodeEl = e.target.closest("[data-nodeid]");
      if (nodeEl) {
        // Start node drag
        dragNodeId    = nodeEl.dataset.nodeid;
        dragSvgStart  = screenToSvg(e.clientX, e.clientY);
        const p       = nodePos(dragNodeId);
        dragNodeStart = { x: p.x, y: p.y };
        e.stopPropagation();
      } else {
        // Start pan
        fc.drag = true;
        fc.ox   = e.clientX - fc.tx;
        fc.oy   = e.clientY - fc.ty;
      }
    });

    window.addEventListener("mousemove", e => {
      if (dragNodeId) {
        const cur = screenToSvg(e.clientX, e.clientY);
        const newX = dragNodeStart.x + (cur.x - dragSvgStart.x);
        const newY = dragNodeStart.y + (cur.y - dragSvgStart.y);
        fcCustomPos[dragNodeId] = { x: newX, y: newY };
        // Move node element
        const nodeEl = document.querySelector(`[data-nodeid="${CSS.escape(dragNodeId)}"]`);
        if (nodeEl) nodeEl.setAttribute("transform", `translate(${newX},${newY})`);
        // Redraw connected edges
        if (fcGraph) {
          for (const edge of fcGraph.edges) {
            if (edge.from === dragNodeId || edge.to === dragNodeId) refreshEdge(edge);
          }
        }
      } else if (fc.drag) {
        fc.tx = e.clientX - fc.ox;
        fc.ty = e.clientY - fc.oy;
        fcApply();
      }
    });

    window.addEventListener("mouseup", () => {
      dragNodeId = null; dragSvgStart = null; dragNodeStart = null;
      fc.drag    = false;
    });

    // Touch support
    let touchNodeId = null, touchSvgStart = null, touchNodeStart = null;
    let pinchDist = 0;

    elFlowWrap.addEventListener("touchstart", e => {
      if (e.touches.length === 1) {
        const touch   = e.touches[0];
        const nodeEl  = document.elementFromPoint(touch.clientX, touch.clientY)?.closest("[data-nodeid]");
        if (nodeEl) {
          touchNodeId    = nodeEl.dataset.nodeid;
          touchSvgStart  = screenToSvg(touch.clientX, touch.clientY);
          const p        = nodePos(touchNodeId);
          touchNodeStart = { x: p.x, y: p.y };
        } else {
          fc.drag = true;
          fc.ox   = touch.clientX - fc.tx;
          fc.oy   = touch.clientY - fc.ty;
        }
      } else if (e.touches.length === 2) {
        fc.drag = false; touchNodeId = null;
        pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
    }, { passive: true });

    elFlowWrap.addEventListener("touchmove", e => {
      if (e.touches.length === 1) {
        const touch = e.touches[0];
        if (touchNodeId) {
          const cur = screenToSvg(touch.clientX, touch.clientY);
          const newX = touchNodeStart.x + (cur.x - touchSvgStart.x);
          const newY = touchNodeStart.y + (cur.y - touchSvgStart.y);
          fcCustomPos[touchNodeId] = { x: newX, y: newY };
          const nodeEl = document.querySelector(`[data-nodeid="${CSS.escape(touchNodeId)}"]`);
          if (nodeEl) nodeEl.setAttribute("transform", `translate(${newX},${newY})`);
          if (fcGraph) for (const edge of fcGraph.edges)
            if (edge.from === touchNodeId || edge.to === touchNodeId) refreshEdge(edge);
        } else if (fc.drag) {
          fc.tx = touch.clientX - fc.ox;
          fc.ty = touch.clientY - fc.oy;
          fcApply();
        }
      } else if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        fc.scale = Math.max(0.1, Math.min(5, fc.scale * (d / pinchDist)));
        pinchDist = d; fcApply();
      }
    }, { passive: true });

    elFlowWrap.addEventListener("touchend", () => {
      touchNodeId = null; fc.drag = false;
    });
  }

  elFlowFit.addEventListener("click", () => { if (lastResult) renderFlowchart(lastResult, true); });
  elFlowReset.addEventListener("click", () => {
    fcCustomPos = {};
    fc = { tx: 20, ty: 20, scale: 1, drag: false, ox: 0, oy: 0 };
    if (lastResult) renderFlowchart(lastResult, true);
  });

  // ── Graph builder ──────────────────────────────────────────────────────────
  function buildGraph(result) {
    const nodes = new Map();
    const edges = [];

    function ensureItem(item) {
      const id = "I:" + item;
      if (!nodes.has(id))
        nodes.set(id, { id, kind: "item", item, label: itemName(item), liq: isLiq(item), raw: result.raws.has(item), inRate: 0, outRate: 0 });
      return id;
    }

    for (const [rid, st] of result.steps) {
      const r = st.recipe, b = BUILDINGS[r.bld], cf = clockFor(r.id);
      const ck = state.stepClocks[r.id] !== undefined ? state.stepClocks[r.id] : state.globalClock;
      const base = r.pow != null ? r.pow : (b ? b.power : 0);
      const pw = st.machines * base * Math.pow(cf, b ? b.exp : 1.321929);
      const mid = "M:" + rid;
      nodes.set(mid, { id: mid, kind: "machine", bld: b ? b.name : "?", rec: r.name.replace(/^Alternate:\s*/, ""), machines: st.machines, clock: ck, power: pw });

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

  // ── Layout ─────────────────────────────────────────────────────────────────
  function layout(nodes, edges) {
    const rank = new Map();
    for (const [id, n] of nodes) if (n.kind === "item" && n.raw) rank.set(id, 0);
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

    const layers = new Map();
    for (const [id] of nodes) {
      const r = rank.get(id);
      (layers.has(r) ? layers.get(r) : layers.set(r, []).get(r)).push(id);
    }

    const maxRank = Math.max(...rank.values(), 0);
    const colX = [];
    let x = 0;
    for (let r = 0; r <= maxRank; r++) {
      colX[r] = x;
      const isMach = (layers.get(r) || []).some(id => nodes.get(id).kind === "machine");
      x += (isMach ? NODE.MW : NODE.IW) + NODE.colGap;
    }

    const pos = new Map();
    for (const [r, ids] of layers)
      ids.forEach((id, i) => pos.set(id, { x: colX[r], y: i * (NODE.IH + NODE.rowGap) + 10 }));

    for (let pass = 0; pass < 4; pass++) {
      for (const [r, ids] of layers) {
        const scored = ids.map(id => {
          const nbr = edges.filter(e => e.from === id || e.to === id).map(e => e.from === id ? e.to : e.from);
          const ys  = nbr.map(nid => (pos.get(nid) || { y: 0 }).y);
          return { id, avg: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : (pos.get(id) || { y: 0 }).y };
        }).sort((a, b) => a.avg - b.avg);
        let curY = 10;
        for (const { id } of scored) {
          const h = nodes.get(id).kind === "machine" ? NODE.MH : NODE.IH;
          pos.set(id, { x: colX[r], y: curY });
          curY += h + NODE.rowGap;
        }
      }
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [id, n] of nodes) {
      const p = pos.get(id); if (!p) continue;
      const w = n.kind === "machine" ? NODE.MW : NODE.IW;
      const h = n.kind === "machine" ? NODE.MH : NODE.IH;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
    }
    return { pos, bounds: { minX: minX || 0, minY: minY || 0, w: (maxX - minX) || 100, h: (maxY - minY) || 100 } };
  }

  // ── Flowchart renderer ─────────────────────────────────────────────────────
  function renderFlowchart(result, fit) {
    if (!result || !result.steps.size) {
      elFlow.innerHTML = `<text x="20" y="40" fill="#9aa3b2" font-size="14" font-family="Segoe UI,sans-serif">Füge Produktionsziele hinzu.</text>`;
      return;
    }

    fcGraph = buildGraph(result);
    const { pos, bounds } = layout(fcGraph.nodes, fcGraph.edges);

    // Store auto-layout positions; custom positions override on read
    fcLayoutPos = {};
    for (const [id, p] of pos) fcLayoutPos[id] = { ...p };

    if (fit) fcFit(bounds);

    const cW = elFlowWrap.clientWidth  || 900;
    const cH = elFlowWrap.clientHeight || 620;
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

    // ── Edges (rendered below nodes) ──
    let edgeSvg = "";
    for (const e of fcGraph.edges) {
      const fp = nodePos(e.from), tp = nodePos(e.to);
      if (!fp || !tp) continue;
      const fn = fcGraph.nodes.get(e.from), tn = fcGraph.nodes.get(e.to);
      const sw = fn.kind === "machine" ? NODE.MW : NODE.IW;
      const sh = fn.kind === "machine" ? NODE.MH : NODE.IH;
      const th = tn.kind === "machine" ? NODE.MH : NODE.IH;
      const sx = fp.x + sw, sy = fp.y + sh / 2;
      const tx = tp.x,     ty = tp.y + th / 2;
      const dx = (tx - sx) * 0.45;
      const stroke = e.liq ? "#56cfe1" : "#4a5568";
      const marker = e.liq ? "url(#arr-liq)" : "url(#arr)";
      const eid    = sid(e.from) + "__" + sid(e.to);
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      edgeSvg += `
        <path id="ep_${eid}" d="M${sx},${sy} C${sx+dx},${sy} ${tx-dx},${ty} ${tx},${ty}"
          fill="none" stroke="${stroke}" stroke-width="2" marker-end="${marker}" opacity="0.8"/>
        <text id="el_${eid}" x="${mx}" y="${my - 5}" text-anchor="middle"
          font-size="9.5" fill="${stroke}" font-family="Segoe UI,sans-serif" opacity="0.9" pointer-events="none">
          ${fmt(e.rate)}${e.liq ? " m³" : ""}/min
        </text>`;
    }

    // ── Nodes (rendered above edges, draggable) ──
    let nodeSvg = "";
    for (const [id, n] of fcGraph.nodes) {
      const p = nodePos(id); if (!p) continue;

      if (n.kind === "machine") {
        const { x, y } = { x: 0, y: 0 }; // use translate instead
        const W = NODE.MW, H = NODE.MH;
        nodeSvg += `
          <g data-nodeid="${esc(id)}" transform="translate(${p.x},${p.y})"
            style="cursor:move" class="fc-node">
            <rect x="0" y="0" width="${W}" height="${H}" rx="8"
              fill="#2b303b" stroke="#fa9549" stroke-width="1.8"/>
            <rect x="1" y="1" width="${W-2}" height="24" rx="7" fill="#fa954930"/>
            <rect x="1" y="18" width="${W-2}" height="8"  fill="#fa954318"/>
            <text x="${W/2}" y="17" text-anchor="middle" dominant-baseline="middle"
              font-size="12" font-weight="700" fill="#fa9549" font-family="Segoe UI,sans-serif"
              pointer-events="none">${esc(n.bld)}</text>
            <text x="${W/2}" y="38" text-anchor="middle" dominant-baseline="middle"
              font-size="10" fill="#c5c9d4" font-family="Segoe UI,sans-serif"
              pointer-events="none">${esc(trunc(n.rec, 28))}</text>
            <text x="${W/2}" y="56" text-anchor="middle" dominant-baseline="middle"
              font-size="11" fill="#6fcf7c" font-family="Segoe UI,sans-serif"
              pointer-events="none">${fmt(n.machines, 2)}× (${Math.ceil(n.machines - 1e-9)} Stk.)</text>
            <text x="${W/2}" y="72" text-anchor="middle" dominant-baseline="middle"
              font-size="9.5" fill="#9aa3b2" font-family="Segoe UI,sans-serif"
              pointer-events="none">Taktung ${n.clock} % · ${fmt(n.power, 1)} MW</text>
          </g>`;
      } else {
        const W = NODE.IW, H = NODE.IH, r = H / 2;
        const col         = hexCol(n.item);
        const ab          = abbr(n.label);
        const displayRate = n.raw ? n.outRate : n.inRate;
        const rateStr     = (displayRate > 0 ? fmt(displayRate) : "–") + (n.liq ? " m³" : "") + "/min";
        nodeSvg += `
          <g data-nodeid="${esc(id)}" transform="translate(${p.x},${p.y})"
            style="cursor:move" class="fc-node">
            <rect x="0" y="0" width="${W}" height="${H}" rx="${r}"
              fill="${col}18" stroke="${col}" stroke-width="1.8"/>
            <circle cx="${r}" cy="${r}" r="${r-5}"
              fill="${col}30" stroke="${col}" stroke-width="1.2"/>
            <text x="${r}" y="${r}" text-anchor="middle" dominant-baseline="middle"
              font-size="11" font-weight="800" fill="${col}" font-family="Segoe UI,sans-serif"
              pointer-events="none">${esc(ab)}</text>
            <text x="${H+4}" y="16" dominant-baseline="middle"
              font-size="10.5" font-weight="600" fill="${col}" font-family="Segoe UI,sans-serif"
              pointer-events="none">${esc(trunc(n.label, 17))}</text>
            <text x="${H+4}" y="34" dominant-baseline="middle"
              font-size="9.5" fill="${col}bb" font-family="Segoe UI,sans-serif"
              pointer-events="none">${esc(rateStr)}</text>
            ${n.raw ? `<text x="${W-6}" y="${H/2}" text-anchor="end" dominant-baseline="middle"
              font-size="8" fill="${col}88" font-family="Segoe UI,sans-serif"
              pointer-events="none">Rohstoff</text>` : ""}
          </g>`;
      }
    }

    elFlow.innerHTML = defs +
      `<g id="fc-vp" transform="translate(${fc.tx},${fc.ty}) scale(${fc.scale})">
        <g id="fc-edges">${edgeSvg}</g>
        <g id="fc-nodes">${nodeSvg}</g>
      </g>`;
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
  // First render with auto-fit
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
