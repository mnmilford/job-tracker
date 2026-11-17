// Flow: a Sankey chart of how applications moved through the stages to their
// outcomes, with filters, a table view, and PNG/SVG download.
//
//   init()     listen for data and theme changes
//   open()     show the dialog (focus returns to the opener on close)
//   close()
//   isOpen()
//
// The stage logic is the server's: every application carries
// path = { reached: [stages with recorded evidence, in order], exitKnown }.
// This file only turns those paths into nodes and links, lays them out and
// draws plain SVG. Colors and fonts are read from the live theme at render
// time and written as resolved attributes, so the on-screen chart and the
// downloaded file come from the same markup.
import { state, on, setView, openDrawer } from "../core/state.js";
import { store } from "../core/store.js";
import { esc, today, parse, iso, fmt, plural } from "../core/format.js";

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
const DEF = { when: "all", from: "", to: "", srcOff: [], bySource: false, split: true, drafting: false, history: false };
const WHEN = [["all", "Any time"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["year", "This year"], ["custom", "Custom"]];
let F = load();
function load() {
  const s = store.get("sankey", {}) || {};
  const f = { ...DEF, view: null };
  for (const k in f) if (k in s && (typeof s[k] === typeof f[k] || (k === "view" && (s[k] === "chart" || s[k] === "table")))) f[k] = s[k];
  if (!Array.isArray(f.srcOff)) f.srcOff = [];
  if (!WHEN.some(([v]) => v === f.when)) f.when = "all";
  return f;
}
const save = () => store.set("sankey", F);
const isDefault = () => Object.keys(DEF).every((k) => JSON.stringify(F[k]) === JSON.stringify(DEF[k]));

const NO_SOURCE = "No source", OTHER = "Other sources";
const srcOf = (a) => String(a.source || "").trim() || NO_SOURCE;
const mqPhone = window.matchMedia("(max-width: 720px)");
const viewMode = () => F.view || (mqPhone.matches ? "table" : "chart");

/** Found-date window as [from, to] Dates (either may be null), or null for any time. */
function windowOf(f = F) {
  const t = today();
  if (f.when === "30") return [new Date(t.getFullYear(), t.getMonth(), t.getDate() - 30), null];
  if (f.when === "90") return [new Date(t.getFullYear(), t.getMonth(), t.getDate() - 90), null];
  if (f.when === "year") return [new Date(t.getFullYear(), 0, 1), null];
  if (f.when === "custom") {
    const a = parse(f.from), b = parse(f.to);
    if (!a && !b) return null;
    return [a, b];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model: paths -> nodes and links
// ---------------------------------------------------------------------------
const TERM_ORDER = ["Hired", "prog", "Rejected", "Withdrawn", "Ghosted", "closed", "none"];
const TERM_NAME = { prog: "Still in progress", closed: "Closed", none: "No outcome recorded" };

/** Applications that pass every filter but the source one (the source list counts these). */
function basePool(M, f) {
  const win = windowOf(f);
  const out = [];
  for (const a of M.all) {
    if (a.kind === "history" && !f.history) continue;
    let reached = (a.path?.reached || []).filter((s) => M.stages.includes(s));
    if (!f.drafting) {
      if (a.kind === "active" && a.stage === "Drafting") continue;
      if (reached.length === 1 && reached[0] === "Drafting") continue;
      reached = reached.filter((s) => s !== "Drafting");
    }
    if (win) {
      const d = parse(a.found);
      if (!d) continue;
      if (win[0] && d < win[0]) continue;
      if (win[1] && d > win[1]) continue;
    }
    out.push({ app: a, reached });
  }
  return out;
}

function buildModel(M, f) {
  const pool = basePool(M, f);
  const off = new Set(f.srcOff);
  const rows = pool.filter((r) => !off.has(srcOf(r.app)));

  // Sources: the 5 largest keep their own node when there are more than 6.
  const srcCount = new Map();
  for (const r of rows) srcCount.set(srcOf(r.app), (srcCount.get(srcOf(r.app)) || 0) + 1);
  const ranked = [...srcCount].sort((x, y) => y[1] - x[1] || (x[0] === NO_SOURCE) - (y[0] === NO_SOURCE) || x[0].localeCompare(y[0]));
  const keep = new Set((ranked.length > 6 ? ranked.slice(0, 5) : ranked).map((x) => x[0]));
  const srcNode = (a) => (keep.has(srcOf(a)) ? srcOf(a) : OTHER);

  const stageCols = M.stages.filter((s) => f.drafting || s !== "Drafting");
  const termCol = stageCols.length + 1;
  const nodes = new Map(), links = new Map();
  const node = (id, props) => { if (!nodes.has(id)) nodes.set(id, { id, apps: [], inV: 0, outV: 0, ...props }); return nodes.get(id); };
  const counts = { closed: 0, active: 0, history: 0, nrClosed: 0, nrHistory: 0, dashed: 0 };

  for (const { app: a, reached } of rows) {
    const seq = [];
    if (f.bySource) {
      const s = srcNode(a);
      const order = s === OTHER ? 98 : ranked.findIndex((x) => x[0] === s);
      seq.push(node(`src:${s}`, { name: s, kind: "root", col: 0, order, key: -10 + order * 0.01, tkey: -10 }));
    } else seq.push(node("root", { name: "Applications", kind: "root", col: 0, order: 0, key: -10, tkey: -10 }));

    const isNR = !reached.length;
    if (isNR) {
      const col = 1 + Math.max(0, stageCols.indexOf("Applied"));
      seq.push(node("nr", { name: "Stage not recorded", kind: "nr", col, order: 1, key: M.stages.indexOf("Applied") - 0.5, tkey: M.stages.indexOf("Applied") + 0.5 }));
      if (a.kind === "closed") counts.nrClosed++; else if (a.kind === "history") counts.nrHistory++;
    } else {
      for (const s of reached) {
        const i = M.stages.indexOf(s);
        seq.push(node(`stage:${s}`, { name: s, kind: "stage", stage: s, col: 1 + stageCols.indexOf(s), order: 0, key: i, colorVar: `s${i + 1}`, tkey: i }));
      }
    }
    let t;
    if (a.kind === "active") t = "prog";
    else if (a.kind === "history") t = "none";
    else t = f.split ? (M.outcomes.includes(a.stage) ? a.stage : "closed") : "closed";
    const ti = TERM_ORDER.indexOf(t);
    seq.push(node(`out:${t}`, { name: TERM_NAME[t] || t, kind: "term", term: t, col: termCol, order: ti, key: 10 + ti, tkey: 10 + ti }));
    counts[a.kind]++;

    const dashedExit = a.kind === "closed" && !isNR && !a.path?.exitKnown;
    if (dashedExit) counts.dashed++;
    const seen = new Set();
    seq.forEach((n, i) => {
      if (!seen.has(n.id)) { n.apps.push(a); seen.add(n.id); }
      if (i === 0) return;
      const s = seq[i - 1], dashed = dashedExit && i === seq.length - 1;
      const id = `${s.id}>${n.id}${dashed ? "~" : ""}`;
      if (!links.has(id)) links.set(id, { id, s, t: n, dashed, apps: [], v: 0 });
      const l = links.get(id);
      l.apps.push(a); l.v++; s.outV++; n.inV++;
    });
  }
  for (const n of nodes.values()) n.v = Math.max(n.inV, n.outV);
  const N = rows.length;
  return { nodes: [...nodes.values()], links: [...links.values()], N, counts, stageCols, termCol, pool, rows };
}

// ---------------------------------------------------------------------------
// Theme: resolved colors and fonts
// ---------------------------------------------------------------------------
const COLOR_TOKENS = ["page", "surface", "raised", "ink", "ink-2", "muted", "axis", "grid", "accent", "good", "critical-ink", "focus", "s1", "s2", "s3", "s4", "s5"];
let probe = null;
function theme() {
  if (!probe) {
    probe = document.createElement("div");
    probe.className = "sk-probe";
    probe.setAttribute("aria-hidden", "true");
    probe.innerHTML = ["xs", "sm", "md", "xl"].map((s) => `<span data-fs="${s}" style="font-size: var(--fs-${s}); font-family: var(--font-ui)">x</span>`).join("")
      + `<i data-c style="color: var(--ink)"></i>`;
  }
  (dlg || document.body).append(probe);
  const root = getComputedStyle(document.documentElement);
  const swatch = probe.querySelector("[data-c]");
  const C = {};
  for (const t of COLOR_TOKENS) {
    let v = root.getPropertyValue(`--${t}`).trim();
    if (!v || v.includes("var(") || v.includes("calc(")) { swatch.style.color = `var(--${t})`; v = getComputedStyle(swatch).color; }
    C[t] = v;
  }
  const fs = {};
  let family = "";
  for (const el of probe.querySelectorAll("[data-fs]")) {
    const cs = getComputedStyle(el);
    fs[el.dataset.fs] = parseFloat(cs.fontSize) || 12;
    family = cs.fontFamily;
  }
  return { C, fs, family };
}

let measureCtx = null;
function measure(text, size, weight, family) {
  measureCtx ||= document.createElement("canvas").getContext("2d");
  measureCtx.font = `${weight} ${size}px ${family}`;
  return measureCtx.measureText(text).width;
}
function fit(text, max, size, weight, family) {
  if (measure(text, size, weight, family) <= max) return text;
  let t = text;
  while (t.length > 1 && measure(t + "…", size, weight, family) > max) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}

function nodeColor(n, C) {
  if (n.kind === "stage") return C[n.colorVar] || C.accent;
  if (n.kind === "term") {
    if (n.term === "Hired") return C.good;
    if (n.term === "prog") return C.accent;
    if (n.term === "Rejected") return C["critical-ink"];
    return C.muted;
  }
  if (n.kind === "nr") return C.axis;
  return C.muted;
}
/** Ribbons take the source node's color; "not recorded" ones use muted so they stay visible. */
const linkColor = (l, C) => (l.s.kind === "nr" ? C.muted : nodeColor(l.s, C));
const nodeOpacity = (n) => (n.kind === "term" && n.term === "Rejected" ? 0.6 : n.kind === "term" && n.term === "none" ? 0.5 : n.kind === "nr" ? 0.55 : 1);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const NODE_W = 12;
const LANE_GAP = 2;

function layout(model, width, T, { minWidth = 0 } = {}) {
  const { nodes, links, N, termCol } = model;
  const { fs, family } = T;
  const W = Math.max(width, minWidth);
  const labelH = Math.ceil(fs.sm * 1.5);
  const gapNode = labelH + 8;        // room for a label above each node
  const top = labelH + 4;
  const k = Math.max(8, Math.min(26, 420 / Math.max(1, N)));   // px per application

  // Right margin: terminal labels sit to the right of their nodes.
  const termLabelW = Math.max(60, ...nodes.filter((n) => n.kind === "term").map((n) =>
    measure(n.name, fs.sm, 500, family) + measure(` ${n.v}`, fs.sm, 600, family) + 6));
  const right = Math.min(Math.ceil(termLabelW) + 10, 220);
  const inset = 6;                   // room for the focus ring on the first column
  const colW = (W - right - NODE_W - inset) / termCol;
  const xOf = (c) => inset + Math.round(c * colW);

  // Every link longer than one column gets a lane in each column it crosses.
  for (const l of links) { l.w = l.v * k; l.lanes = []; }
  const cols = Array.from({ length: termCol + 1 }, () => ({ nodes: [], lanes: [] }));
  for (const n of nodes) { n.h = n.v * k; cols[n.col].nodes.push(n); }
  // Lanes stack by where they end (stages above terminals, in order), then by
  // where they start (later sources on top), so lanes never swap between columns.
  // "Stage not recorded" ranks just below Applied both as a source and a target.
  const laneKey = (l) => [l.t.tkey, -l.s.key, l.dashed ? 1 : 0];
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
  for (const l of links) for (let c = l.s.col + 1; c < l.t.col; c++) {
    const lane = { link: l, col: c };
    l.lanes.push(lane); cols[c].lanes.push(lane);
  }
  let H = 0;
  cols.forEach((col, c) => {
    col.nodes.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    col.lanes.sort((a, b) => cmp(laneKey(a.link), laneKey(b.link)) || a.link.id.localeCompare(b.link.id));
    let y = top;
    col.nodes.forEach((n, i) => { if (i) y += gapNode; n.x = xOf(c); n.y = y; y += n.h; });
    if (col.lanes.length) {
      y += col.nodes.length ? Math.max(6, labelH * 0.6) : 0;
      col.lanes.forEach((ln, i) => { if (i) y += LANE_GAP; ln.x = xOf(c); ln.y = y; y += ln.link.w; });
    }
    H = Math.max(H, y);
  });

  // Ports: order each node's links by where they go next (or came from).
  const nextY = (l) => (l.lanes.length ? l.lanes[0].y : l.t.y);
  const prevY = (l) => (l.lanes.length ? l.lanes[l.lanes.length - 1].y : l.s.y);
  for (const n of nodes) {
    const outs = links.filter((l) => l.s === n).sort((a, b) => nextY(a) - nextY(b) || cmp(laneKey(a), laneKey(b)));
    const ins = links.filter((l) => l.t === n).sort((a, b) => prevY(a) - prevY(b) || (a.dashed - b.dashed) || cmp(laneKey(a), laneKey(b)));
    let y = n.y + (n.h - n.outV * k) / 2;
    for (const l of outs) { l.y0 = y; y += l.w; }
    y = n.y + (n.h - n.inV * k) / 2;
    for (const l of ins) { l.y1 = y; y += l.w; }
  }
  for (const l of links) l.d = ribbon(l);
  return { W, H: Math.ceil(H + 4), k, labelH, right, colW };
}

/** Closed ribbon path: source edge, through each lane, into the target. */
function ribbon(l) {
  const pts = [[l.s.x + NODE_W, l.y0]];
  for (const ln of l.lanes) pts.push([ln.x, ln.y], [ln.x + NODE_W, ln.y]);
  pts.push([l.t.x, l.y1]);
  const w = l.w;
  const r = (v) => Math.round(v * 10) / 10;
  const seg = (a, b, dy) => {
    if (Math.abs(a[0] - b[0]) <= NODE_W + 0.01 && a[1] === b[1]) return `L${r(b[0])},${r(b[1] + dy)}`;
    const mx = (a[0] + b[0]) / 2;
    return `C${r(mx)},${r(a[1] + dy)} ${r(mx)},${r(b[1] + dy)} ${r(b[0])},${r(b[1] + dy)}`;
  };
  let d = `M${r(pts[0][0])},${r(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += seg(pts[i - 1], pts[i], 0);
  const last = pts[pts.length - 1];
  d += `L${r(last[0])},${r(last[1] + w)}`;
  for (let i = pts.length - 2; i >= 0; i--) d += seg(pts[i + 1], pts[i], w);
  return d + "Z";
}

// ---------------------------------------------------------------------------
// SVG markup (shared by the screen and the download)
// ---------------------------------------------------------------------------
const pct = (v, N) => (N ? `${Math.round((v / N) * 100)}%` : "0%");
const linkLabel = (l) => `${l.s.name} to ${l.t.name}`;

function chartMarkup(model, L, T, { standalone = false } = {}) {
  const { C, fs, family } = T;
  const { nodes, links, N } = model;
  const a = (s) => esc(s);
  const interactive = !standalone;
  const nodeSorted = [...nodes].sort((x, y) => x.col - y.col || x.y - y.y);
  const linkSorted = [...links].sort((x, y) => x.s.col - y.s.col || x.y0 - y.y0);
  let out = "";

  for (const l of linkSorted) {
    const color = linkColor(l, C);
    const paint = l.dashed
      ? `fill="${a(color)}" fill-opacity="${standalone ? 0 : 0.001}" stroke="${a(color)}" stroke-width="1.25" stroke-dasharray="4 3"`
      : `fill="${a(color)}" fill-opacity="${l.s.kind === "nr" ? 0.22 : l.s.kind === "root" ? 0.28 : 0.35}"`;
    if (interactive) {
      out += `<g class="sk-link${l.dashed ? " dashed" : ""}" data-link="${a(l.id)}" tabindex="-1" role="button" aria-label="${a(`${linkLabel(l)}: ${plural(l.v, "application")}${l.dashed ? ", closing stage not recorded" : ""}.`)}">`
        + `<path class="sk-rib" d="${l.d}" ${paint}/><path class="sk-ribhit" d="${l.d}" fill="none" stroke="transparent" stroke-width="6"/></g>`;
    } else out += `<path d="${l.d}" ${paint}/>`;
  }

  // Nodes on top of the ribbons, so their hit areas win. Nodes are tab stops;
  // links are reached with the arrow keys from a node (see onKey).
  for (const n of nodeSorted) {
    const color = nodeColor(n, C), h = Math.max(1, n.h);
    const nr = n.kind === "nr";
    const rect = `<rect x="${n.x}" y="${r1(n.y)}" width="${NODE_W}" height="${r1(h)}" rx="2" fill="${a(color)}" fill-opacity="${nodeOpacity(n)}"${nr ? ` stroke="${a(C.muted)}" stroke-width="1.25" stroke-dasharray="3 2"` : ""}/>`;
    let label;
    const name = n.kind === "term" ? n.name : fit(n.name, L.colW - 16 - measure(` ${n.v}`, fs.sm, 600, family), fs.sm, 500, family);
    const ink = n.kind === "nr" || n.term === "none" ? C.muted : C["ink-2"];
    const tsp = `<tspan fill="${a(ink)}" font-weight="500">${a(name)}</tspan><tspan fill="${a(C.ink)}" font-weight="600" dx="5">${n.v}</tspan>`;
    if (n.kind === "term") label = `<text x="${n.x + NODE_W + 6}" y="${r1(n.y + h / 2)}" dominant-baseline="central" font-size="${fs.sm}">${tsp}</text>`;
    else label = `<text x="${n.x}" y="${r1(n.y - 6)}" font-size="${fs.sm}">${tsp}</text>`;
    if (interactive) {
      const click = n.kind === "stage" ? " Press Enter to show this stage in the list." : "";
      out += `<g class="sk-node" data-node="${a(n.id)}" tabindex="0" role="button" aria-label="${a(`${n.name}: ${plural(n.v, "application")}, ${pct(n.v, N)} of ${N}.${click}`)}">`
        + `<rect class="sk-hit" x="${n.x - 5}" y="${r1(n.y - 4)}" width="${NODE_W + 10}" height="${r1(h + 8)}" rx="3" fill="transparent"/>`
        + `<g class="sk-mark">${rect}${label}</g></g>`;
    } else out += rect + label;
  }

  // Link counts, at the source end, where the ribbon is wide enough to hold one.
  const fsx = fs.xs;
  for (const l of linkSorted) {
    if (l.w < fsx + 3) continue;
    out += `<text${interactive ? ` class="sk-lt" data-for="${a(l.id)}"` : ""} x="${l.s.x + NODE_W + 5}" y="${r1(l.y0 + l.w / 2)}" dominant-baseline="central" font-size="${fsx}" font-weight="600" fill="${a(C.ink)}" pointer-events="none">${l.v}</text>`;
  }
  return out;
}
const r1 = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
let dlg = null, opener = null, model = null, hl = null, pinned = null, pop = null, popFor = null;
const $ = (sel) => dlg.querySelector(sel);

export const isOpen = () => !!dlg?.open;

const ICON = {
  close: `<svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  down: `<svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></svg>`,
  caret: `<svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>`,
};

function build() {
  dlg = document.createElement("dialog");
  dlg.className = "dlg sk-dlg";
  dlg.setAttribute("aria-labelledby", "sk-title");
  dlg.innerHTML = `
    <div class="dlg-head sk-head">
      <h2 id="sk-title">Flow</h2>
      <div class="seg sk-viewseg" role="group" aria-label="Show as">
        <button type="button" data-view="chart" aria-pressed="false">Chart</button>
        <button type="button" data-view="table" aria-pressed="false">Table</button>
      </div>
      <button type="button" class="btn sm" data-act="download" aria-haspopup="menu" aria-expanded="false">${ICON.down}<span>Download</span></button>
      <button type="button" class="btn ghost icon" data-act="close" aria-label="Close">${ICON.close}</button>
    </div>
    <div class="sk-filters" role="group" aria-label="Filters">
      <label class="sk-f"><span class="sk-flabel">Found</span>
        <select class="select sk-when" data-f="when">${WHEN.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>
      <span class="sk-custom" hidden>
        <label class="sk-f"><span class="sr-only">From</span><input class="input sk-date" type="date" data-f="from" aria-label="Found from"></label>
        <span class="muted" aria-hidden="true">to</span>
        <label class="sk-f"><span class="sr-only">To</span><input class="input sk-date" type="date" data-f="to" aria-label="Found to"></label>
      </span>
      <button type="button" class="btn sm sk-srcbtn" data-act="sources" aria-haspopup="true" aria-expanded="false"><span class="sk-srctext">Source: All</span>${ICON.caret}</button>
      <span class="sk-toggles">
        <label class="sk-check"><input type="checkbox" data-f="bySource"> Start from source</label>
        <label class="sk-check"><input type="checkbox" data-f="split"> Split outcomes</label>
        <label class="sk-check"><input type="checkbox" data-f="drafting"> Include drafting</label>
        <label class="sk-check"><input type="checkbox" data-f="history"> Include history</label>
      </span>
    </div>
    <div class="sk-summary"><span class="sk-sumtext tnum" aria-live="polite"></span><button type="button" class="linkbtn sk-reset" data-act="reset">Reset filters</button></div>
    <div class="sk-body">
      <div class="sk-chartwrap" hidden><svg class="sk-svg" role="group" aria-label="Flow of applications from start to outcome. Tab moves between stages; arrow keys move to the links."></svg></div>
      <div class="sk-tablewrap" hidden></div>
      <div class="sk-empty empty" hidden><strong>Nothing matches these filters.</strong><button type="button" class="linkbtn" data-act="reset">Reset filters</button></div>
      <div class="sk-legend" hidden></div>
      <p class="sk-foot" hidden></p>
    </div>
    <div class="sk-tip" role="tooltip" hidden></div>`;
  document.body.append(dlg);

  dlg.addEventListener("click", onClick);
  dlg.addEventListener("change", onChange);
  dlg.addEventListener("keydown", onKey);
  dlg.addEventListener("cancel", (e) => { if (pop) { e.preventDefault(); closePop(); } });
  dlg.addEventListener("close", () => {
    closePop(false); hideTip(); pinned = null; hl = null;
    const o = opener; opener = null;
    if (o && o.isConnected) o.focus?.({ preventScroll: true });
  });
  const svg = $(".sk-svg");
  svg.addEventListener("pointerover", onOver);
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", () => { if (!pinned) { setHL(null); hideTip(); } });
  svg.addEventListener("focusin", onFocus);
  svg.addEventListener("focusout", (e) => { if (!svg.contains(e.relatedTarget) && !pinned) { setHL(null); hideTip(); } });
  new ResizeObserver(() => { if (isOpen() && viewMode() === "chart") renderChart(); }).observe($(".sk-chartwrap"));
}

export function open() {
  if (!dlg) build();
  if (dlg.open) return;
  opener = document.activeElement;
  syncFilters();
  dlg.showModal();
  render();
  $(`.sk-viewseg [aria-pressed="true"]`)?.focus();
}
export function close() { if (dlg?.open) dlg.close(); }

let themeTimer = 0;
function themeChanged() {
  if (!isOpen()) return;
  cancelAnimationFrame(themeTimer);
  themeTimer = requestAnimationFrame(() => render());
}
export function init() {
  on("data", () => { if (isOpen()) render(); });
  new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true });
  new MutationObserver((recs) => {
    if (recs.some((r) => { const t = r.target.nodeType === 1 ? r.target : r.target.parentNode; return t?.id === "jt-theme" || [...r.addedNodes, ...r.removedNodes].some((n) => n.id === "jt-theme"); })) themeChanged();
  }).observe(document.head, { childList: true, characterData: true, subtree: true });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", themeChanged);
  mqPhone.addEventListener("change", () => { if (isOpen() && !F.view) render(); });
}

// ---- filters UI ----
function syncFilters() {
  $(".sk-when").value = F.when;
  $(".sk-custom").hidden = F.when !== "custom";
  $('[data-f="from"]').value = F.from;
  $('[data-f="to"]').value = F.to;
  for (const k of ["bySource", "split", "drafting", "history"]) $(`[data-f="${k}"]`).checked = !!F[k];
}
function onChange(e) {
  const t = e.target, k = t.dataset.f;
  if (t.closest(".sk-srclist")) {
    const s = t.value;
    F.srcOff = t.checked ? F.srcOff.filter((x) => x !== s) : [...new Set([...F.srcOff, s])];
    save(); render(); return;
  }
  if (!k) return;
  if (t.type === "checkbox") F[k] = t.checked;
  else F[k] = t.value;
  if (k === "when") $(".sk-custom").hidden = F.when !== "custom";
  if (k === "from" || k === "to") { if (F.when !== "custom") F.when = "custom"; }
  save(); render();
  if (k === "when" && F.when === "custom" && !F.from && !F.to) $('[data-f="from"]').focus();
}

function onClick(e) {
  if (e.target === dlg) { close(); return; }
  const b = e.target.closest("[data-act], [data-view], [data-open]");
  if (b) {
    if (b.dataset.view) { F.view = b.dataset.view; save(); render(); b.focus(); return; }
    if (b.dataset.open) { const id = b.dataset.open; close(); openDrawer(id); return; }
    switch (b.dataset.act) {
      case "close": close(); return;
      case "reset": Object.assign(F, structuredClone(DEF)); save(); syncFilters(); render(); $(".sk-when").focus(); return;
      case "sources": togglePop("sources", b); return;
      case "download": togglePop("download", b); return;
      case "src-all": F.srcOff = []; save(); render(); renderSrcList(); return;
      case "src-none": F.srcOff = srcList().map((x) => x[0]); save(); render(); renderSrcList(); return;
      case "png": closePop(); download("png"); return;
      case "svg": closePop(); download("svg"); return;
    }
  }
  const g = e.target.closest(".sk-node, .sk-link");
  if (g) { activate(g); return; }
  if (e.target.closest(".sk-svg") && pinned) { pinned = null; setHL(null); hideTip(); }
}

function onKey(e) {
  if (e.key === "Escape" && pop) { e.preventDefault(); e.stopPropagation(); closePop(); return; }
  if (pop?.dataset.kind === "download" && (e.key === "ArrowDown" || e.key === "ArrowUp") && pop.contains(e.target)) {
    e.preventDefault();
    const items = [...pop.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    return;
  }
  const g = e.target.closest?.(".sk-node, .sk-link");
  if (!g) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(g); return; }
  if (e.key.startsWith("Arrow")) { const next = arrowTarget(g, e.key); if (next) { e.preventDefault(); next.focus(); } }
}

/** Arrow keys inside the chart. On a node: Right/Left go to its outgoing/incoming
 *  links, Up/Down to the node above/below. On a link: Up/Down step through the
 *  links that share its source, Right/Left go to its target/source node. */
function arrowTarget(g, key) {
  const svg = $(".sk-svg");
  const nodeEl = (n) => n && svg.querySelector(`.sk-node[data-node="${CSS.escape(n.id)}"]`);
  const linkEl = (l) => l && svg.querySelector(`.sk-link[data-link="${CSS.escape(l.id)}"]`);
  if (g.dataset.node) {
    const n = nodeById(g.dataset.node);
    if (key === "ArrowRight") return linkEl(model.links.filter((l) => l.s === n).sort((a, b) => a.y0 - b.y0)[0]);
    if (key === "ArrowLeft") return linkEl(model.links.filter((l) => l.t === n).sort((a, b) => a.y1 - b.y1)[0]);
    const order = [...model.nodes].sort((a, b) => a.col - b.col || a.y - b.y);
    const i = order.indexOf(n);
    return nodeEl(order[i + (key === "ArrowDown" ? 1 : -1)]);
  }
  const l = linkById(g.dataset.link);
  if (key === "ArrowRight") return nodeEl(l.t);
  if (key === "ArrowLeft") return nodeEl(l.s);
  const sib = model.links.filter((x) => x.s === l.s).sort((a, b) => a.y0 - b.y0);
  return linkEl(sib[sib.indexOf(l) + (key === "ArrowDown" ? 1 : -1)]);
}

// ---- popovers (inside the dialog: it sits in the top layer) ----
function srcList() {
  const M = state.M;
  if (!M) return [];
  const pool = basePool(M, F);
  const counts = new Map();
  for (const a of M.all) { if (a.kind === "history" && !F.history) continue; counts.set(srcOf(a), 0); }
  for (const r of pool) counts.set(srcOf(r.app), (counts.get(srcOf(r.app)) || 0) + 1);
  for (const s of F.srcOff) if (!counts.has(s)) counts.set(s, 0);
  return [...counts].sort((x, y) => (x[0] === NO_SOURCE) - (y[0] === NO_SOURCE) || x[0].localeCompare(y[0]));
}
function renderSrcList() {
  if (pop?.dataset.kind !== "sources") return;
  const off = new Set(F.srcOff);
  const focusVal = document.activeElement?.closest?.(".sk-srclist") ? document.activeElement.value : null;
  pop.innerHTML = `<div class="sk-pophead"><span class="eyebrow">Sources</span><span class="sk-popacts">
      <button type="button" class="linkbtn" data-act="src-all">All</button><button type="button" class="linkbtn" data-act="src-none">None</button></span></div>
    <div class="sk-srclist">${srcList().map(([s, n]) => `<label class="sk-check"><input type="checkbox" value="${esc(s)}"${off.has(s) ? "" : " checked"}><span class="ellipsis">${esc(s)}</span><span class="muted tnum">${n}</span></label>`).join("")}</div>`;
  if (focusVal != null) [...pop.querySelectorAll("input")].find((i) => i.value === focusVal)?.focus();
}
function togglePop(kind, btn) {
  if (pop && pop.dataset.kind === kind) { closePop(); return; }
  closePop(false);
  pop = document.createElement("div");
  pop.className = `pop sk-pop sk-pop-${kind}`;
  pop.dataset.kind = kind;
  popFor = btn;
  if (kind === "download") {
    pop.setAttribute("role", "menu");
    pop.setAttribute("aria-label", "Download the chart");
    pop.innerHTML = `<button type="button" role="menuitem" data-act="png">PNG image</button><button type="button" role="menuitem" data-act="svg">SVG file</button>`;
  } else {
    pop.setAttribute("role", "group");
    pop.setAttribute("aria-label", "Sources to include");
  }
  dlg.append(pop);
  renderSrcList();
  btn.setAttribute("aria-expanded", "true");
  placePop();
  (pop.querySelector('[role="menuitem"], input'))?.focus();
  document.addEventListener("pointerdown", onOutside, true);
}
function placePop() {
  if (!pop || !popFor) return;
  const r = popFor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - pw - 8);
  let top = r.bottom + 4;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${top}px`;
}
function onOutside(e) { if (pop && !pop.contains(e.target) && !popFor?.contains(e.target)) closePop(false); }
function closePop(focus = true) {
  if (!pop) return;
  document.removeEventListener("pointerdown", onOutside, true);
  popFor?.setAttribute("aria-expanded", "false");
  pop.remove(); pop = null;
  if (focus) popFor?.focus();
  popFor = null;
}

// ---- render ----
function render() {
  if (!dlg) return;
  const M = state.M;
  const mode = viewMode();
  for (const b of dlg.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === mode));
  if (!M) { $(".sk-sumtext").textContent = "Loading…"; return; }
  model = buildModel(M, F);
  const { N, counts } = model;

  // Source button text
  const all = srcList();
  const onCount = all.filter(([s]) => !F.srcOff.includes(s)).length;
  $(".sk-srctext").textContent = !F.srcOff.length ? "Source: All" : onCount === 0 ? "Source: None" : onCount === 1 ? `Source: ${all.find(([s]) => !F.srcOff.includes(s))[0]}` : `Source: ${onCount} of ${all.length}`;
  renderSrcList();

  const parts = [plural(N, "application")];
  if (counts.closed) parts.push(`${counts.closed} closed`);
  if (counts.active) parts.push(`${counts.active} in progress`);
  if (counts.history) parts.push(`${counts.history} with no outcome`);
  $(".sk-sumtext").textContent = parts.join(" · ");
  dlg.querySelector(".sk-summary .sk-reset").hidden = isDefault();

  const empty = !N;
  $(".sk-empty").hidden = !empty;
  $(".sk-chartwrap").hidden = empty || mode !== "chart";
  $(".sk-tablewrap").hidden = empty || mode !== "table";
  $(".sk-legend").hidden = true;
  $(".sk-foot").hidden = true;
  $('[data-act="download"]').disabled = empty;
  hideTip(); pinned = null; hl = null;
  if (empty) return;
  if (mode === "chart") renderChart(); else renderTable();
  renderNotes();
}

let lastT = null, lastL = null;
function renderChart() {
  if (!model || !model.N) return;
  const wrap = $(".sk-chartwrap"), svg = $(".sk-svg");
  const T = theme();
  const width = Math.floor(wrap.clientWidth || 960);
  const L = layout(model, width, T, { minWidth: 760 });
  lastT = T; lastL = L;
  svg.setAttribute("width", L.W);
  svg.setAttribute("height", L.H);
  svg.setAttribute("viewBox", `0 0 ${L.W} ${L.H}`);
  svg.setAttribute("font-family", T.family);
  svg.innerHTML = chartMarkup(model, L, T);
  if (hl) setHL(hl);
}

function renderTable() {
  const rows = [...model.links].sort((x, y) => x.s.col - y.s.col || x.s.order - y.s.order || x.t.col - y.t.col || x.t.order - y.t.order || x.dashed - y.dashed);
  const names = (apps) => apps.slice().sort((p, q) => p.company.localeCompare(q.company))
    .map((a, i, arr) => `<span class="sk-coi"><button type="button" class="linkbtn sk-co" data-open="${esc(a.key)}">${esc(a.company)}</button>${i < arr.length - 1 ? "," : ""}</span>`).join(" ");
  $(".sk-tablewrap").innerHTML = `<table class="sk-table">
    <caption class="sr-only">Each step between stages, with how many applications took it</caption>
    <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col" class="num">Count</th><th scope="col">Applications</th></tr></thead>
    <tbody>${rows.map((l) => `<tr>
      <td>${esc(l.s.name)}${l.dashed ? ` <span class="tag neutral" title="The stage it closed from wasn't recorded. It reached at least ${esc(l.s.name)}.">or later</span>` : ""}</td>
      <td>${esc(l.t.name)}</td>
      <td class="num tnum">${l.v} <span class="muted">${pct(l.v, model.N)}</span></td>
      <td class="sk-apps">${names(l.apps)}</td></tr>`).join("")}</tbody></table>`;
}

function renderNotes() {
  const { counts } = model;
  const leg = [];
  if (viewMode() === "chart") {
    if (counts.dashed) leg.push(`<span class="sk-key"><svg width="22" height="12" aria-hidden="true"><rect x="1" y="2" width="20" height="8" rx="1" class="sk-key-dash"/></svg>Dashed: the stage it closed from wasn't recorded. It reached at least the stage shown.</span>`);
    if (counts.nrClosed || counts.nrHistory) leg.push(`<span class="sk-key"><svg width="12" height="14" aria-hidden="true"><rect x="2" y="1" width="8" height="12" rx="1" class="sk-key-nr"/></svg>Stage not recorded</span>`);
  }
  $(".sk-legend").innerHTML = leg.join("");
  $(".sk-legend").hidden = !leg.length;
  const foot = footnote(counts);
  $(".sk-foot").textContent = foot;
  $(".sk-foot").hidden = !foot;
}
function footnote(counts) {
  const bits = [];
  if (counts.nrClosed) bits.push(`${counts.nrClosed === 1 ? "1 closed application has" : `${counts.nrClosed} closed applications have`} no recorded stages (imported with just an outcome). Status changes made through the tracker fill this in from now on.`);
  if (counts.nrHistory) bits.push(`${counts.nrHistory === 1 ? "1 history row has" : `${counts.nrHistory} history rows have`} no stage or outcome recorded.`);
  return bits.join(" ");
}

