// Application drawer: a right-side slide-over with everything about one
// application. Opens on state.drawerId ("drawer" event). The DOM is built once
// per application and patched on "data", so a background refresh (or a write
// made elsewhere) never wipes what you're typing: each field keeps a baseline
// (data-base) and only clean fields take the fresh value.
import { state, on, openDrawer, hold, release } from "../core/state.js";
import { esc, fmt, rel, iso, today, withDate, dateIn, DATE_RE } from "../core/format.js";
import * as actions from "../core/actions.js";
import * as statusmenu from "./statusmenu.js";
import * as pdf from "./pdf.js";
import { toast } from "./toast.js";

const svg = (d) => `<svg class="ico" aria-hidden="true" viewBox="0 0 16 16">${d}</svg>`;
const ICO = {
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  link: svg('<path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5"/>'),
  caret: '<svg class="ico caret" aria-hidden="true" viewBox="0 0 16 16"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>',
  eye: svg('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>'),
  down: svg('<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
};

const FIT_TONE = { match: "good", stretch: "warn", miss: "critical" };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

let el, scrim;
let curId = null;        // application shown, String(id) or null
let opener = null;       // element focused before the drawer opened
let saving = false;
let filesOpen = false;   // "All files" disclosure, kept across re-renders
let wasDirty = false;
const rendered = new WeakMap(); // section element -> last HTML put in it

const $ = (sel) => el.querySelector(sel);
const current = () => (curId && state.M ? state.M.byId[curId] : null);
const fields = () => [...el.querySelectorAll("[data-api]")];
const fieldDirty = (f) => f.value !== f.dataset.base;
const formDirty = () => !!curId && fields().some(fieldDirty);
const noteDirty = () => !!curId && !!$(".dr-compose textarea")?.value.trim();
const isDirty = () => formDirty() || noteDirty();

// What the control would show for a value, so trimming or a month-only date
// never counts as an edit.
function norm(input, v) {
  if (input.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : "";
  const c = input.cloneNode(false);
  c.value = v ?? "";
  return c.value;
}
const fitSize = (t) => {
  if (CSS.supports?.("field-sizing", "content")) return;
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight + 2}px`;
};
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

// ---- public API ----
export function init(root) {
  el = root;
  el.hidden = false;
  el.inert = true;
  el.tabIndex = -1;
  el.setAttribute("aria-hidden", "true");
  scrim = document.createElement("div");
  scrim.className = "drawer-scrim";
  scrim.setAttribute("aria-hidden", "true");
  scrim.addEventListener("click", () => close());
  el.before(scrim);
  // Delegated listeners: the drawer's content is rebuilt per application.
  el.addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "dr-form") save();
    else if (e.target.matches(".dr-compose")) addNote();
  });
  el.addEventListener("input", (e) => {
    const t = e.target;
    if (t.name === "next") { dateStash = null; syncNextDate(); }
    if (t.name === "nextDate") onNextDate(t);
    if (t.tagName === "TEXTAREA") fitSize(t);
    if (t.closest(".dr-compose")) { $(".dr-compose").classList.toggle("has-text", !!t.value.trim()); $(".dr-compose .form-msg").textContent = ""; }
    else if (t.matches("[data-api], [name=nextDate]")) $(".dr-foot .form-msg").textContent = "";
    updateDirty();
  });
  el.addEventListener("keydown", (e) => {
    const t = e.target;
    const inForm = t.matches?.("[data-api], [name=nextDate]");
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      if (inForm) { e.preventDefault(); save(); }
      else if (t.closest?.(".dr-compose")) { e.preventDefault(); addNote(); }
      return;
    }
    if (e.key === "Enter" && inForm && t.tagName === "INPUT") { e.preventDefault(); if (formDirty()) save(); }
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button, a");
    if (!b || !el.contains(b)) return;
    if (b.matches(".dr-close")) { close(); return; }
    if (b.dataset.act === "discard") { discard(); return; }
    const a = current();
    if (!a) return;
    if (b.matches(".dr-status .badge")) { statusmenu.open(b, a); return; }
    if (b.dataset.pdf) { pdf.open(a.key, b.dataset.pdf); return; }
    if (b.dataset.del) {
      const ev = a.timeline.find((t) => String(t.id) === b.dataset.del);
      if (ev) actions.deleteNote(a.key, ev).catch((err) => toast(err.message));
    }
  });
  on("drawer", onDrawer);
  on("data", onData);
  // Capture phase: runs before other Esc handlers, so an open popover or
  // dialog is still in the DOM and we can leave the Esc to it.
  document.addEventListener("keydown", onKey, true);
}
export const isOpen = () => curId !== null;
export function close() { if (isOpen()) openDrawer(null); }
export const badgeEl = () => (isOpen() ? $(".dr-status .badge") : null);
export function focusField(name) {
  if (!isOpen()) return;
  const a = current();
  const t = name === "note" ? $(".dr-compose textarea")
    : name === "next" ? $(a?.kind === "active" ? '[name="next"]' : '[name="lesson"]') : $(`[name="${name}"]`);
  if (!t) return;
  t.focus();
  t.scrollIntoView({ block: "nearest" });
  if (t.setSelectionRange && t.type !== "date") t.setSelectionRange(t.value.length, t.value.length);
}

// ---- open / close ----
function onDrawer(id) {
  if (id === curId) return;
  if (id == null) {
    if (curId && !(state.M && state.M.byId[curId])) return shut(); // it vanished
    if (isDirty()) return refuse(() => shut());
    return shut();
  }
  if (curId && isDirty()) {
    const target = id;
    return refuse(() => openDrawer(target));
  }
  show(id);
}

// Leaving with unsaved input: stay put and offer to throw it away.
function refuse(thenDo) {
  const keep = curId;
  queueMicrotask(() => openDrawer(keep));
  const foot = $(".dr-foot");
  foot?.classList.remove("pulse"); void foot?.offsetWidth; foot?.classList.add("pulse");
  toast("You have unsaved changes here.", {
    action: "Discard",
    onAction: () => { discard(true); thenDo(); },
  });
}

function show(id) {
  const a = state.M?.byId[id];
  if (!a) { queueMicrotask(() => openDrawer(null)); return; }
  const opening = curId === null;
  if (opening) opener = document.activeElement === document.body ? null : document.activeElement;
  curId = id;
  build(a);
  el.inert = false;
  el.removeAttribute("aria-hidden");
  el.classList.add("open");
  scrim.classList.add("open");
  document.documentElement.classList.add("drawer-open");
  if (opening) el.focus({ preventScroll: true });
  else $(".dr-body").scrollTop = 0;
}

function shut() {
  const was = curId;
  curId = null;
  saving = false;
  syncHold(false);
  const inside = el.contains(document.activeElement) || document.activeElement === document.body;
  el.classList.remove("open");
  scrim.classList.remove("open");
  el.inert = true;
  el.setAttribute("aria-hidden", "true");
  document.documentElement.classList.remove("drawer-open");
  if (inside) {
    // Prefer the row of the application shown last (j/k may have moved on since
    // the drawer opened), then whatever opened the drawer.
    let back = null;
    if (was) {
      const row = document.querySelector(`#main [data-key="${CSS.escape(was)}"]`);
      if (row && row.tabIndex >= 0) back = row;
    }
    if (!back && opener && opener.isConnected) back = opener;
    (back || document.getElementById("main"))?.focus({ preventScroll: !back });
  }
  opener = null;
}

