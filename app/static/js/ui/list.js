// The main list: the stage strip ("where things stand"), active applications
// grouped by stage, and the Archive (closed + history).
//
//   init(el)        mount into #main
//   focusFirst()    select and focus the first visible row
//   move(delta)     move the selection through visible rows (shortcuts.js drives this)
//   openSelected()  open the selected row in the drawer
//   badgeFor(id)    that row's status badge, or null
import { state, on, setView, select, openDrawer, matchQuery } from "../core/state.js";
import { esc, fmt, rel, parse, today, plural } from "../core/format.js";
import * as statusmenu from "./statusmenu.js";

let root = null;
let autoClosedFor = null; // search text for which the user closed the auto-opened archive

const CARET = `<svg class="ico caret" aria-hidden="true" viewBox="0 0 16 16"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>`;
const CHEVRON = `<svg class="ico chev" aria-hidden="true" viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>`;
const WINDOWS = [["all", "Any time"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["year", "This year"]];

export function init(el) {
  root = el;
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  root.addEventListener("change", onChange);
  on("data", render);
  on("view", render);
  on("seen", render);
  on("select", markRows);
  on("drawer", markRows);
}

// ---------- helpers ----------
const rowsInDom = () => (root ? [...root.querySelectorAll(".row[data-key]")] : []);
const rowEl = (key) => root?.querySelector(`.row[data-key="${CSS.escape(String(key))}"]`) || null;

export function badgeFor(id) { return rowEl(id)?.querySelector(".badge") || null; }

export function focusFirst() {
  const r = rowsInDom()[0];
  if (!r) { root?.focus(); return; }
  select(r.dataset.key);
  r.focus();
  r.scrollIntoView({ block: "nearest" });
}

export function move(delta) {
  const rows = rowsInDom();
  if (!rows.length) return;
  let i = rows.findIndex((r) => r.dataset.key === state.selectedId);
  if (i < 0) i = delta > 0 ? -1 : rows.length;
  const next = rows[Math.max(0, Math.min(rows.length - 1, i + delta))];
  select(next.dataset.key);
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest" });
}

export function openSelected() {
  if (state.selectedId && state.M?.byId[state.selectedId]) openDrawer(state.selectedId);
}

/** Next-step text without the ISO date (the date tag shows it); full text stays in the title. */
const nextText = (s) => String(s || "").replace(/\s*\b(by|on)?\s*\d{4}-\d{2}-\d{2}/, "").replace(/\s{2,}/g, " ").trim();

function inWindow(a, when) {
  if (when === "all") return true;
  const d = parse(a.lastActivity);
  if (!d) return false;
  if (when === "year") return d.getFullYear() === today().getFullYear();
  return a.idle !== null && a.idle <= Number(when);
}

const sortActive = (x, y) =>
  (y.overdue - x.overdue)
  || ((x.nextIn ?? Infinity) - (y.nextIn ?? Infinity))
  || ((y.idle ?? -1) - (x.idle ?? -1))
  || x.company.localeCompare(y.company);

// ---------- render ----------
function render() {
  if (!root || !state.M) return;
  const M = state.M, v = state.view;
  const q = String(v.q || "").trim();

  // Remember focus and scroll so a refresh never yanks the user around.
  const ae = document.activeElement, inside = root.contains(ae);
  const focusRow = inside ? ae.closest(".row[data-key]") : null;
  const focusSel = !inside ? null
    : ae.matches(".row[data-key]") ? { key: ae.dataset.key, part: "row" }
    : focusRow && ae.matches(".badge") ? { key: focusRow.dataset.key, part: "badge" }
    : ae.dataset.f ? { f: ae.dataset.f } : null;
  const stripScroll = root.querySelector(".strip")?.scrollLeft || 0;
  const y = window.scrollY;

  root.innerHTML = strip(M, v) + activeSection(M, v, q) + archiveSection(M, v, q);

  const s = root.querySelector(".strip"); if (s) s.scrollLeft = stripScroll;
  if (focusSel) {
    let t = null;
    if (focusSel.key) {
      const r = rowEl(focusSel.key);
      t = r && focusSel.part === "badge" ? r.querySelector(".badge") : r;
    } else t = root.querySelector(`[data-f="${CSS.escape(focusSel.f)}"]`);
    if (!t && focusSel.key && state.selectedId) t = rowEl(state.selectedId);
    (t || root).focus({ preventScroll: true });
  }
  if (window.scrollY !== y) window.scrollTo(0, y);
  markRows();
}

function strip(M, v) {
  const cell = (name, n, color, label = name) => {
    const on = v.stage === name;
    return `<button type="button" class="strip-cell${n ? "" : " zero"}" data-stage="${esc(name)}" data-f="stage:${esc(name)}" aria-pressed="${on}" style="--stage: ${color}"
      title="${on && name !== "All" ? "Show all stages" : `Show ${esc(label)}`}"><span class="strip-name">${esc(label)}</span><span class="strip-n tnum">${n}</span></button>`;
  };
  return `<nav class="strip" aria-label="Where things stand">`
    + cell("All", M.active.length, "var(--ink-2)", "All active")
    + M.stages.map((s) => cell(s, M.byStage[s].length, M.colorOf(s))).join("")
    + `</nav>`;
}

function activeSection(M, v, q) {
  const stageOk = (s) => v.stage === "All" || v.stage === s || !M.stages.includes(v.stage);
  const groups = [...M.stages].reverse().filter(stageOk).map((s) => ({ s, apps: M.byStage[s].filter((a) => matchQuery(a)).sort(sortActive) }));
  const shown = groups.reduce((n, g) => n + g.apps.length, 0);
  const filtered = !!q || (v.stage !== "All" && M.stages.includes(v.stage));

  let body;
  if (!M.active.length) {
    body = `<div class="empty"><strong>No active applications</strong>Add one with New, or paste a job description to Claude.</div>`;
  } else if (!shown) {
    body = `<div class="empty"><strong>No active applications match${q ? ` “${esc(q)}”` : ""}${v.stage !== "All" ? ` in ${esc(v.stage)}` : ""}</strong>
      <button type="button" class="linkbtn" data-clear data-f="clear">Clear filters</button></div>`;
  } else {
    body = groups.filter((g) => g.apps.length).map((g) => group(M, v, g)).join("");
  }
  // The strip already says how many are active; the heading only appears to explain a filter.
  const head = filtered && shown ? `<div class="section-h list-h"><h2 class="eyebrow">Showing</h2><span class="count">${shown} of ${M.active.length} active${q ? ` matching “${esc(q)}”` : ""}</span>
    <span class="spacer"></span><button type="button" class="linkbtn list-clear" data-clear data-f="clear2">Clear filters</button></div>` : `<h2 class="sr-only">Active applications</h2>`;
  return `<section class="list-active" aria-label="Active applications">${head}${body}</section>`;
}

function group(M, v, { s, apps }) {
  const collapsed = !!v.collapsed?.[s];
  const id = `g-${s.replace(/\W+/g, "-").toLowerCase()}`;
  return `<section class="group${collapsed ? " collapsed" : ""}" aria-labelledby="${id}-h">
    <h3 class="group-h" id="${id}-h"><button type="button" class="group-toggle" data-collapse="${esc(s)}" data-f="col:${esc(s)}" aria-expanded="${!collapsed}" aria-controls="${id}">
      ${CHEVRON}<i class="sdot" style="--stage: ${M.colorOf(s)}"></i><span class="group-name">${esc(s)}</span><span class="group-n tnum">${apps.length}</span></button></h3>
    <ul class="rows" id="${id}"${collapsed ? " hidden" : ""}>${collapsed ? "" : apps.map((a) => row(M, a)).join("")}</ul>
  </section>`;
}

function badge(a, label, color) {
  return `<button type="button" class="badge" style="--stage: ${color}" aria-haspopup="menu" aria-expanded="false" title="Change status"
    aria-label="Status: ${esc(label)}. Change status"><i></i><span class="ellipsis">${esc(label)}</span>${CARET}</button>`;
}

function row(M, a) {
  const unseen = M.changedIds.has(a.key);
  let when = "";
  if (a.nextDate) {
    const tone = a.overdue ? "critical" : a.nextIn !== null && a.nextIn <= 2 ? "accent" : "neutral";
    const label = a.overdue ? `${-a.nextIn}d late` : rel(a.nextDate);
    when = `<span class="tag ${tone} when tnum" title="${esc(fmt(a.nextDate))}${a.overdue ? `, ${plural(-a.nextIn, "day")} overdue` : ""}">${esc(label)}</span>`;
  }
  const text = nextText(a.next);
  const next = a.next
    ? `${when}<span class="ellipsis next-t" title="${esc(a.next)}">${esc(text || a.next)}</span>`
    : `<span class="muted next-none">No next step</span>`;
  const idle = a.idle === null ? "" : `<span class="idle tnum${a.quiet ? " quiet" : ""}" title="${a.quiet ? "Quiet: " : ""}${plural(a.idle, "day")} since last activity">${a.idle}d</span>`;
  return `<li class="row r-active" data-key="${a.key}" tabindex="0" aria-label="${esc(a.company)}, ${esc(a.role)}">
    <span class="unseen${unseen ? " on" : ""}" ${unseen ? 'title="Changed since you last looked"' : 'aria-hidden="true"'}>${unseen ? '<span class="sr-only">Changed since you last looked</span>' : ""}</span>
    <span class="who"><strong class="co ellipsis">${esc(a.company)}</strong><span class="role ellipsis">${esc(a.role)}</span></span>
    <span class="st">${badge(a, a.stage, a.stageColor)}</span>
    <span class="next">${next}</span>
    <span class="comp ellipsis tnum"${a.comp ? ` title="${esc(a.comp)}"` : ""}>${esc(a.comp)}</span>
    <span class="idle-c">${idle}</span>
  </li>`;
}

function archiveSection(M, v, q) {
  const base = [...M.closed, ...M.history];
  const pool = base.filter((a) => matchQuery(a) && inWindow(a, v.archiveWhen));
  const outcomeOf = (a) => (a.kind === "history" ? "History" : a.stage);
  const counts = { All: pool.length, History: 0 };
  for (const o of M.outcomes) counts[o] = 0;
  for (const a of pool) counts[outcomeOf(a)] = (counts[outcomeOf(a)] || 0) + 1;
  const filter = v.archiveOutcome in counts ? v.archiveOutcome : "All";
  const rows = pool.filter((a) => filter === "All" || outcomeOf(a) === filter)
    .sort((x, y) => (y.lastActivity || "").localeCompare(x.lastActivity || "") || x.company.localeCompare(y.company));
  const auto = !!q && pool.length > 0 && autoClosedFor !== q.toLowerCase();
  const open = !!v.archiveOpen || auto;
  const narrowed = !!q || v.archiveWhen !== "all";

  const segs = ["All", ...M.outcomes, "History"].map((o) =>
    `<button type="button" data-outcome="${esc(o)}" data-f="out:${esc(o)}" aria-pressed="${filter === o}">${esc(o)}<span class="n">${counts[o] || 0}</span></button>`).join("");
  const sel = `<label class="sr-only" for="arch-when">Time window</label><select class="select sm" id="arch-when" data-f="when">${WINDOWS.map(([k, l]) =>
    `<option value="${k}"${v.archiveWhen === k ? " selected" : ""}>${l}</option>`).join("")}</select>`;

  let body = "";
  if (open) {
    let list;
    if (!base.length) list = `<div class="empty"><strong>Nothing archived yet</strong>Closed applications and history land here.</div>`;
    else if (!rows.length) list = `<div class="empty">Nothing here${q ? ` for “${esc(q)}”` : ""}${v.archiveWhen !== "all" ? " in this time window" : ""}.
      ${narrowed || filter !== "All" ? `<button type="button" class="linkbtn" data-clear-archive data-f="clear-arch">Clear filters</button>` : ""}</div>`;
    else list = `<ul class="rows">${rows.map((a) => archiveRow(M, a)).join("")}</ul>`;
    body = `<div class="arch-tools"><div class="seg" role="group" aria-label="Filter by outcome">${segs}</div>${sel}</div>${list}`;
  }
  const count = narrowed ? `${pool.length} of ${base.length}` : base.length;
  return `<section class="archive${open ? " open" : ""}" aria-label="Archive">
    <h2 class="section-h arch-h"><button type="button" class="group-toggle arch-toggle" data-archive data-f="archive" aria-expanded="${open}"${auto && !v.archiveOpen ? ' title="Opened because your search matches archived applications"' : ""}>
      ${CHEVRON}<span class="eyebrow">Archive</span><span class="count">${count}</span></button></h2>
    ${body}</section>`;
}

function archiveRow(M, a) {
  const label = a.kind === "history" ? "No outcome" : a.stage;
  const color = a.kind === "history" ? "var(--muted)" : a.stage === "Hired" ? "var(--good)" : "var(--muted)";
  const unseen = M.changedIds.has(a.key);
  return `<li class="row r-arch${a.stage === "Hired" ? " hired" : ""}" data-key="${a.key}" tabindex="0" aria-label="${esc(a.company)}, ${esc(a.role)}">
    <span class="unseen${unseen ? " on" : ""}" ${unseen ? 'title="Changed since you last looked"' : 'aria-hidden="true"'}>${unseen ? '<span class="sr-only">Changed since you last looked</span>' : ""}</span>
    <span class="who"><strong class="co ellipsis">${esc(a.company)}</strong><span class="role ellipsis">${esc(a.role)}</span></span>
    <span class="st">${badge(a, label, color)}</span>
    <span class="lesson ellipsis"${a.lesson ? ` title="${esc(a.lesson)}"` : ""}>${a.lesson ? esc(a.lesson) : '<span class="muted">No lesson noted</span>'}</span>
    <span class="date tnum"${a.lastActivity ? ` title="${esc(a.lastActivity)}"` : ""}>${a.lastActivity ? esc(fmt(a.lastActivity)) : ""}</span>
  </li>`;
}

/** Selection and drawer highlight, without a rebuild (keeps focus and the menu anchor). */
function markRows() {
  for (const r of rowsInDom()) {
    r.classList.toggle("is-selected", r.dataset.key === state.selectedId);
    const open = r.dataset.key === state.drawerId;
    r.classList.toggle("is-open", open);
    if (open) r.setAttribute("aria-current", "true"); else r.removeAttribute("aria-current");
  }
}

// ---------- events ----------
function clearFilters() {
  const q = document.getElementById("q"); if (q) q.value = "";
  setView({ q: "", stage: "All" });
}

function onClick(e) {
  const t = e.target;
  const b = t.closest(".row .badge");
  if (b) {
    e.stopPropagation();
    const key = b.closest(".row").dataset.key;
    select(key);
    statusmenu.open(b, state.M.byId[key]);
    return;
  }
  const cell = t.closest("[data-stage]");
  if (cell) { const s = cell.dataset.stage; setView({ stage: state.view.stage === s || s === "All" ? "All" : s }); return; }
  const col = t.closest("[data-collapse]");
  if (col) { const s = col.dataset.collapse; setView({ collapsed: { ...state.view.collapsed, [s]: !state.view.collapsed?.[s] } }); return; }
  if (t.closest("[data-archive]")) {
    const shownOpen = t.closest("[data-archive]").getAttribute("aria-expanded") === "true";
    const q = String(state.view.q || "").trim().toLowerCase();
    autoClosedFor = shownOpen && q ? q : null;
    setView({ archiveOpen: !shownOpen });
    return;
  }
  const out = t.closest("[data-outcome]");
  if (out) { setView({ archiveOutcome: out.dataset.outcome }); return; }
  if (t.closest("[data-clear]")) { clearFilters(); return; }
  if (t.closest("[data-clear-archive]")) {
    const q = document.getElementById("q"); if (q && state.view.q) q.value = "";
    setView({ q: "", archiveOutcome: "All", archiveWhen: "all" });
    return;
  }
  const r = t.closest(".row[data-key]");
  if (r) { openDrawer(r.dataset.key); }
}

function onKey(e) {
  const r = e.target.closest?.(".row[data-key]");
  if (!r || e.target !== r) return; // keys on the badge stay with the badge
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openDrawer(r.dataset.key); }
}

function onChange(e) {
  if (e.target.id === "arch-when") setView({ archiveWhen: e.target.value });
}

// Clicking/focusing a row selects it, so keyboard movement continues from there.
document.addEventListener("focusin", (e) => {
  const r = root && e.target.matches?.(".row[data-key]") && root.contains(e.target) ? e.target : null;
  if (r && r.dataset.key !== state.selectedId) select(r.dataset.key);
});