// ---- hover, focus, tooltip ----
const linkById = (id) => model?.links.find((l) => l.id === id);
const nodeById = (id) => model?.nodes.find((n) => n.id === id);
function targetOf(el) {
  const g = el?.closest?.(".sk-node, .sk-link");
  if (!g) return null;
  return g.dataset.node ? { type: "node", item: nodeById(g.dataset.node), el: g } : { type: "link", item: linkById(g.dataset.link), el: g };
}
function setHL(t) {
  hl = t;
  const svg = $(".sk-svg");
  if (!t || !t.item) { svg.classList.remove("is-hl"); for (const el of svg.querySelectorAll(".on")) el.classList.remove("on"); return; }
  const set = new Set(t.item.apps.map((a) => a.key));
  const hit = (apps) => apps.some((a) => set.has(a.key));
  svg.classList.add("is-hl");
  for (const g of svg.querySelectorAll(".sk-node")) g.classList.toggle("on", hit(nodeById(g.dataset.node)?.apps || []));
  for (const g of svg.querySelectorAll(".sk-link")) {
    const l = linkById(g.dataset.link);
    g.classList.toggle("on", !!l && hit(l.apps));
    g.classList.toggle("cur", t.type === "link" && l === t.item);
  }
  for (const tx of svg.querySelectorAll(".sk-lt")) { const l = linkById(tx.dataset.for); tx.classList.toggle("on", !!l && hit(l.apps)); }
}
function onOver(e) {
  if (pinned) return;
  const t = targetOf(e.target);
  if (!t) { setHL(null); hideTip(); return; }
  if (hl?.item !== t.item) setHL(t);
  showTip(t, e.clientX, e.clientY);
}
function onMove(e) {
  if (pinned) return;
  const t = targetOf(e.target);
  if (t) showTip(t, e.clientX, e.clientY);
  else if (hl) { setHL(null); hideTip(); }
}
function onFocus(e) {
  const t = targetOf(e.target);
  if (!t) return;
  pinned = null;
  setHL(t);
  const r = t.el.querySelector(".sk-hit, .sk-rib").getBoundingClientRect();
  showTip(t, r.right, r.top + Math.min(r.height / 2, 40));
}
function activate(g) {
  const t = targetOf(g);
  if (!t?.item) return;
  if (t.type === "node" && t.item.kind === "stage") {
    const stage = t.item.stage;
    close();
    setView({ stage });
    return;
  }
  if (pinned && pinned.item === t.item) { pinned = null; return; }
  pinned = t; setHL(t);
  const r = g.getBoundingClientRect();
  showTip(t, r.left + r.width / 2, r.top + Math.min(r.height / 2, 40));
}