function syncHold(dirty) {
  if (dirty === wasDirty) return;
  wasDirty = dirty;
  if (dirty) hold("drawer"); else release("drawer");
}

function onKey(e) {
  if (e.key !== "Escape" || !isOpen() || e.defaultPrevented) return;
  if (document.querySelector("dialog[open], .pop") || statusmenu.isOpen()) return;
  const t = e.target;
  if (t instanceof Element && !el.contains(t) && t.matches("input, textarea, select, [contenteditable]")) return;
  e.preventDefault();
  close();
}

function onData() {
  if (!curId) return;
  const a = current();
  if (!a) return shut();
  fill(a);
}

// ---- build once per application ----
function build(a) {
  filesOpen = false;
  dateStash = null;
  el.setAttribute("aria-label", `Application details: ${a.company}`);
  el.innerHTML = `
    <header class="dr-head">
      <div class="dr-titles">
        <input class="dr-company" name="company" data-api="company" form="dr-form" aria-label="Company" autocomplete="off" spellcheck="false" title="Click to edit">
        <input class="dr-role" name="role" data-api="role" form="dr-form" aria-label="Role" placeholder="Add a role" autocomplete="off" title="Click to edit">
      </div>
      <div class="dr-head-actions">
        <a class="btn icon ghost sm dr-link" target="_blank" rel="noopener" aria-label="Open the posting" title="Open the posting" hidden>${ICO.link}</a>
        <button class="btn icon ghost sm dr-close" type="button" aria-label="Close details" title="Close (Esc)">${ICO.close}</button>
      </div>
    </header>
    <div class="dr-body">
      <section class="dr-status" aria-label="Status"></section>

      <form class="dr-form" id="dr-form" novalidate aria-label="Details">
        <div class="dr-row" data-row="next">
          <label for="dr-next">Next step</label>
          <div class="dr-val dr-next">
            <input class="input dr-in" id="dr-next" name="next" data-api="next_step" placeholder="Add a next step" autocomplete="off">
            <div class="dr-next-date">
              <input class="input dr-in dr-date" type="date" name="nextDate" aria-label="Next step date" title="Due date. Clearing it removes the date from the text.">
              <span class="dr-due"></span>
            </div>
          </div>
        </div>
        <div class="dr-row" data-row="lesson">
          <label for="dr-lesson">Lesson</label>
          <div class="dr-val"><textarea class="textarea dr-in" id="dr-lesson" name="lesson" data-api="lesson" rows="1" placeholder="Why it closed, what you learned"></textarea></div>
        </div>
        <div class="dr-row">
          <label for="dr-comp">Comp</label>
          <div class="dr-val"><input class="input dr-in" id="dr-comp" name="comp" data-api="comp" placeholder="Add comp" autocomplete="off"></div>
        </div>
        <div class="dr-row">
          <label for="dr-source">Source</label>
          <div class="dr-val"><input class="input dr-in" id="dr-source" name="source" data-api="source" placeholder="Where you found it" autocomplete="off"></div>
        </div>
        <div class="dr-row">
          <label for="dr-url">Posting</label>
          <div class="dr-val"><input class="input dr-in" type="url" id="dr-url" name="url" data-api="posting_url" placeholder="Paste the posting URL" autocomplete="off" spellcheck="false"></div>
        </div>
        <div class="dr-row">
          <label for="dr-verdict">Fit</label>
          <div class="dr-val"><textarea class="textarea dr-in" id="dr-verdict" name="verdict" data-api="verdict" rows="1" placeholder="Match, stretch or miss, and why"></textarea></div>
        </div>
        <div class="dr-row">
          <label for="dr-found">Found</label>
          <div class="dr-val dr-found">
            <input class="input dr-in dr-date" type="date" id="dr-found" name="found" data-api="found">
            <span class="muted dr-found-raw"></span>
          </div>
        </div>
      </form>

      <section class="dr-sec dr-docs" aria-labelledby="dr-docs-h">
        <h3 class="eyebrow" id="dr-docs-h">Documents</h3>
        <div class="dr-docs-in"></div>
      </section>

      <section class="dr-sec dr-tl" aria-labelledby="dr-tl-h">
        <h3 class="eyebrow" id="dr-tl-h">Timeline</h3>
        <form class="dr-compose" novalidate>
          <textarea class="textarea" name="note" rows="1" placeholder="Add a note…" aria-label="New note"></textarea>
          <div class="dr-compose-row">
            <input class="input dr-date" type="date" name="noteDate" aria-label="Note date">
            <span class="form-msg" role="alert"></span>
            <span class="dr-hint muted"><kbd class="kbd">${isMac ? "⌘" : "Ctrl"}</kbd><kbd class="kbd">↵</kbd></span>
            <button class="btn sm primary" type="submit">Add note</button>
          </div>
        </form>
        <ol class="dr-events"></ol>
      </section>
    </div>
    <div class="dr-foot" hidden>
      <span class="form-msg" role="alert"></span>
      <span class="dr-hint muted"><kbd class="kbd">${isMac ? "⌘" : "Ctrl"}</kbd><kbd class="kbd">↵</kbd> to save</span>
      <button class="btn sm ghost" type="button" data-act="discard">Discard</button>
      <button class="btn sm primary" type="submit" form="dr-form">Save changes</button>
    </div>`;

  const compose = $(".dr-compose");
  compose.noteDate.value = iso(today());

  fill(a);
}

