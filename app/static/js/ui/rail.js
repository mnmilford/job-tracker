// The right rail: Today (what needs you), Coming up, and Since you last looked.
import { state, on, openDrawer } from "../core/state.js";
import { esc, fmt, rel } from "../core/format.js";
import { lastSeenAt } from "../core/changes.js";
import * as actions from "../core/actions.js";
import { toast } from "./toast.js";

let root = null;
let firstVisit = false;     // no since-last-look baseline existed when the page opened
let showAll = false;        // "Show all N" changes
const busy = new Set();     // Today item keys with a write in flight
const SHOW = 8;
// When the rail sits above the list (narrow screens), keep the changes panel short.
const showN = () => (window.matchMedia?.("(max-width: 1100px)").matches ? 4 : SHOW);

const ACTIONS = {
  done: { label: "Done", title: "Mark the next step done", run: (a) => actions.markDone(a) },
  snooze: { label: "Snooze 3d", title: "Push the date out 3 days", run: (a) => actions.snooze(a, 3) },
  followedUp: { label: "Followed up", title: "Log a follow-up and check again in a week", run: (a) => actions.followedUp(a) },
  ghosted: { label: "Ghosted", title: "Close as Ghosted", run: (a) => actions.ghosted(a) },
  open: { label: "Open", title: "Open details", run: (a) => openDrawer(a.key) },
};

export function init(el) {
  root = el;
  firstVisit = !lastSeenAt(); // read before the first load saves a baseline
  root.addEventListener("click", onClick);
  on("data", render);
  on("seen", () => { firstVisit = false; showAll = false; render(); });
  on("drawer", markOpen);
}

/** "just now", "12m ago", "3h ago", "yesterday", or "Nov 15". */
function since(isoTs) {
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 6e4);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** For the empty state: "2:14 PM" today, "yesterday", or "Nov 15". */
function sinceClock(isoTs) {
  const d = new Date(isoTs || "");
  if (Number.isNaN(d.getTime())) return "your last look";
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return since(isoTs);
}

function render() {
  if (!root || !state.M) return;
  const ae = document.activeElement;
  const f = root.contains(ae) ? ae.dataset.f : null;
  const scroll = root.scrollTop;
  // Changes sit above Coming up: "what happened" is the second thing he reads.
  root.innerHTML = today(state.M) + changes(state.M) + upcoming(state.M);
  root.scrollTop = scroll;
  if (f) root.querySelector(`[data-f="${CSS.escape(f)}"]`)?.focus({ preventScroll: true });
  markOpen();
}

const coBtn = (a, f) => `<button type="button" class="rail-co" data-open="${a.key}" data-f="${esc(f)}">${esc(a.company)}</button>`;

function today(M) {
  const items = M.today;
  const body = items.length
    ? `<ul class="today">${items.map((it) => {
        const app = it.app;
        const who = app ? coBtn(app, `co:${it.key}`) : ""; // app-less items: the tag already says Inbox/Gmail
        const dis = busy.has(it.key) ? " disabled" : "";
        const btns = app && it.actions.length
          ? `<div class="today-acts">${it.actions.map((n) => ACTIONS[n] ? `<button type="button" class="btn sm${n === "open" ? " ghost" : ""}" data-act="${n}" data-item="${esc(it.key)}" data-f="act:${esc(it.key)}:${n}" title="${esc(ACTIONS[n].title)}"${dis}>${ACTIONS[n].label}</button>` : "").join("")}</div>`
          : "";
        return `<li class="today-i tone-${it.tone}${busy.has(it.key) ? " busy" : ""}" data-app="${app ? app.key : ""}">
          <div class="today-top"><span class="tag ${it.tone}">${esc(it.label)}</span>${who}</div>
          ${it.text ? `<p class="today-t">${esc(it.text)}</p>` : ""}
          ${it.sub ? `<p class="today-sub">${esc(it.sub)}</p>` : ""}
          ${btns}</li>`;
      }).join("")}</ul>`
    : `<p class="rail-empty">Nothing needs you today.</p>`;
  return `<section class="panel rail-panel" aria-labelledby="rail-today"><header class="rail-h"><h2 id="rail-today">Today</h2>${items.length ? `<span class="count tnum">${items.length}</span>` : ""}</header>${body}</section>`;
}

