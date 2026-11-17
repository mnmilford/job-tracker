// Status menu: a popover anchored to a status badge (list rows, archive rows,
// the drawer). Picking a stage writes it straight away; picking an outcome
// opens a second step in the same popover for the lesson and the date.
//
//   open(anchorEl, app)   toggle the menu for app under anchorEl
//   close()               close it and return focus to the anchor
//   isOpen()
import { state, hold, release } from "../core/state.js";
import { esc, iso, today } from "../core/format.js";
import * as actions from "../core/actions.js";
import { toast } from "./toast.js";
import { badgeFor } from "./list.js";
import { badgeEl as drawerBadge } from "./drawer.js";

let pop = null;        // the .pop element while open
let anchor = null;     // element it hangs from
let app = null;        // application it acts on
let fromDrawer = false;

export const isOpen = () => !!pop;

const items = () => (pop ? [...pop.querySelectorAll('[role^="menuitem"]:not([disabled])')] : []);
const currentOf = (a) => (a.kind === "history" ? "History" : a.stage);

export function open(anchorEl, a) {
  if (!a) return;
  if (pop && anchor === anchorEl) { close(); return; }
  if (pop) teardown();
  anchor = anchorEl; app = a;
  fromDrawer = !!anchorEl?.closest?.("#drawer");
  pop = document.createElement("div");
  pop.className = "pop statusmenu";
  pop.addEventListener("keydown", onKey);
  pop.addEventListener("click", onClick);
  document.body.append(pop);
  hold("statusmenu");
  anchor?.setAttribute("aria-expanded", "true");
  renderMenu();
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
}

/** Close and give focus back to the badge (or its replacement after a re-render). */
export function close({ focus = true } = {}) {
  if (!pop) return;
  const key = app?.key, wasDrawer = fromDrawer, a = anchor;
  teardown();
  if (!focus) return;
  let target = a && a.isConnected ? a : null;
  if (!target && key) target = wasDrawer ? drawerBadge() : badgeFor(key);
  target?.focus({ preventScroll: true });
}

function teardown() {
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("resize", place);
  window.removeEventListener("scroll", place, true);
  anchor?.setAttribute("aria-expanded", "false");
  pop?.remove();
  pop = null; anchor = null; app = null;
  release("statusmenu");
}

// ---- step 1: the menu ----
function renderMenu() {
  const M = state.M, cur = currentOf(app);
  let n = 0;
  const item = (value, dot, { disabled = false } = {}) => {
    const checked = value === cur;
    const k = disabled ? "" : ++n <= 9 ? `<span class="kbd" aria-hidden="true">${n}</span>` : "";
    return `<button type="button" role="menuitemradio" aria-checked="${checked}" data-v="${esc(value)}"${disabled ? " disabled" : ""}>
      <i class="sm-dot" style="--stage: ${dot}"></i><span class="sm-name">${esc(value === "History" ? "History (no status yet)" : value)}</span>
      ${checked ? `<svg class="ico sm-check" aria-hidden="true" viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>` : ""}${k}</button>`;
  };
  pop.setAttribute("role", "menu");
  pop.setAttribute("aria-label", `Status for ${app.company}`);
  pop.innerHTML =
    (app.kind === "history" ? `${item("History", "var(--muted)", { disabled: true })}<hr>` : "")
    + `<div class="pop-label eyebrow" role="presentation">In progress</div>`
    + M.stages.map((s) => item(s, M.colorOf(s))).join("")
    + `<hr><div class="pop-label eyebrow" role="presentation">Closed</div>`
    + M.outcomes.map((o) => item(o, o === "Hired" ? "var(--good)" : "var(--muted)")).join("");
  place();
  const list = items();
  (list.find((b) => b.getAttribute("aria-checked") === "true") || list[0])?.focus();
}