function showTip(t, x, y) {
  const tip = $(".sk-tip"), it = t.item;
  if (!it) return;
  const N = model.N;
  let title, note = "";
  if (t.type === "node") {
    title = esc(it.name);
    if (it.kind === "stage") {
      const now = (state.M?.byStage?.[it.stage] || []).length;
      note = `<div class="sk-tipnote">${now ? `${plural(now, "application")} at this stage now. ` : ""}Click to show this stage in the list.</div>`;
    } else if (it.kind === "nr") note = `<div class="sk-tipnote">No stage was recorded for these. They were imported with just an outcome.</div>`;
  } else {
    title = `${esc(it.s.name)} <span aria-hidden="true">→</span> ${esc(it.t.name)}`;
    if (it.dashed) note = `<div class="sk-tipnote">The stage these closed from wasn't recorded. Each reached at least ${esc(it.s.name)}.</div>`;
  }
  const names = it.apps.map((a) => a.company).sort((p, q) => p.localeCompare(q));
  const shown = names.slice(0, 12);
  tip.innerHTML = `<div class="sk-tipval"><strong class="tnum">${it.v}</strong> <span class="muted tnum">${pct(it.v, N)} of ${N}</span></div>
    <div class="sk-tiptitle">${title}</div>
    <div class="sk-tipnames">${shown.map(esc).join(", ")}${names.length > 12 ? ` <span class="muted">+${names.length - 12} more</span>` : ""}</div>${note}`;
  tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + tw > window.innerWidth - 8) left = Math.max(8, x - tw - 14);
  if (top + th > window.innerHeight - 8) top = Math.max(8, y - th - 14);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTip() { const tip = dlg?.querySelector(".sk-tip"); if (tip) tip.hidden = true; }

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------
function filterCaption() {
  const win = F.when === "custom"
    ? (F.from || F.to ? `found ${F.from ? fmt(F.from) : "any time"} to ${F.to ? fmt(F.to) : "today"}` : "found any time")
    : `found ${WHEN.find(([v]) => v === F.when)[1].toLowerCase()}`;
  const all = srcList();
  const on = all.filter(([s]) => !F.srcOff.includes(s)).map(([s]) => s);
  const src = !F.srcOff.length ? "all sources" : on.length <= 3 ? `sources: ${on.join(", ") || "none"}` : `${on.length} of ${all.length} sources`;
  const bits = [win.charAt(0).toUpperCase() + win.slice(1), src];
  if (F.bySource) bits.push("starting from source");
  bits.push(F.split ? "outcomes split" : "outcomes combined");
  bits.push(F.drafting ? "drafting included" : "drafting left out");
  bits.push(F.history ? "history included" : "history left out");
  return bits.join(" · ");
}

