/* Anton Satisfactory Planner – app.js */
(function () {
  "use strict";

  const DATA = window.GAME_DATA;
  const ITEMS = DATA.items;
  const RECIPES = DATA.recipes;
  const BUILDINGS = DATA.buildings;

  // ── index ──────────────────────────────────────────────────────────────────
  const recipesByProduct = {};   // item className → recipe[]
  const recipeById = {};
  for (const r of RECIPES) {
    recipeById[r.id] = r;
    for (const [item] of r.out) {
      (recipesByProduct[item] = recipesByProduct[item] || []).push(r);
    }
  }

  const producibleItems = Object.keys(recipesByProduct)
    .filter((c) => ITEMS[c])
    .sort((a, b) => ITEMS[a].name.localeCompare(ITEMS[b].name));

  // ── state ──────────────────────────────────────────────────────────────────
  const state = loadState() || {
    targets: [{ item: "Desc_IronPlateReinforced_C", rate: 10 }],
    recipeChoice: {},   // item className → recipe id
    stepClocks: {},     // recipe id → clock %
    globalClock: 100,
  };
  // migrate old saves
  if (!state.stepClocks) state.stepClocks = {};
  if (!state.globalClock) state.globalClock = state.clock || 100;

  function saveState() {
    try { localStorage.setItem("anton-planner-v2", JSON.stringify(state)); } catch (_) {}
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem("anton-planner-v2"));
      if (s && Array.isArray(s.targets)) return s;
    } catch (_) {}
    return null;
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function fmt(n, d) {
    if (n === undefined || n === null || isNaN(n)) return "–";
    return n.toLocaleString("de-DE", {
      maximumFractionDigits: d ?? 2,
      minimumFractionDigits: 0,
    });
  }
  function itemName(c) { return ITEMS[c] ? ITEMS[c].name : c; }
  function isLiquid(c) { return !!(ITEMS[c] && ITEMS[c].liquid); }
  function unit(c) { return isLiquid(c) ? " m³/min" : " /min"; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])
    );
  }
  function wikiIcon(item) {
    const it = ITEMS[item];
    if (!it) return "";
    return "https://satisfactory.wiki.gg/wiki/Special:FilePath/" +
      encodeURIComponent(it.name.replace(/ /g, "_")) + ".png";
  }
  // color for item: liquid = teal, raw = yellow, else green
  function itemColor(item) {
    if (isLiquid(item)) return "var(--liq-col)";
    if (ITEMS[item] && ITEMS[item].raw) return "var(--raw-col)";
    return "var(--prod-col)";
  }
  // short letter(s) for pill fallback
  function initials(name) {
    return name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
  }

  // ── recipe selection ───────────────────────────────────────────────────────
  function defaultRecipeFor(item) {
    const list = recipesByProduct[item];
    if (!list || !list.length) return null;
    const std = list.filter((r) => !r.alt);
    const primary = std.find((r) => r.out[0][0] === item);
    return primary || std[0] || list[0];
  }
  function chosenRecipeFor(item) {
    const id = state.recipeChoice[item];
    if (id === "RAW") return null;
    if (id && recipeById[id] && recipeById[id].out.some(([i]) => i === item))
      return recipeById[id];
    return defaultRecipeFor(item);
  }
  function isRaw(item) {
    if (state.recipeChoice[item] === "RAW") return true;
    const it = ITEMS[item];
    if (it && it.raw) return true;
    return !recipesByProduct[item];
  }
  function clockFor(recipeId) {
    return (state.stepClocks[recipeId] !== undefined
      ? state.stepClocks[recipeId]
      : state.globalClock) / 100;
  }

  // ── solver ─────────────────────────────────────────────────────────────────
  function solve(targets) {
    const demand = new Map();
    const steps  = new Map();
    const raws   = new Map();
    const surplus = new Map();
    const queue  = [];

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
      if (!rec) { raws.set(item, (raws.get(item) || 0) + rate); continue; }

      const cf = clockFor(rec.id);
      const prod = rec.out.find(([i]) => i === item);
      const perMachine = (prod[1] * 60 / rec.time) * cf;
      const machines   = rate / perMachine;

      const st = steps.get(rec.id) || { recipe: rec, machines: 0 };
      st.machines += machines;
      steps.set(rec.id, st);

      for (const [oItem, oAmt] of rec.out) {
        if (oItem === item) continue;
        const oRate = (oAmt * 60 / rec.time) * cf * machines;
        surplus.set(oItem, (surplus.get(oItem) || 0) + oRate);
      }
      for (const [iItem, iAmt] of rec.in) {
        const iRate = (iAmt * 60 / rec.time) * cf * machines;
        addDemand(iItem, iRate);
      }
    }

    let power = 0;
    for (const st of steps.values()) {
      const r  = st.recipe;
      const b  = BUILDINGS[r.bld];
      const cf = clockFor(r.id);
      const base = r.pow != null ? r.pow : (b ? b.power : 0);
      const exp  = b ? b.exp : 1.321929;
      power += st.machines * base * Math.pow(cf, exp);
    }

    return { steps, raws, byproducts: surplus, power, unstable: guard >= 20000 };
  }

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const elTargets  = document.getElementById("targets");
  const elAdd      = document.getElementById("add-target");
  const elGlobalCk = document.getElementById("clock-global");
  const elApplyAll = document.getElementById("apply-all");
  const elApply025 = document.getElementById("apply-025");
  const elSummary  = document.getElementById("summary");
  const elSteps    = document.getElementById("steps");
  const elRaws     = document.getElementById("raws");
  const elBy       = document.getElementById("byproducts");
  const elFlowWrap = document.getElementById("flowchart-wrap");
  const elFlow     = document.getElementById("flowchart");
  const elFlowRst  = document.getElementById("flow-reset");

  // ── UI: Targets ────────────────────────────────────────────────────────────
  function itemOptions(selected) {
    return producibleItems.map(c =>
      `<option value="${c}"${c === selected ? " selected" : ""}>${esc(ITEMS[c].name)}</option>`
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
        `<span class="muted">/min</span>` +
        `<button class="btn-remove">✕</button>`;
      row.querySelector("select").addEventListener("change", e => { t.item = e.target.value; update(); });
      row.querySelector("input").addEventListener("input", e => { t.rate = parseFloat(e.target.value) || 0; update(); });
      row.querySelector(".btn-remove").addEventListener("click", () => { state.targets.splice(idx, 1); renderTargets(); update(); });
      elTargets.appendChild(row);
    });
  }
  elAdd.addEventListener("click", () => {
    state.targets.push({ item: producibleItems[0], rate: 10 });
    renderTargets(); update();
  });

  // ── UI: Settings ───────────────────────────────────────────────────────────
  elGlobalCk.value = state.globalClock;
  elGlobalCk.addEventListener("input", () => {
    const v = parseFloat(elGlobalCk.value);
    if (v >= 1 && v <= 250) { state.globalClock = v; update(); }
  });
  elApplyAll.addEventListener("click", () => {
    const v = parseFloat(elGlobalCk.value);
    if (v >= 1 && v <= 250) {
      state.stepClocks = {};   // clear all overrides → all fall back to globalClock
      state.globalClock = v;
      update();
    }
  });
  elApply025.addEventListener("click", () => {
    state.stepClocks = {};
    state.globalClock = 25;
    elGlobalCk.value = 25;
    update();
  });

  // ── UI: Ingredient pills ───────────────────────────────────────────────────
  function ingrPills(rec, machines) {
    if (!rec.in.length) return "";
    const cf = clockFor(rec.id);
    const pills = rec.in.map(([item, amt]) => {
      const rate = (amt * 60 / rec.time) * cf * machines;
      const liq  = isLiquid(item);
      const col  = itemColor(item);
      const icon = wikiIcon(item);
      return `<span class="ingr-pill">
        <img src="${esc(icon)}" alt="" loading="lazy"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <span class="pill-fallback" style="display:none;background:${col}22;color:${col};border:1px solid ${col}">${esc(initials(itemName(item)))}</span>
        <span>${esc(itemName(item))}</span>
        <span class="pill-rate${liq ? " liq" : ""}">${fmt(rate)}${unit(item)}</span>
      </span>`;
    }).join("");
    return `<div class="ingr-list">${pills}</div>`;
  }

  // ── UI: Steps table ────────────────────────────────────────────────────────
  function recipeOptions(item, chosen) {
    const list = [...(recipesByProduct[item] || [])].sort((a, b) => (a.alt - b.alt) || a.name.localeCompare(b.name));
    return list.map(r => {
      const label = (r.alt ? "ALT: " : "") + r.name.replace(/^Alternate:\s*/, "");
      return `<option value="${r.id}"${r.id === chosen.id ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
  }

  function renderSteps(result) {
    if (!result.steps.size) {
      elSteps.innerHTML = '<p class="muted">Keine Produktionsschritte.</p>';
      return;
    }
    let html = `<table>
      <tr>
        <th>Produkt</th>
        <th>Rezept &amp; Zutaten</th>
        <th>Maschine</th>
        <th class="num">Anzahl</th>
        <th class="num">Ausstoß</th>
        <th>Taktung</th>
        <th class="num">Leistung</th>
      </tr>`;

    for (const [rid, st] of result.steps) {
      const r   = st.recipe;
      const b   = BUILDINGS[r.bld];
      const cf  = clockFor(r.id);
      const ck  = (state.stepClocks[r.id] !== undefined ? state.stepClocks[r.id] : state.globalClock);
      const base = r.pow != null ? r.pow : (b ? b.power : 0);
      const exp  = b ? b.exp : 1.321929;
      const pw   = st.machines * base * Math.pow(cf, exp);
      const mainItem = r.out[0][0];
      const outRate  = (r.out[0][1] * 60 / r.time) * cf * st.machines;
      const recLabel = r.name.replace(/^Alternate:\s*/, "");

      html +=
        `<tr>
          <td><strong>${esc(itemName(mainItem))}</strong></td>
          <td>
            <select class="recipe-select" data-item="${mainItem}">
              ${recipeOptions(mainItem, r)}
            </select>
            ${ingrPills(r, st.machines)}
          </td>
          <td>${esc(b ? b.name : "?")}</td>
          <td class="num">
            ${fmt(st.machines, 3)}<br>
            <span class="muted">(${Math.ceil(st.machines - 1e-9)}×)</span>
          </td>
          <td class="num">${fmt(outRate)}${unit(mainItem)}</td>
          <td class="clock-cell">
            <input type="number" class="step-clock" data-rid="${esc(r.id)}"
              min="1" max="250" step="1" value="${esc(String(ck))}" style="width:62px"> %
          </td>
          <td class="num">${fmt(pw, 1)} MW</td>
        </tr>`;
    }
    html += "</table>";
    elSteps.innerHTML = html;

    elSteps.querySelectorAll(".recipe-select").forEach(sel => {
      sel.addEventListener("change", () => {
        state.recipeChoice[sel.dataset.item] = sel.value;
        update();
      });
    });
    elSteps.querySelectorAll(".step-clock").forEach(inp => {
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        if (v >= 1 && v <= 250) {
          state.stepClocks[inp.dataset.rid] = v;
          update();
        }
      });
    });
  }

  // ── UI: Small tables ───────────────────────────────────────────────────────
  function renderMap(el, map, emptyText) {
    const entries = [...map.entries()].filter(([, v]) => v > 1e-6);
    if (!entries.length) { el.innerHTML = `<p class="muted">${emptyText}</p>`; return; }
    entries.sort((a, b) => b[1] - a[1]);
    let html = `<table class="small-table"><tr><th>Item</th><th class="num">Menge</th></tr>`;
    for (const [item, rate] of entries) {
      const icon = wikiIcon(item);
      const col  = itemColor(item);
      html +=
        `<tr><td>
          <span style="display:inline-flex;align-items:center;gap:5px">
            <img src="${esc(icon)}" alt="" loading="lazy" width="18" height="18"
              style="object-fit:contain;vertical-align:middle"
              onerror="this.style.display='none'">
            ${esc(itemName(item))}
          </span>
        </td><td class="num" style="color:${col}">${fmt(rate)}${unit(item)}</td></tr>`;
    }
    html += "</table>";
    el.innerHTML = html;
  }

  // ── UI: Summary ────────────────────────────────────────────────────────────
  function renderSummary(result) {
    const machines = [...result.steps.values()].reduce((a, s) => a + Math.ceil(s.machines - 1e-9), 0);
    elSummary.innerHTML =
      `<div class="summary-cards">
        <div class="card"><div class="label">Maschinen gesamt</div><div class="value">${machines}</div></div>
        <div class="card"><div class="label">Leistung gesamt</div><div class="value">${fmt(result.power, 1)} MW</div></div>
        <div class="card"><div class="label">Produktionsschritte</div><div class="value">${result.steps.size}</div></div>
      </div>` +
      (result.unstable ? '<p class="warn">⚠ Rezeptzyklus erkannt – Ergebnis ggf. unvollständig.</p>' : "");
  }

  // ── Flowchart ──────────────────────────────────────────────────────────────
  // Node sizes
  const ITEM_W = 168, ITEM_H = 50;
  const MACH_W = 200, MACH_H = 80;
  const COL_GAP = 60;   // gap between columns
  const ROW_GAP = 24;   // minimum gap between rows within a column

  // Pan/zoom state
  let fc = { tx: 20, ty: 20, scale: 1, drag: false, ox: 0, oy: 0 };

  function fcApply() {
    const g = document.getElementById("fc-vp");
    if (g) g.setAttribute("transform", `translate(${fc.tx},${fc.ty}) scale(${fc.scale})`);
  }

  function initFcInteraction() {
    elFlowWrap.addEventListener("wheel", e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      fc.scale = Math.max(0.15, Math.min(4, fc.scale * factor));
      fcApply();
    }, { passive: false });
    elFlowWrap.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      fc.drag = true;
      fc.ox = e.clientX - fc.tx;
      fc.oy = e.clientY - fc.ty;
    });
    window.addEventListener("mousemove", e => {
      if (!fc.drag) return;
      fc.tx = e.clientX - fc.ox;
      fc.ty = e.clientY - fc.oy;
      fcApply();
    });
    window.addEventListener("mouseup", () => { fc.drag = false; });

    // Touch support
    let pinchDist = 0;
    elFlowWrap.addEventListener("touchstart", e => {
      if (e.touches.length === 1) {
        fc.drag = true;
        fc.ox = e.touches[0].clientX - fc.tx;
        fc.oy = e.touches[0].clientY - fc.ty;
      } else if (e.touches.length === 2) {
        fc.drag = false;
        pinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      }
    }, { passive: true });
    elFlowWrap.addEventListener("touchmove", e => {
      if (e.touches.length === 1 && fc.drag) {
        fc.tx = e.touches[0].clientX - fc.ox;
        fc.ty = e.touches[0].clientY - fc.oy;
        fcApply();
      } else if (e.touches.length === 2) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        fc.scale = Math.max(0.15, Math.min(4, fc.scale * (d / pinchDist)));
        pinchDist = d;
        fcApply();
      }
    }, { passive: true });
    elFlowWrap.addEventListener("touchend", () => { fc.drag = false; });
  }

  elFlowRst.addEventListener("click", () => {
    fc = { tx: 20, ty: 20, scale: 1, drag: false, ox: 0, oy: 0 };
    renderFlowchart(lastResult);
  });

  // Build the graph from solver result
  function buildFlowGraph(result) {
    const nodes = new Map();
    const edges = [];

    function ensureItem(item) {
      const id = "I:" + item;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id, kind: "item", item,
          label: itemName(item),
          raw: result.raws.has(item),
          liq: isLiquid(item),
          rates: [],     // rates we'll accumulate
        });
      }
      return id;
    }

    for (const [rid, st] of result.steps) {
      const r   = st.recipe;
      const cf  = clockFor(r.id);
      const b   = BUILDINGS[r.bld];
      const mid = "M:" + rid;

      nodes.set(mid, {
        id: mid, kind: "machine",
        label: b ? b.name : "?",
        sublabel: r.name.replace(/^Alternate:\s*/, ""),
        machines: st.machines,
        clock: (state.stepClocks[r.id] !== undefined ? state.stepClocks[r.id] : state.globalClock),
      });

      for (const [item, amt] of r.in) {
        const rate = (amt * 60 / r.time) * cf * st.machines;
        const iid  = ensureItem(item);
        nodes.get(iid).rates.push(rate);
        edges.push({ from: iid, to: mid, rate, liq: isLiquid(item) });
      }
      for (const [item, amt] of r.out) {
        const rate = (amt * 60 / r.time) * cf * st.machines;
        const iid  = ensureItem(item);
        edges.push({ from: mid, to: iid, rate, liq: isLiquid(item) });
      }
    }
    for (const [item] of result.raws) ensureItem(item);

    return { nodes, edges };
  }

  function layoutFlowGraph(nodes, edges) {
    const rank = new Map();

    // Raw items = rank 0
    for (const [id, n] of nodes) {
      if (n.kind === "item" && n.raw) rank.set(id, 0);
    }

    // Propagate ranks through edges (machine rank = max input rank + 1; output item = machine rank + 1)
    let changed = true;
    for (let iter = 0; changed && iter < 500; iter++) {
      changed = false;
      for (const e of edges) {
        const sr = rank.get(e.from);
        if (sr === undefined) continue;
        const need = sr + 1;
        const tr   = rank.get(e.to);
        if (tr === undefined || tr < need) { rank.set(e.to, need); changed = true; }
      }
    }
    // fallback for any unranked node
    for (const [id] of nodes) if (!rank.has(id)) rank.set(id, 0);

    // Group by rank
    const layers = new Map();
    for (const [id] of nodes) {
      const r = rank.get(id);
      if (!layers.has(r)) layers.set(r, []);
      layers.get(r).push(id);
    }

    // Assign column x using different widths for item vs machine columns
    const maxRank = Math.max(...rank.values(), 0);
    const colX = [];
    let x = 0;
    for (let r = 0; r <= maxRank; r++) {
      colX[r] = x;
      const w = [...(layers.get(r) || [])].some(id => nodes.get(id).kind === "machine")
        ? MACH_W : ITEM_W;
      x += w + COL_GAP;
    }

    // Initial y positions
    const pos = new Map();
    for (const [r, ids] of layers) {
      ids.forEach((id, i) => pos.set(id, { x: colX[r], y: i * (ITEM_H + ROW_GAP) + 10 }));
    }

    // 3 passes of barycenter ordering + spacing enforcement
    for (let pass = 0; pass < 4; pass++) {
      for (const [r, ids] of layers) {
        const scored = ids.map(id => {
          const nbr = edges
            .filter(e => e.from === id || e.to === id)
            .map(e => e.from === id ? e.to : e.from);
          const ys = nbr.map(nid => (pos.get(nid) || {y: 0}).y);
          const avgY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : (pos.get(id) || {y: 0}).y;
          return { id, avgY };
        });
        scored.sort((a, b) => a.avgY - b.avgY);

        // Assign y with minimum spacing
        let curY = 10;
        for (const { id } of scored) {
          const n = nodes.get(id);
          const h = n.kind === "machine" ? MACH_H : ITEM_H;
          const oldPos = pos.get(id) || { x: colX[r], y: curY };
          pos.set(id, { x: colX[r], y: curY });
          curY += h + ROW_GAP;
        }
      }
    }

    return { pos, colX, maxRank };
  }

  let lastResult = null;

  function renderFlowchart(result) {
    if (!result || !result.steps.size) {
      elFlow.innerHTML = "<text x='20' y='40' fill='#9aa3b2' font-size='14'>Füge Produktionsziele hinzu, um den Fluss zu sehen.</text>";
      return;
    }
    const { nodes, edges } = buildFlowGraph(result);
    const { pos, maxRank } = layoutFlowGraph(nodes, edges);

    // Compute canvas size
    let maxX = 0, maxY = 0;
    for (const [id, n] of nodes) {
      const p = pos.get(id);
      if (!p) continue;
      const w = n.kind === "machine" ? MACH_W : ITEM_W;
      const h = n.kind === "machine" ? MACH_H : ITEM_H;
      maxX = Math.max(maxX, p.x + w);
      maxY = Math.max(maxY, p.y + h);
    }
    maxX += 30; maxY += 30;

    const defs = `<defs>
      <marker id="arr" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
        <path d="M0,0 L0,6 L9,3 z" fill="#6a7488"/>
      </marker>
      <marker id="arr-liq" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
        <path d="M0,0 L0,6 L9,3 z" fill="#56cfe1"/>
      </marker>
      <filter id="glow"><feGaussianBlur stdDeviation="2" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>`;

    // Edges
    let edgeSvg = "";
    for (const e of edges) {
      const sp = pos.get(e.from);
      const tp = pos.get(e.to);
      if (!sp || !tp) continue;
      const sn = nodes.get(e.from);
      const tn = nodes.get(e.to);
      const sx = sp.x + (sn.kind === "machine" ? MACH_W : ITEM_W);
      const sy = sp.y + (sn.kind === "machine" ? MACH_H : ITEM_H) / 2;
      const tx = tp.x;
      const ty = tp.y + (tn.kind === "machine" ? MACH_H : ITEM_H) / 2;
      const cx1 = sx + (tx - sx) * 0.45;
      const cx2 = tx - (tx - sx) * 0.45;
      const col  = e.liq ? "#56cfe1" : "#4a5568";
      const mark = e.liq ? "url(#arr-liq)" : "url(#arr)";
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      edgeSvg +=
        `<path d="M${sx},${sy} C${cx1},${sy} ${cx2},${ty} ${tx},${ty}"
          fill="none" stroke="${col}" stroke-width="1.8" marker-end="${mark}" opacity="0.75"/>
        <text x="${mx}" y="${my - 5}" text-anchor="middle" font-size="10" fill="${col}" opacity="0.9">
          ${fmt(e.rate)}${e.liq ? " m³" : ""}/min
        </text>`;
    }

    // Nodes
    let nodeSvg = "";
    for (const [id, n] of nodes) {
      const p = pos.get(id);
      if (!p) continue;

      if (n.kind === "machine") {
        const b = BUILDINGS[n.machines !== undefined ? Object.keys(BUILDINGS)[0] : ""] || {};
        nodeSvg +=
          `<g>
            <rect x="${p.x}" y="${p.y}" width="${MACH_W}" height="${MACH_H}" rx="8"
              fill="#2b303b" stroke="#fa9549" stroke-width="1.5"/>
            <rect x="${p.x}" y="${p.y}" width="${MACH_W}" height="24" rx="8"
              fill="#fa954922"/>
            <rect x="${p.x}" y="${p.y+16}" width="${MACH_W}" height="8"
              fill="#fa954922"/>
            <text x="${p.x + MACH_W/2}" y="${p.y + 16}" text-anchor="middle"
              font-size="12" font-weight="700" fill="#fa9549">${esc(n.label)}</text>
            <text x="${p.x + MACH_W/2}" y="${p.y + 34}" text-anchor="middle"
              font-size="10" fill="#c5c9d4">${esc(n.sublabel.length > 26 ? n.sublabel.slice(0, 24) + "…" : n.sublabel)}</text>
            <text x="${p.x + MACH_W/2}" y="${p.y + 52}" text-anchor="middle"
              font-size="11" fill="#6fcf7c">${fmt(n.machines, 2)}× (${Math.ceil(n.machines - 1e-9)} Stk)</text>
            <text x="${p.x + MACH_W/2}" y="${p.y + 68}" text-anchor="middle"
              font-size="10" fill="#9aa3b2">Taktung: ${n.clock} %</text>
          </g>`;
      } else {
        const col   = n.liq ? "var(--liq-col)" : (n.raw ? "var(--raw-col)" : "var(--prod-col)");
        const hexCol = n.liq ? "#56cfe1" : (n.raw ? "#f2c94c" : "#6fcf7c");
        const icon  = wikiIcon(n.item);
        const totalRate = n.rates.reduce((a, b) => a + b, 0);
        nodeSvg +=
          `<g>
            <rect x="${p.x}" y="${p.y}" width="${ITEM_W}" height="${ITEM_H}" rx="${ITEM_H/2}"
              fill="${hexCol}18" stroke="${hexCol}" stroke-width="1.5"/>
            <image href="${esc(icon)}" x="${p.x + 6}" y="${p.y + 6}"
              width="${ITEM_H - 12}" height="${ITEM_H - 12}"
              preserveAspectRatio="xMidYMid meet" style="image-rendering:auto"
              onerror="this.style.display='none'"/>
            <text x="${p.x + ITEM_H + 2}" y="${p.y + 19}" font-size="11" font-weight="600"
              fill="${hexCol}">${esc(n.label.length > 18 ? n.label.slice(0,16) + "…" : n.label)}</text>
            <text x="${p.x + ITEM_H + 2}" y="${p.y + 35}" font-size="10" fill="${hexCol}cc">
              ${n.raw ? "Rohstoff" : fmt(totalRate) + (n.liq ? " m³" : "") + "/min"}
            </text>
          </g>`;
      }
    }

    const svgContent = `<g id="fc-vp" transform="translate(${fc.tx},${fc.ty}) scale(${fc.scale})">
      ${edgeSvg}${nodeSvg}
    </g>`;

    elFlow.setAttribute("viewBox", `0 0 ${elFlowWrap.clientWidth} ${elFlowWrap.clientHeight}`);
    elFlow.setAttribute("width", elFlowWrap.clientWidth);
    elFlow.setAttribute("height", elFlowWrap.clientHeight);
    elFlow.innerHTML = defs + svgContent;
  }

  // ── Main update ────────────────────────────────────────────────────────────
  function update() {
    const result = solve(state.targets);
    lastResult   = result;
    renderSummary(result);
    renderSteps(result);
    renderMap(elRaws, result.raws, "Keine Rohstoffe benötigt.");
    renderMap(elBy, result.byproducts, "Keine Nebenprodukte.");
    renderFlowchart(result);
    saveState();
  }

  initFcInteraction();
  renderTargets();
  update();
})();