// ---- step 2: closing with an outcome ----
function renderOutcome(outcome) {
  pop.removeAttribute("role");
  pop.setAttribute("aria-label", `Close ${app.company} as ${outcome}`);
  pop.innerHTML = `<form class="sm-form" novalidate>
      <div class="sm-title"><i class="sm-dot" style="--stage: ${outcome === "Hired" ? "var(--good)" : "var(--muted)"}"></i>
        <span><strong>${esc(outcome)}</strong> <span class="muted">· ${esc(app.company)}</span></span></div>
      <div class="field"><label for="sm-lesson">Why it closed / lesson <span class="muted">(optional)</span></label>
        <input class="input" id="sm-lesson" name="lesson" autocomplete="off" value="${esc(app.lesson || "")}"></div>
      <div class="field"><label for="sm-date">Date</label>
        <input class="input" id="sm-date" name="date" type="date" value="${iso(today())}" required></div>
      <div class="sm-foot">
        <button type="button" class="btn sm ghost" data-back>Back</button>
        <button type="submit" class="btn sm primary">Close as ${esc(outcome)}</button>
      </div>
    </form>`;
  const form = pop.querySelector("form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const lesson = form.lesson.value.trim(), date = form.date.value || iso(today());
    commit(outcome, { date, lesson: lesson || undefined });
  });
  place();
  const input = form.lesson;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function pick(value) {
  if (!value || value === currentOf(app)) { close(); return; }
  if (state.M.outcomes.includes(value)) { renderOutcome(value); return; }
  commit(value, {});
}

async function commit(status, opts) {
  const a = app, wasDrawer = fromDrawer;
  close();
  try { await actions.setStatus(a, status, opts); }
  catch (err) { toast(err.message || "Couldn't save"); }
  // The write re-renders the badge's view; if focus fell to <body>, put it back on the new badge.
  const ae = document.activeElement;
  if (!ae || ae === document.body) (wasDrawer ? drawerBadge() : badgeFor(a.key))?.focus({ preventScroll: true });
}

// ---- events ----
function onClick(e) {
  if (e.target.closest("[data-back]")) { renderMenu(); return; }
  const b = e.target.closest('[role^="menuitem"]');
  if (b && !b.disabled) pick(b.dataset.v);
}

function onKey(e) {
  e.stopPropagation(); // keep Esc from closing the drawer, j/k from moving the list
  if (e.key === "Escape") { e.preventDefault(); close(); return; }
  if (e.key === "Tab") { // keep focus inside; the menu has no tab stops of its own
    if (pop.querySelector("form")) {
      const f = [...pop.querySelectorAll("input, button")];
      const i = f.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i + 1) % f.length;
      e.preventDefault(); f[next].focus();
    } else { e.preventDefault(); close(); }
    return;
  }
  if (pop.querySelector("form")) return; // the form handles Enter itself
  const list = items(), i = list.indexOf(document.activeElement);
  const go = (j) => { e.preventDefault(); list[(j + list.length) % list.length]?.focus(); };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i < 0 ? list.length - 1 : i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(list.length - 1);
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (i >= 0) pick(list[i].dataset.v); }
  else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const b = list[+e.key - 1];
    if (b) { e.preventDefault(); pick(b.dataset.v); }
  }
}

function onOutside(e) {
  if (!pop || pop.contains(e.target)) return;
  if (anchor && anchor.contains(e.target)) return; // the anchor's own click toggles it closed
  close({ focus: false });
}

/** Hang under the anchor; flip above when there's no room; stay inside the viewport. */
function place() {
  if (!pop) return;
  if (anchor && !anchor.isConnected) {
    // Anchor was re-rendered away (rare: holds stop live refresh). Re-find it.
    const fresh = fromDrawer ? drawerBadge() : badgeFor(app.key);
    if (fresh) { anchor = fresh; anchor.setAttribute("aria-expanded", "true"); }
  }
  const r = anchor?.getBoundingClientRect() || { left: 0, right: 0, top: 0, bottom: 0 };
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space")) || 4;
  const edge = gap * 2;
  const w = pop.offsetWidth, h = pop.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  let top = r.bottom + gap;
  if (top + h > vh - edge && r.top - gap - h >= edge) top = r.top - gap - h;
  top = Math.max(edge, Math.min(top, vh - h - edge));
  const left = Math.max(edge, Math.min(r.left, vw - w - edge));
  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;
}