// ---- fill: safe to run on every "data" ----
function setField(input, v) {
  const nv = norm(input, v);
  const keep = input.dataset.base !== undefined && fieldDirty(input);
  if (!keep && input.value !== nv) input.value = nv;
  input.dataset.base = nv;
  if (input.tagName === "TEXTAREA") fitSize(input);
}

function fill(a) {
  const M = state.M;
  const vals = { company: a.company, role: a.role, next: a.next, lesson: a.lesson, comp: a.comp, source: a.source, url: a.url, verdict: a.verdict, found: a.found };
  for (const f of fields()) setField(f, vals[f.name]);
  syncNextDate();

  const active = a.kind === "active";
  $('[data-row="next"]').hidden = !active;
  $('[data-row="lesson"]').hidden = active;

  const link = $(".dr-link"), url = safeUrl(a.url);
  link.hidden = !url;
  if (url) link.href = url; else link.removeAttribute("href");

  const raw = $(".dr-found-raw");
  raw.textContent = a.found && !/^\d{4}-\d{2}-\d{2}$/.test(a.found) ? `Saved as ${fmt(a.found)}` : "";

  // Only touch what changed, so focus and an open status menu keep their anchor.
  const put = (sel, html) => { const n = $(sel); if (rendered.get(n) === html) return false; n.innerHTML = html; rendered.set(n, html); return true; };
  put(".dr-status", statusHtml(a));
  if (put(".dr-docs-in", docsHtml(a, M))) {
    const files = $(".dr-files");
    if (files) files.addEventListener("toggle", () => { filesOpen = files.open; });
  }
  put(".dr-events", eventsHtml(a));
  el.setAttribute("aria-label", `Application details: ${a.company}`);
  updateDirty();
}

