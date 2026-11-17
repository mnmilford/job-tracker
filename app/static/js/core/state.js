// App state, the derived model, the event bus, and loading/polling.
// Views never fetch on their own: they read state.M and listen for events.
import { api, SignedOut } from "./api.js";
import { store } from "./store.js";
import { daysSince, fmt, rel, plural } from "./format.js";
import { computeChanges } from "./changes.js";

export const FOLLOW_UP_DAYS = 10;     // Applied with no movement this long -> nudge
export const INBOX_STALE_DAYS = 3;    // Gmail sync older than this -> nudge
export const SOON_DAYS = 2;           // next steps due within this many days go in Today
export const UPCOMING_DAYS = 14;      // ...and within this many in Coming up
export const POLL_MS = 30000;

const VIEW_DEFAULTS = {
  q: "",                 // search text (company, role, status, next, lesson, source, timeline)
  stage: "All",          // active stage filter
  archiveOpen: false,    // Archive section expanded
  archiveOutcome: "All", // "All" | an outcome | "History"
  archiveWhen: "all",    // "all" | "30" | "90" | "year"
  collapsed: {},         // { [stage]: true } collapsed stage groups
};

export const state = {
  D: null,                     // raw /api/dashboard payload
  M: null,                     // derived model, see derive()
  view: { ...VIEW_DEFAULTS, ...store.get("view2", {}) },
  selectedId: null,            // keyboard/list selection, String(id)
  drawerId: null,              // application open in the drawer, String(id) or null
  live: { ok: true, label: "Live" },
};

// ---- event bus ----
// "data"   model rebuilt (new payload, or the day rolled over)
// "view"   state.view changed (filters, search, archive)
// "select" state.selectedId changed
// "drawer" state.drawerId changed
// "live"   state.live changed
// "seen"   the since-last-look snapshot changed (mark seen / acknowledge)
const listeners = {};
export const on = (evt, fn) => { (listeners[evt] ||= []).push(fn); };
export const emit = (evt, payload) => { for (const fn of listeners[evt] || []) { try { fn(payload); } catch (e) { console.error(evt, e); } } };

export function setView(patch) {
  Object.assign(state.view, patch);
  store.set("view2", state.view);
  emit("view", state.view);
}
export function select(id) {
  state.selectedId = id == null ? null : String(id);
  emit("select", state.selectedId);
}
export function openDrawer(id) {
  state.drawerId = id == null ? null : String(id);
  if (id != null) state.selectedId = String(id);
  emit("drawer", state.drawerId);
}

// ---- holds: pause live refresh while the user is mid-edit ----
// A view with unsaved input calls hold("drawer"); polling then fetches but
// doesn't re-render until release("drawer"). Writes always apply.
const holds = new Set();
let pending = null;
export const hold = (key) => holds.add(key);
export const release = (key) => {
  holds.delete(key);
  if (!holds.size && pending) { const d = pending; pending = null; apply(d); }
};
export const held = () => holds.size > 0;

// ---- model ----
const matches = (a, q) => !q || [a.company, a.role, a.status, a.next, a.lesson, a.source, a.comp, ...a.timeline.map((t) => t.text)]
  .join(" ").toLowerCase().includes(q);
export const matchQuery = (a, q = state.view.q) => matches(a, String(q || "").trim().toLowerCase());

/**
 * Model shape (state.M):
 *  stages, outcomes            from the server, in order
 *  active, closed, history     enriched application objects (see enrich)
 *  all, byId                   every application; byId keyed by String(id)
 *  byStage                     { [stage]: active apps in that stage }
 *  today                       Today items, most urgent first (see TodayItem below)
 *  upcoming                    next steps due in SOON_DAYS+1 .. UPCOMING_DAYS days
 *  changes, changedIds         since-last-look feed (see changes.js) and the Set of app ids in it
 *  inbox                       { checked, age, stale, review: [text] }
 *  demo, owner, docsViewer, repoUrl, branch
 *
 * Enriched application = the server object plus:
 *  key: String(id); idle: days since lastActivity; nextIn: days until nextDate (negative = overdue)
 *  overdue, dueSoon, quiet: booleans; isOutcome: closed with an outcome; stageColor: CSS var name
 *
 * TodayItem = { key, app|null, tone: "critical"|"warn"|"accent", label, text, sub, actions: [action names] }
 *  action names: "done", "snooze", "followedUp", "ghosted", "open"
 */
