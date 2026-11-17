// Every write the UI makes. Each one calls the API, reloads (forced, so it
// applies even while a view holds refresh), and acknowledges the change in the
// since-last-look snapshot so your own edits don't show up there.
import { api } from "./api.js";
import { state, load, emit, rederive } from "./state.js";
import { acknowledge, markSeen } from "./changes.js";
import { iso, addDays, today, withDate } from "./format.js";
import { toast } from "../ui/toast.js";

async function after(appId, message, undo) {
  await load({ force: true });
  if (appId != null) { acknowledge(state.D, appId); rederive(); }
  if (message) toast(message, undo ? { action: "Undo", onAction: undo } : undefined);
}

/** PATCH an application. body: any of status, date, next_step, lesson, note, company, role, comp, source, posting_url, verdict, found, folder. */
export async function patch(appId, body, message = "Saved") {
  await api("PATCH", `/api/applications/${appId}`, body);
  await after(appId, message);
}

/** Create an application. body: company (required), role, status, date, next_step, comp, source, posting_url... Returns the new id. */
export async function create(body, note) {
  const created = await api("POST", "/api/applications", { found: iso(today()), ...body });
  if (note) await api("POST", `/api/applications/${created.id}/events`, { text: note, kind: "note", date: body.date });
  await after(created.id, `Added ${created.company}`);
  return String(created.id);
}

/** Move to a stage or outcome. Outcomes take an optional lesson; date defaults to today. */
export async function setStatus(app, status, { date, lesson, note } = {}) {
  const body = { status };
  if (date) body.date = date;
  if (lesson) body.lesson = lesson;
  if (note) body.note = note;
  await patch(app.key, body, `${app.company} → ${status}`);
}

export async function addNote(appId, text, date) {
  await api("POST", `/api/applications/${appId}/events`, { text, kind: "note", date: date || undefined });
  await after(appId, "Note added");
}

/** Delete a note, with an Undo that re-creates it (same text and date). */
export async function deleteNote(appId, ev) {
  await api("DELETE", `/api/applications/${appId}/events/${ev.id}`);
  await after(appId, "Note deleted", async () => {
    await api("POST", `/api/applications/${appId}/events`, { text: ev.text, kind: "note", date: ev.date });
    await after(appId, "Note restored");
  });
}

// ---- Today quick actions ----
export const markDone = (app) =>
  patch(app.key, { next_step: "", note: `Done: ${app.next}` }, "Marked done");
export const snooze = (app, days = 3) =>
  patch(app.key, { next_step: withDate(app.next, iso(addDays(days))) }, `Snoozed ${days} days`);
export const followedUp = (app) =>
  patch(app.key, { note: "Followed up", next_step: `Follow up again by ${iso(addDays(7))}` }, "Logged follow-up");
export const ghosted = (app) => setStatus(app, "Ghosted", { lesson: app.lesson || "No reply after applying." });

export function markAllSeen() { markSeen(state.D); rederive(); emit("seen"); }