function wrapText(text, max, size, weight, family) {
  const words = text.split(" "), lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && measure(t, size, weight, family) > max) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** A standalone SVG: resolved colors and font, explicit size, solid background. */
export function exportSVG() {
  const T = theme(), { C, fs, family } = T;
  const pad = 32, W = 1200, inner = W - pad * 2;
  const L = layout(model, inner, T);
  const a = esc;
  const { N, counts } = model;
  const summary = [plural(N, "application")];
  if (counts.closed) summary.push(`${counts.closed} closed`);
  if (counts.active) summary.push(`${counts.active} in progress`);
  if (counts.history) summary.push(`${counts.history} with no outcome`);
  const capLines = wrapText(`${summary.join(" · ")}. ${filterCaption()}. Made ${today().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`, inner, fs.sm, 400, family);

  let y = pad + fs.xl;
  let head = `<text x="${pad}" y="${y}" font-size="${fs.xl}" font-weight="600" fill="${a(C.ink)}">Job search flow</text>`;
  y += 8;
  for (const line of capLines) { y += fs.sm * 1.5; head += `<text x="${pad}" y="${r1(y)}" font-size="${fs.sm}" fill="${a(C.muted)}">${a(line)}</text>`; }
  const chartY = y + 20;
  let by = chartY + L.H + 16;

  let legend = "";
  const lx = pad;
  if (counts.dashed) {
    by += fs.sm * 1.6;
    const col = C.s3;
    legend += `<rect x="${lx}" y="${r1(by - fs.sm * 0.85)}" width="22" height="${r1(fs.sm)}" rx="1" fill="none" stroke="${a(col)}" stroke-width="1.25" stroke-dasharray="4 3"/>`
      + `<text x="${lx + 30}" y="${r1(by)}" font-size="${fs.sm}" fill="${a(C["ink-2"])}">Dashed: the stage it closed from wasn't recorded. It reached at least the stage shown.</text>`;
  }
  if (counts.nrClosed || counts.nrHistory) {
    by += fs.sm * 1.6;
    legend += `<rect x="${lx + 7}" y="${r1(by - fs.sm * 0.95)}" width="8" height="${r1(fs.sm * 1.1)}" rx="1" fill="${a(C.axis)}" fill-opacity="0.55" stroke="${a(C.muted)}" stroke-width="1.25" stroke-dasharray="3 2"/>`
      + `<text x="${lx + 30}" y="${r1(by)}" font-size="${fs.sm}" fill="${a(C["ink-2"])}">Stage not recorded</text>`;
  }
  const foot = footnote(counts);
  if (foot && legend) by += fs.sm * 0.6;
  if (foot) for (const line of wrapText(foot, inner, fs.sm, 400, family)) {
    by += fs.sm * 1.5;
    legend += `<text x="${lx}" y="${r1(by)}" font-size="${fs.sm}" fill="${a(C.muted)}">${a(line)}</text>`;
  }
  const H = Math.ceil(by + pad);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${a(family)}">
<title>Job search flow</title>
<rect x="0" y="0" width="${W}" height="${H}" fill="${a(C.page)}"/>
${head}
<g transform="translate(${pad} ${r1(chartY)})">${chartMarkup(model, L, T, { standalone: true })}</g>
${legend}
</svg>`;
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; link.hidden = true;
  dlg.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function download(kind) {
  if (!model?.N) return;
  const svg = exportSVG();
  const name = `job-search-flow-${iso(today())}.${kind}`;
  if (kind === "svg") { saveBlob(new Blob([svg], { type: "image/svg+xml" }), name); return; }
  const m = svg.match(/<svg[^>]* width="(\d+)" height="(\d+)"/);
  const w = +m[1], h = +m[2];
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("Couldn't draw the image.")); img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext("2d");
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (blob) saveBlob(blob, name);
  } catch (err) {
    import("./toast.js").then((t) => t.toast(err.message));
  } finally { URL.revokeObjectURL(url); }
}
