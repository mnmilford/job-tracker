// Fake API for the GitHub Pages demo.
//
// The demo is the real front end (app/static, copied in at build time) with this
// script loaded first. It answers every /api/* fetch from memory, following the
// same rules as app/tracker.py, so nothing leaves the browser and everything
// resets on reload. The starting data (demo-data.json) is the real
// tracker.dashboard() output for site/demo/dataset.json, made by
// scripts/build_site.py; every date in it is shifted so the data stays "current"
// whenever someone visits.
(() => {
  "use strict";
  const STAGES = ["Drafting", "Applied", "Recruiter screen", "Interviewing", "Offer"];
  const OUTCOMES = ["Rejected", "Withdrawn", "Ghosted", "Hired"];
  const ALL = [...STAGES, ...OUTCOMES];
  const PREF_SLOTS = ["desktop", "mobile"];
  const DATE_G = /\d{4}-\d{2}-\d{2}/g;
  const DATE_1 = /\d{4}-\d{2}-\d{2}/;
  // API field -> dashboard key
  const FIELDS = [["found", "found"], ["company", "company"], ["role", "role"], ["comp", "comp"], ["source", "source"],
    ["next_step", "next"], ["lesson", "lesson"], ["folder", "folder"], ["posting_url", "url"], ["verdict", "verdict"]];

  // A clean slate on every load: per-browser view state, the since-last-look
  // snapshot and the theme cache would otherwise outlive the in-memory data.
  try {
    for (const k of ["jt-seen", "jt-view2", "jt-prefs", "jt-prefs-dirty", "jt-theme", "jt-theme-css", "jt-theme-attrs", "jt-sankey"]) localStorage.removeItem(k);
  } catch {}

  // ---- dates ----
  const pad = (n) => String(n).padStart(2, "0");
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayNum = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const fromDayNum = (n) => { const d = new Date(n * 864e5); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const plusDays = (n) => fromDayNum(dayNum(todayIso()) + n);

  // ---- errors and helpers ----
  class ApiError extends Error { constructor(status, detail) { super(detail); this.status = status; } }
  const clean = (v, limit = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function validDate(v) {
    if (!v) return todayIso();
    const s = String(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new ApiError(422, `Not a date: '${s}' (use YYYY-MM-DD)`);
    return s;
  }
  function stageOf(status) {
    const s = (status || "").toLowerCase();
    for (const st of ALL) if (s.startsWith(st.toLowerCase())) return st;
    return (status || "").split(/[(,;]/)[0].trim() || "Unknown";
  }
  function startsWithStage(text) {
    const low = text.toLowerCase();
    for (const st of STAGES) {
      const s = st.toLowerCase();
      if (low.startsWith(s) && (low.length === s.length || !/[a-z]/i.test(low[s.length]))) return st;
    }
    return "";
  }
  // Same rule as tracker.path_of(): only recorded evidence counts.
  function pathOf(a) {
    const reached = new Set();
    let exitKnown = false;
    for (const t of a.timeline) {
      const text = (t.text || "").trim();
      const m = t.kind === "status" ? text.match(/^Status:\s*(.+?)\s*→\s*(.+?)\s*$/) : null;
      const added = t.kind === "status" ? text.match(/^Added as\s+(.+?)\s*$/) : null;
      if (m) {
        const [, src, dst] = m;
        if (STAGES.includes(src)) reached.add(src);
        if (STAGES.includes(dst)) reached.add(dst);
        if (OUTCOMES.includes(dst)) exitKnown = STAGES.includes(src);
        else if (STAGES.includes(dst)) exitKnown = false;
      } else if (added) {
        if (STAGES.includes(added[1])) reached.add(added[1]);
      } else {
        const st = startsWithStage(text);
        if (st) reached.add(st);
      }
    }
    if (a.kind === "active" && STAGES.includes(a.stage)) reached.add(a.stage);
    return { reached: STAGES.filter((s) => reached.has(s)), exitKnown: a.kind === "closed" && exitKnown };
  }

  // ---- state ----
  let meta = null;      // everything in the dashboard payload except the three lists
  let apps = [];        // every application, in id order
  let version = 1, maxEvent = 0;

  function refresh(a) {
    a.timeline.sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id);
    a.stage = a.kind === "history" ? "" : stageOf(a.status);
    a.nextDate = (String(a.next || "").match(DATE_1) || [""])[0];
    const dates = [a.found, a.status, ...a.timeline.map((t) => t.date)].join(" ").match(DATE_G) || [];
    a.lastActivity = dates.length ? dates.sort().at(-1) : "";
    a.path = pathOf(a);
  }
  const byId = (id) => apps.find((a) => String(a.id) === String(id));
  const mustGet = (id) => { const a = byId(id); if (!a) throw new ApiError(404, `No application ${id}`); return a; };
  const addEvent = (a, date, text, kind, source) => { a.timeline.push({ id: ++maxEvent, date, text, kind, source }); };
  const bump = () => { version += 1; };

  function load(text) {
    const raw = JSON.parse(text);
    const delta = dayNum(todayIso()) - dayNum(raw.asOf);
    const D = JSON.parse(text.replace(DATE_G, (m) => fromDayNum(dayNum(m) + delta)));
    const { active, closed, history, asOf, version: _v, ...rest } = D;
    meta = rest;
    apps = [...active, ...closed, ...history].sort((x, y) => x.id - y.id);
    maxEvent = Math.max(0, ...apps.flatMap((a) => a.timeline.map((t) => t.id)));
    apps.forEach(refresh);
  }

  function dashboard() {
    const pick = (k) => apps.filter((a) => a.kind === k);
    return clone({ ...meta, version: String(version), active: pick("active"), closed: pick("closed"), history: pick("history") });
  }

  function update(id, data, source = "dashboard") {
    const a = mustGet(id);
    let kind = a.kind, status = a.status;
    const oldStage = kind === "history" ? "History" : stageOf(status);
    const changes = {};
    const when = validDate(data.date);
    const events = [];
    const target = clean(data.status);
    if (target) {
      if (!ALL.includes(target)) throw new ApiError(422, `Unknown status: ${target}. Use one of: ${ALL.join(", ")}`);
      if (target !== oldStage) {
        if (STAGES.includes(target)) {
          kind = "active"; status = target;
          if (!("next_step" in data) && a.kind !== "active") changes.next = "";
        } else {
          kind = "closed"; status = `${target} (${when})`;
        }
        events.push([when, `Status: ${oldStage} → ${target}`, "status"]);
      }
    }
    for (const [api, key] of FIELDS) if (api in data && data[api] != null) changes[key] = clean(data[api], 1000);
    if ("company" in changes && !changes.company) throw new ApiError(422, "company can't be empty");
    const note = clean(data.note, 2000);
    if (note) events.push([when, note, "note"]);
    if (!(target && target !== oldStage) && !Object.keys(changes).length && !note) throw new ApiError(422, "Nothing to change");
    Object.assign(a, changes, { kind, status });
    for (const [d, t, k] of events) addEvent(a, d, t, k, source);
    refresh(a); bump();
    return clone(a);
  }

  function create(data, source = "dashboard") {
    const company = clean(data.company, 120);
    if (!company) throw new ApiError(422, "company is required");
    const stage = stageOf(clean(data.status) || "Drafting");
    if (!ALL.includes(stage)) throw new ApiError(422, `Unknown status: ${data.status}`);
    const kind = STAGES.includes(stage) ? "active" : "closed";
    const status = kind === "closed" ? `${stage} (${validDate(data.date)})` : stage;
    const a = { id: Math.max(0, ...apps.map((x) => x.id)) + 1, kind, status, files: [], timeline: [] };
    for (const [api, key] of FIELDS) a[key] = clean(data[api], 1000);
    a.company = company;
    a.found = a.found || todayIso();
    addEvent(a, a.found, `Added as ${stage}`, "status", source);
    refresh(a); apps.push(a); bump();
    return clone(a);
  }

  function addNote(id, data, source = "dashboard") {
    const a = mustGet(id);
    const text = clean(data.text, 2000);
    if (!text) throw new ApiError(422, "text is required");
    const kind = data.kind || "timeline";
    if (!["timeline", "note"].includes(kind)) throw new ApiError(422, "kind must be timeline or note");
    addEvent(a, validDate(data.date), text, kind, source);
    refresh(a); bump();
    return clone(a);
  }

  function deleteNote(id, eid) {
    const a = mustGet(id);
    const i = a.timeline.findIndex((t) => String(t.id) === String(eid) && t.kind === "note");
    if (i < 0) throw new ApiError(404, "No such note on this application (only notes can be deleted)");
    a.timeline.splice(i, 1);
    refresh(a); bump();
    return clone(a);
  }

  function setPrefs(slot, prefs) {
    if (!PREF_SLOTS.includes(slot)) throw new ApiError(422, `Unknown prefs slot: '${slot}'`);
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) throw new ApiError(422, "prefs must be a JSON object");
    if (JSON.stringify(prefs).length > 16000) throw new ApiError(422, "prefs are too large (limit 16000 bytes)");
    meta.prefs = { ...meta.prefs, [slot]: prefs };
    bump();
    return { slot, prefs };
  }

  function route(method, path, body) {
    let m;
    if (method === "GET" && path === "/api/dashboard") return dashboard();
    if (method === "GET" && path === "/api/prefs") return clone(meta.prefs);
    if (method === "GET" && path === "/api/applications") return clone(apps);
    if (method === "POST" && path === "/api/applications") return create(body || {});
    if ((m = path.match(/^\/api\/applications\/(\d+)$/))) {
      if (method === "GET") return clone(mustGet(m[1]));
      if (method === "PATCH") return update(m[1], body || {});
    }
    if (method === "POST" && (m = path.match(/^\/api\/applications\/(\d+)\/events$/))) return addNote(m[1], body || {});
    if (method === "DELETE" && (m = path.match(/^\/api\/applications\/(\d+)\/events\/(\d+)$/))) return deleteNote(m[1], m[2]);
    if (method === "PUT" && (m = path.match(/^\/api\/prefs\/([^/]+)$/))) return setPrefs(decodeURIComponent(m[1]), (body || {}).prefs);
    if (path.includes("/files/")) throw new ApiError(404, "Documents aren't part of the demo.");
    throw new ApiError(404, "Not in the demo");
  }

  // ---- fetch shim ----
  const realFetch = window.fetch.bind(window);
  const here = document.currentScript ? document.currentScript.src : location.href;
  const ready = realFetch(new URL("demo-data.json", here)).then((r) => {
    if (!r.ok) throw new Error(`demo-data.json: HTTP ${r.status}`);
    return r.text();
  }).then(load);
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const at = url.pathname.indexOf("/api/");
    if (url.origin !== location.origin || at < 0) return realFetch(input, init);
    await ready;
    const method = String(init.method || (typeof input === "string" ? "GET" : input.method) || "GET").toUpperCase();
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { return reply(422, { detail: "Body must be JSON" }); } }
    try {
      const out = route(method, url.pathname.slice(at), body);
      return reply(method === "POST" ? 201 : 200, out);
    } catch (err) {
      if (err instanceof ApiError) return reply(err.status, { detail: err.message });
      console.error(err);
      return reply(500, { detail: String(err) });
    }
  };

  // ---- a little life ----
  // A few seconds in, "Claude" updates two applications the way the real /inbox
  // and /status skills do, so the "Since you last looked" panel has something to
  // show. The app picks it up as it would a real change: on its next refresh.
  ready.then(() => {
    setTimeout(() => {
      try {
        const series = apps.find((a) => a.company === "Series Z Robotics" && a.kind === "active");
        if (series) update(series.id, { status: "Recruiter screen", next_step: `Recruiter screen ${plusDays(2)} 14:00 CT`, note: "Recruiter reached out by email. Screen booked." }, "claude");
        const vapor = apps.find((a) => a.company === "Vaporware Ventures" && a.kind === "active");
        if (vapor) {
          update(vapor.id, { note: "Recruiter replied: \"let's circle back after the holidays.\" Still no date." }, "claude");
          meta.inboxReview = [];
        }
        meta.inboxChecked = todayIso();
        bump();
        document.dispatchEvent(new Event("visibilitychange"));
      } catch (e) { console.error(e); }
    }, 7000);
  }).catch((e) => console.error(e));
})();