// The date input passes through "" while a segment is retyped. Keep the text
// as it was (with any time after the date) so a retyped date restores it.
let dateStash = null;
function onNextDate(d) {
  const n = $('[name="next"]');
  if (!d.value) {
    dateStash = { before: n.value, after: withDate(n.value, "") };
    n.value = dateStash.after;
  } else if (dateStash && n.value === dateStash.after) {
    n.value = withDate(dateStash.before, d.value);
    dateStash = null;
  } else {
    n.value = withDate(n.value, d.value);
    dateStash = null;
  }
  renderDue();
}

function syncNextDate() {
  const n = $('[name="next"]'), d = $('[name="nextDate"]');
  d.value = norm(d, dateIn(n.value));
  renderDue();
}
function renderDue() {
  const v = $('[name="nextDate"]').value, due = $(".dr-due");
  if (!v) { due.className = "dr-due"; due.textContent = ""; return; }
  const n = Math.round((new Date(v + "T00:00") - today()) / 864e5);
  const tone = n < 0 ? "critical" : n <= 2 ? "accent" : "neutral";
  due.className = `dr-due tag ${tone}`;
  due.textContent = n < 0 ? `${-n}d overdue` : rel(v);
  due.title = fmt(v);
}

function statusHtml(a) {
  const label = a.kind === "history" ? "No outcome yet" : a.stage;
  const closedOn = a.kind === "closed" ? (a.status.match(DATE_RE) || [""])[0] : "";
  const meta = a.kind === "closed"
    ? (closedOn ? `<span title="${esc(a.status)}">Closed ${esc(fmt(closedOn))}</span>` : "")
    : a.kind === "history" ? "<span>From before the tracker</span>" : "";
  const last = a.lastActivity
    ? `<span title="Last activity ${esc(fmt(a.lastActivity))}">Last activity ${esc(rel(a.lastActivity).replace(/^(Today|Yesterday)$/, (m) => m.toLowerCase()))}</span>` : "";
  const word = (a.verdict || "").trim().match(/^[a-z]+/i)?.[0].toLowerCase();
  const fit = FIT_TONE[word]
    ? `<span class="tag ${FIT_TONE[word]}" title="${esc(a.verdict)}">Fit: ${esc(word[0].toUpperCase() + word.slice(1))}</span>` : "";
  return `<div class="dr-status-line">
      <button class="badge" type="button" style="--stage: ${a.stageColor}" aria-haspopup="menu" aria-expanded="false" title="Change status (S)"><i></i>${esc(label)}${ICO.caret}</button>
      <span class="dr-status-meta">${[meta, last].filter(Boolean).join('<span aria-hidden="true">·</span>')}</span>
      ${fit}
    </div>`;
}