function upcoming(M) {
  if (!M.upcoming.length) return "";
  return `<section class="panel rail-panel" aria-labelledby="rail-up"><header class="rail-h"><h2 id="rail-up">Coming up</h2><span class="count tnum">${M.upcoming.length}</span></header>
    <ul class="up">${M.upcoming.map((a) => `<li class="up-i" data-app="${a.key}">
      <span class="up-d tnum" title="${esc(fmt(a.nextDate))}">${esc(rel(a.nextDate))}</span>
      ${coBtn(a, `up:${a.key}`)}
      <span class="up-t ellipsis" title="${esc(a.next)}">${esc(a.next.replace(/\s*\b(by|on)?\s*\d{4}-\d{2}-\d{2}/, "").trim() || a.next)}</span></li>`).join("")}</ul></section>`;
}

function changes(M) {
  const seenAt = lastSeenAt();
  const when = seenAt ? since(seenAt) : "";
  const list = M.changes;
  const head = `<header class="rail-h"><h2 id="rail-ch">Since you last looked</h2>${list.length ? `<span class="count tnum">${list.length}</span>` : ""}
    <span class="spacer"></span>${list.length ? `<button type="button" class="btn sm ghost" data-seen data-f="seen">Mark all seen</button>` : ""}</header>
    ${when && list.length ? `<p class="rail-when">Last looked ${esc(when)}</p>` : ""}`;

  let body;
  if (!list.length) {
    body = firstVisit
      ? `<p class="rail-empty">This is where changes show up that Claude or the Gmail sync make while you're away. Nothing yet.</p>`
      : `<p class="rail-empty">Nothing new since ${esc(sinceClock(seenAt))}.</p>`;
  } else {
    const shown = showAll ? list : list.slice(0, showN());
    // Group consecutive changes to the same application under one company line.
    const groups = [];
    for (const c of shown) {
      const g = groups[groups.length - 1];
      if (g && g.appId === c.appId) g.items.push(c); else groups.push({ appId: c.appId, company: c.company, role: c.role, items: [c] });
    }
    body = `<ul class="changes">${groups.map((g) => {
      const app = M.byId[g.appId];
      const who = app ? coBtn(app, `ch:${g.appId}:${g.items[0].id}`) : `<span class="rail-co gone">${esc(g.company)}</span>`;
      return `<li class="ch-g" data-app="${esc(g.appId)}"><div class="ch-who">${who}${g.role ? `<span class="ch-role ellipsis">${esc(g.role)}</span>` : ""}</div>
        <ul class="ch-items">${g.items.map((c) => `<li class="ch-i ch-${c.type}">
          <span class="ch-t">${esc(c.text)}</span>
          <span class="ch-meta">${c.source && c.source !== "dashboard" ? `<span class="ch-src">via ${esc(c.source)}</span>` : ""}${c.date ? `<span class="tnum" title="${esc(fmt(c.date))}">${esc(rel(c.date))}</span>` : ""}</span>
        </li>`).join("")}</ul></li>`;
    }).join("")}</ul>`;
    if (list.length > showN()) body += `<button type="button" class="linkbtn rail-more" data-more data-f="more">${showAll ? "Show fewer" : `Show all ${list.length}`}</button>`;
  }
  return `<section class="panel rail-panel rail-changes${list.length ? " has" : ""}" aria-labelledby="rail-ch">${head}${body}</section>`;
}

function markOpen() {
  for (const el of root?.querySelectorAll("[data-app]") || []) el.classList.toggle("is-open", !!el.dataset.app && el.dataset.app === state.drawerId);
}

async function onClick(e) {
  const t = e.target;
  const o = t.closest("[data-open]");
  if (o) { openDrawer(o.dataset.open); return; }
  if (t.closest("[data-seen]")) { actions.markAllSeen(); toast("All caught up"); return; }
  if (t.closest("[data-more]")) { showAll = !showAll; render(); return; }
  const b = t.closest("[data-act]");
  if (!b || b.disabled) return;
  const item = state.M.today.find((it) => it.key === b.dataset.item);
  const act = ACTIONS[b.dataset.act];
  if (!item?.app || !act) return;
  if (b.dataset.act === "open") { act.run(item.app); return; }
  busy.add(item.key);
  render();
  try { await act.run(item.app); }
  catch (err) { toast(err.message || "Couldn't save"); }
  finally { busy.delete(item.key); render(); }
}