export function derive(D) {
  const stageVar = Object.fromEntries(D.stages.map((s, i) => [s, `var(--s${i + 1})`]));
  const colorOf = (stage) => stageVar[stage] || (stage === "Hired" ? "var(--good)" : "var(--muted)");
  const enrich = (a) => {
    const idle = daysSince(a.lastActivity);
    const nextIn = a.nextDate ? -daysSince(a.nextDate) : null;
    return {
      ...a, key: String(a.id), idle, nextIn,
      overdue: a.kind === "active" && nextIn !== null && nextIn < 0,
      dueSoon: a.kind === "active" && nextIn !== null && nextIn >= 0 && nextIn <= SOON_DAYS,
      quiet: a.kind === "active" && a.stage === "Applied" && idle !== null && idle >= FOLLOW_UP_DAYS && !(nextIn !== null && nextIn >= 0),
      isOutcome: a.kind === "closed",
      stageColor: a.kind === "history" ? "var(--muted)" : colorOf(a.stage),
    };
  };
  const active = D.active.map(enrich), closed = D.closed.map(enrich), history = D.history.map(enrich);
  const all = [...active, ...closed, ...history];
  const byId = Object.fromEntries(all.map((a) => [a.key, a]));
  const byStage = Object.fromEntries(D.stages.map((s) => [s, active.filter((a) => a.stage === s)]));

  const inboxAge = D.inboxChecked ? daysSince(D.inboxChecked) : null;
  const inbox = { checked: D.inboxChecked, age: inboxAge, stale: inboxAge === null || inboxAge > INBOX_STALE_DAYS, review: D.inboxReview || [] };

  const today = [];
  for (const a of active) {
    if (a.overdue) today.push({ key: `o${a.key}`, app: a, rank: 0, tone: "critical", label: "Overdue",
      text: a.next, sub: `Was due ${fmt(a.nextDate)} (${plural(-a.nextIn, "day")} ago)`, actions: ["done", "snooze", "open"] });
    else if (a.dueSoon) today.push({ key: `s${a.key}`, app: a, rank: 2, tone: "accent", label: rel(a.nextDate),
      text: a.next, sub: "", actions: ["done", "open"] });
    if (a.quiet) today.push({ key: `q${a.key}`, app: a, rank: 1, tone: "warn", label: `Quiet ${a.idle}d`,
      text: "No movement since applying.", sub: "Follow up, or mark it Ghosted.", actions: ["followedUp", "ghosted", "open"] });
  }
  inbox.review.forEach((text, i) => today.push({ key: `r${i}`, app: null, rank: 1, tone: "warn", label: "Inbox",
    text, sub: "Needs your call. Ask Claude to settle it in /inbox.", actions: [] }));
  if (inbox.stale) today.push({ key: "stale", app: null, rank: 3, tone: "warn", label: "Gmail",
    text: inboxAge === null ? "Gmail has never been checked." : `Last Gmail check was ${plural(inboxAge, "day")} ago.`,
    sub: "Statuses may be behind. Ask Claude to run /inbox.", actions: [] });
  today.sort((x, y) => x.rank - y.rank || (x.app?.nextIn ?? 99) - (y.app?.nextIn ?? 99));

  const upcoming = active.filter((a) => a.nextIn !== null && a.nextIn > SOON_DAYS && a.nextIn <= UPCOMING_DAYS)
    .sort((x, y) => x.nextIn - y.nextIn);

  const M = {
    stages: D.stages, outcomes: D.outcomes, active, closed, history, all, byId, byStage,
    today, upcoming, inbox, colorOf,
    demo: D.demo, owner: D.owner, docsViewer: D.docsViewer, repoUrl: D.repoUrl, branch: D.branch,
  };
  const { changes, changedIds } = computeChanges(D);
  M.changes = changes; M.changedIds = changedIds;
  return M;
}

function apply(D) {
  state.D = D;
  state.M = derive(D);
  if (state.drawerId && !state.M.byId[state.drawerId]) openDrawer(null);
  emit("data", state.M);
}
/** Rebuild the model from the current payload (after a since-last-look change, or at midnight). */
export function rederive() { if (state.D) apply(state.D); }

/** Fetch the dashboard. force: apply even when held or unchanged (use after your own writes). */
export async function load({ force = false } = {}) {
  const D = await api("GET", "/api/dashboard");
  if (!force && state.D && D.version === state.D.version) return false;
  if (!force && held()) { pending = D; return false; }
  pending = null;
  apply(D);
  return true;
}

function setLive(ok, label) {
  state.live = { ok, label: label || (ok ? "Live" : "Offline") };
  emit("live", state.live);
}
async function poll() {
  if (document.hidden) return;
  try { await load(); setLive(true); }
  catch (err) { setLive(false, err instanceof SignedOut ? "Signed out" : ""); }
}
let lastDay = new Date().toDateString();
export function startPolling() {
  setInterval(() => {
    poll();
    // Relative dates ("Tomorrow", "Overdue") change at midnight even if the data doesn't.
    const d = new Date().toDateString();
    if (d !== lastDay) { lastDay = d; rederive(); }
  }, POLL_MS);
  document.addEventListener("visibilitychange", poll);
}