// Documents, ported from the old docButtons(): for each .docx a "<Label> PDF"
// (in-app viewer when the server has the documents token, else a GitHub raw
// link) and a "<Label> (Word)" download. Resume first.
function docsHtml(a, M) {
  if (!a.folder) return '<p class="dr-none muted">No documents</p>';
  const files = a.files || [];
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  const rawLink = (f) => `${M.repoUrl}/raw/${encodeURIComponent(M.branch)}/${enc(`${a.folder}/${f}`)}`;
  const fileUrl = (f, dl) => `/api/applications/${encodeURIComponent(a.id)}/files/${encodeURIComponent(f)}${dl ? "?download=1" : ""}`;
  const blob = (f) => (M.repoUrl ? `${M.repoUrl}/blob/${encodeURIComponent(M.branch)}/${enc(`${a.folder}/${f}`)}` : "");
  let out = "";
  if (M.docsViewer || M.repoUrl) {
    const docs = files.filter((f) => /\.docx$/i.test(f));
    const label = (f) => /cover[_ -]?letter/i.test(f) ? "Cover letter" : /resume|\bcv\b/i.test(f) ? "Resume" : f.replace(/\.docx$/i, "");
    const ordered = [...docs].sort((x, y) => (label(x) === "Resume" ? -1 : label(y) === "Resume" ? 1 : 0));
    if (ordered.length) {
      out += `<ul class="dr-doclist">${ordered.map((f, i) => {
        const pdfName = f.replace(/\.docx$/i, ".pdf");
        const L = esc(label(f));
        const cls = `btn sm${i ? "" : " primary"}`;
        const pdfBtn = !files.includes(pdfName) ? ""
          : M.docsViewer
            ? `<button class="${cls}" type="button" data-pdf="${esc(pdfName)}" title="${esc(pdfName)}">${ICO.eye}${L} PDF</button>`
            : `<a class="${cls}" href="${esc(rawLink(pdfName))}" target="_blank" rel="noopener" title="${esc(pdfName)}">${ICO.eye}${L} PDF</a>`;
        const wordHref = M.docsViewer ? fileUrl(f, true) : rawLink(f);
        return `<li class="dr-doc">
          ${pdfBtn}<a class="btn sm ghost" href="${esc(wordHref)}"${M.docsViewer ? "" : ' target="_blank" rel="noopener"'} title="${esc(f)}">${ICO.down}${L} (Word)</a>
        </li>`;
      }).join("")}</ul>`;
      if (!M.docsViewer) out += '<p class="dr-note muted">Downloads from GitHub. Sign in to GitHub in this browser if a link says "Not Found".</p>';
    }
  }
  if (!files.length) return out + '<p class="dr-none muted">No files in this folder yet</p>';
  out += `<details class="dr-files"${filesOpen ? " open" : ""}>
    <summary>All files <span class="muted tnum">(${files.length})</span></summary>
    <ul>${files.map((f) => blob(f)
      ? `<li><a href="${esc(blob(f))}" target="_blank" rel="noopener">${esc(f)}</a></li>`
      : `<li><span>${esc(f)}</span></li>`).join("")}</ul>
  </details>`;
  return out;
}

