// "Since you last looked": what changed in the tracker that you didn't do yourself.
//
// The snapshot (localStorage "jt-seen") records, per application, the fields that
// matter plus the highest event id seen. It only moves when you say so
// (markSeen) or right after your own edit (acknowledge). Never on load or
// render: polling every 30s would otherwise empty the feed by itself.
//
// Two sources of change:
//  1. Timeline events with id > snapshot.maxEvent whose source isn't "dashboard"
//     (those are Claude's /status and /inbox writes).
//  2. Field diffs (stage, next step, lesson, company, role, comp), because
//     PATCHing a field without a status change or note creates no event.
// Your own writes from this page have source "dashboard" and imports "import" (both filtered out), and
// acknowledge() refreshes that application's field snapshot after you save.
import { store } from "./store.js";

const KEY = "seen";
const FIELDS = [["stage", "Status"], ["next", "Next step"], ["lesson", "Lesson"], ["company", "Company"], ["role", "Role"], ["comp", "Comp"]];

const appsOf = (D) => [...D.active, ...D.closed, ...D.history];
const stageOf = (a) => (a.kind === "history" ? "History" : a.stage);
const fieldsOf = (a) => ({ stage: stageOf(a), next: a.next || "", lesson: a.lesson || "", company: a.company || "", role: a.role || "", comp: a.comp || "" });
const maxEventOf = (D) => Math.max(0, ...appsOf(D).flatMap((a) => a.timeline.map((t) => t.id || 0)));

function snapshot(D) {
  return { at: new Date().toISOString(), maxEvent: maxEventOf(D), apps: Object.fromEntries(appsOf(D).map((a) => [String(a.id), fieldsOf(a)])) };
}

export const lastSeenAt = () => store.get(KEY, null)?.at || null;

/**
 * Returns { changes, changedIds }.
 * Change = { id, appId, company, role, type: "new"|"status"|"note"|"event"|"field", text, date, source, order }
 * Sorted newest first. On the very first visit (no snapshot) it saves a baseline and returns nothing.
 */
export function computeChanges(D) {
  const snap = store.get(KEY, null);
  // No snapshot yet (first visit), or the data was replaced wholesale by an import
  // (ids start over, so the newest event id goes backwards): save a fresh baseline.
  if (!snap || !snap.apps || maxEventOf(D) < snap.maxEvent) { store.set(KEY, snapshot(D)); return { changes: [], changedIds: new Set() }; }
  const out = [];
  for (const a of appsOf(D)) {
    const id = String(a.id), was = snap.apps[id], now = fieldsOf(a);
    const base = { appId: id, company: a.company, role: a.role };
    if (!was) {
      out.push({ ...base, id: `n${id}`, type: "new", text: `Added as ${now.stage}`, date: a.found || "", source: "", order: Infinity });
    }
    // "dashboard" = your own edits; "import" = a bulk restore (every event gets a new id), not news.
    const evs = a.timeline.filter((t) => (t.id || 0) > snap.maxEvent && t.source !== "dashboard" && t.source !== "import");
    for (const t of evs) {
      if (!was && /^Added as /.test(t.text)) continue; // already covered by the "new" item
      out.push({ ...base, id: `e${t.id}`, type: t.kind === "note" ? "note" : t.kind === "status" ? "status" : "event", text: t.text, date: t.date, source: t.source || "", order: t.id });
    }
    if (!was) continue;
    const statusEvent = evs.some((t) => t.kind === "status");
    for (const [f, label] of FIELDS) {
      if (was[f] === now[f]) continue;
      if (f === "stage" && statusEvent) continue;
      const text = f === "stage" ? `Status: ${was.stage} → ${now.stage}` : now[f] ? `${label}: ${now[f]}` : `${label} cleared`;
      out.push({ ...base, id: `f${id}${f}`, type: "field", text, date: "", source: "", order: snap.maxEvent + 0.5 });
    }
  }
  out.sort((x, y) => (y.date || "9999").localeCompare(x.date || "9999") || y.order - x.order);
  return { changes: out, changedIds: new Set(out.map((c) => c.appId)) };
}

/** Everything currently in the tracker counts as seen. */
export function markSeen(D) { store.set(KEY, snapshot(D)); }

/** After your own edit: refresh one application's field snapshot so it doesn't show as a change. */
export function acknowledge(D, appId) {
  const snap = store.get(KEY, null);
  if (!snap || !snap.apps) return;
  const a = appsOf(D).find((x) => String(x.id) === String(appId));
  if (a) snap.apps[String(a.id)] = fieldsOf(a); else delete snap.apps[String(appId)];
  store.set(KEY, snap);
}