function eventsHtml(a) {
  const evs = [...(a.timeline || [])].sort((x, y) => String(y.date || "").localeCompare(String(x.date || "")) || (y.id || 0) - (x.id || 0));
  if (!evs.length) return '<li class="dr-none muted">Nothing on the timeline yet.</li>';
  const KIND = { status: "Status", note: "Note", timeline: "Event" };
  return evs.map((t) => {
    const kind = KIND[t.kind] ? t.kind : "timeline";
    const via = t.source && t.source !== "dashboard" && t.source !== "app" ? `<span class="ev-via">via ${esc(t.source)}</span>` : "";
    const note = kind === "note" ? '<span class="ev-kind">Note</span>' : "";
    const del = kind === "note"
      ? `<button class="btn icon ghost sm ev-del" type="button" data-del="${esc(t.id)}" aria-label="Delete note from ${esc(fmt(t.date))}" title="Delete note">${ICO.trash}</button>` : "";
    return `<li class="ev k-${kind}">
      <time class="ev-date tnum" datetime="${esc(t.date)}" title="${esc(t.date)}">${esc(fmt(t.date))}</time>
      <span class="ev-mark" aria-hidden="true"></span>
      <div class="ev-main"><span class="sr-only">${KIND[kind]}: </span><span class="ev-text">${esc(t.text)}</span>${note || via ? `<span class="ev-meta">${note}${via}</span>` : ""}</div>
      ${del}
    </li>`;
  }).join("");
}

// ---- dirty state, save, discard ----
function updateDirty() {
  if (!curId) return;
  const fd = formDirty();
  for (const f of fields()) f.classList.toggle("is-dirty", fieldDirty(f));
  const foot = $(".dr-foot");
  foot.hidden = !fd;
  el.classList.toggle("has-foot", fd);
  syncHold(fd || noteDirty());
}

async function save() {
  const a = current();
  if (!a || saving) return;
  const msg = $(".dr-foot .form-msg");
  const sent = {}, body = {};
  for (const f of fields()) if (fieldDirty(f)) { sent[f.name] = f.value; body[f.dataset.api] = f.value.trim(); }
  if (!Object.keys(body).length) return;
  if ("company" in body && !body.company) { msg.textContent = "Company can't be empty."; $('[name="company"]').focus(); return; }
  saving = true;
  const btn = el.querySelector('.dr-foot [type="submit"]');
  btn.disabled = true; msg.textContent = "";
  try {
    await actions.patch(a.key, body, "Saved");
    // The server trims; if the user hasn't typed since, take its value.
    for (const f of fields()) if (f.name in sent && f.value === sent[f.name]) { f.value = f.dataset.base; if (f.tagName === "TEXTAREA") fitSize(f); }
    syncNextDate();
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    saving = false;
    if (btn.isConnected) btn.disabled = false;
    updateDirty();
  }
}

function discard(includeNote = false) {
  if (!curId) return;
  for (const f of fields()) { f.value = f.dataset.base; if (f.tagName === "TEXTAREA") fitSize(f); }
  syncNextDate();
  $(".dr-foot .form-msg").textContent = "";
  if (includeNote) { const t = $(".dr-compose textarea"); t.value = ""; fitSize(t); $(".dr-compose").classList.remove("has-text"); }
  updateDirty();
}

async function addNote() {
  const a = current();
  const form = $(".dr-compose");
  if (!a || form.dataset.busy) return;
  const text = form.note.value.trim(), msg = form.querySelector(".form-msg");
  if (!text) { msg.textContent = "Write something first."; form.note.focus(); return; }
  form.dataset.busy = "1";
  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true; msg.textContent = "";
  try {
    await actions.addNote(a.key, text, form.noteDate.value || iso(today()));
    if (form.isConnected) {
      form.note.value = ""; fitSize(form.note);
      form.noteDate.value = iso(today());
      form.classList.remove("has-text");
    }
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    delete form.dataset.busy;
    btn.disabled = false;
    updateDirty();
  }
}
