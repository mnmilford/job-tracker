// Job Tracker front end. Plain JS, no build step.
// Reads /api/dashboard, renders, and writes through the JSON API.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DAY = 864e5;
  const FOLLOW_UP_DAYS = 10;
  const INBOX_STALE_DAYS = 3;
  const POLL_MS = 30000;
  let D = null;
  let today = new Date(); today.setHours(0, 0, 0, 0);

  const parse = (s) => {
    const m = String(s || "").match(/(\d{4})-(\d{2})(?:-(\d{2}))?/);
    return m ? new Date(+m[1], +m[2] - 1, +(m[3] || 1)) : null;
  };
  const daysSince = (s) => { const d = parse(s); return d ? Math.round((today - d) / DAY) : null; };
  const fmt = (s) => {
    const d = parse(s); if (!d) return s || "";
    return d.toLocaleDateString("en-US", String(s).length > 7
      ? { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" }
      : { month: "short", year: "numeric" });
  };
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const store = {
    get(k, def) { try { return JSON.parse(localStorage.getItem("jt-" + k)) ?? def; } catch { return def; } },
    set(k, v) { try { localStorage.setItem("jt-" + k, JSON.stringify(v)); } catch {} },
  };

  // ---- API ----
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", "X-Requested-With": "job-tracker" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); if (j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
      if (res.status === 401) msg = "Signed out. Reload the page to sign in again.";
      throw new Error(msg);
    }
    return res.json();
  }

  // ---- Theme (per-viewer convenience) ----
  const themeBtn = $("theme");
  const modes = ["auto", "light", "dark"];
  let mode = store.get("theme", "auto");
  const applyTheme = () => {
    if (mode === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
    themeBtn.textContent = "Theme: " + mode;
  };
  themeBtn.onclick = () => { mode = modes[(modes.indexOf(mode) + 1) % modes.length]; store.set("theme", mode); applyTheme(); };
  applyTheme();

  // ---- View state (kept across reloads and live refreshes) ----
  const view = Object.assign({ filter: "All", closed: "All", when: "all", q: "", open: [], history: false }, store.get("view", {}));
  const saveView = () => {
    view.open = [...document.querySelectorAll("details.app[open]")].map((d) => d.dataset.id);
    view.history = $("history-fold").open;
    store.set("view", view);
  };

  const toast = (text) => {
    const t = document.createElement("div");
    t.className = "toast"; t.setAttribute("role", "status"); t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  };

  // ---- Render ----
  function render() {
    today = new Date(); today.setHours(0, 0, 0, 0);
    const STAGE_VAR = Object.fromEntries(D.stages.map((s, i) => [s, `var(--s${i + 1})`]));
    const all = [...D.active, ...D.closed, ...D.history];
    const byId = Object.fromEntries(all.map((a) => [String(a.id), a]));
    window.__byId = byId;

    $("title").innerHTML = `Job search${D.owner ? ` <span>·</span> ${esc(D.owner)}` : ""}`;
    $("demo-banner").hidden = !D.demo;
    $("sub").innerHTML = `<span class="live" id="live"><i></i>Live</span> · ${D.inboxChecked ? "Gmail checked " + esc(fmt(D.inboxChecked)) : "Gmail not checked yet"}`;

    const active = D.active.map((a) => ({ ...a, idle: daysSince(a.lastActivity), nextIn: a.nextDate ? -daysSince(a.nextDate) : null }));
    const byStage = Object.fromEntries(D.stages.map((s) => [s, active.filter((a) => a.stage === s)]));

    // Needs attention
    const attention = [];
    for (const a of active) {
      if (a.nextIn !== null && a.nextIn < 0) attention.push({ a, rank: 0, tag: ["critical", "! Overdue"], when: `${a.next} · was due ${fmt(a.nextDate)}` });
      else if (a.nextIn !== null && a.nextIn <= 14) attention.push({ a, rank: 1, tag: ["upcoming", a.nextIn === 0 ? "Today" : a.nextIn === 1 ? "Tomorrow" : `In ${a.nextIn} days`], when: a.next });
      if (a.stage === "Applied" && a.idle !== null && a.idle >= FOLLOW_UP_DAYS) attention.push({ a, rank: 2, tag: ["warn", "⚠ Follow up"], when: `No movement in ${a.idle} days. Follow up, or mark it Ghosted.` });
      if (a.stage === "Drafting") attention.push({ a, rank: 3, tag: ["neutral", "✎ Drafting"], when: a.next || "Materials not sent yet" });
    }
    const inboxAge = D.inboxChecked ? daysSince(D.inboxChecked) : null;
    for (const text of D.inboxReview || []) attention.push({ inbox: true, a: { company: "Inbox", role: "needs your call" }, rank: 0, tag: ["warn", "✉ Review"], when: text });
    if (inboxAge === null || inboxAge > INBOX_STALE_DAYS) attention.push({ inbox: true, a: { company: "Inbox", role: "not checked recently" }, rank: 0, tag: ["warn", "✉ Stale"],
      when: inboxAge === null ? "Gmail has never been checked. Ask Claude to run /inbox." : `Last Gmail check was ${inboxAge} days ago, so statuses may be behind. Ask Claude to run /inbox.` });
    attention.sort((x, y) => x.rank - y.rank || (x.a.nextIn ?? 99) - (y.a.nextIn ?? 99));
    const followUps = attention.filter((x) => !x.inbox && x.rank <= 2 && x.tag[0] !== "upcoming").length;

    // KPIs
    const kpis = [
      { label: "Active", value: active.length, hint: `${D.closed.length} closed · ${D.history.length} in history` },
      { label: "Applied, waiting", value: byStage["Applied"].length, hint: "no response yet" },
      { label: "In conversation", value: byStage["Recruiter screen"].length + byStage["Interviewing"].length, hint: "screens + interviews" },
      { label: "Needs a nudge", value: followUps, hint: followUps ? "overdue or 10+ days quiet" : "nothing overdue", warn: followUps > 0 },
      { label: "Offers", value: byStage["Offer"].length, hint: "active offers" },
    ];
    $("kpis").innerHTML = kpis.map((k) => `<div class="kpi">
      <div class="label">${k.warn ? '<span class="tag warn" aria-hidden="true">⚠</span>' : ""}${esc(k.label)}</div>
      <div class="value">${k.value}</div><div class="hint">${esc(k.hint)}</div></div>`).join("");

    // Funnel
    const max = Math.max(1, ...D.stages.map((s) => byStage[s].length));
    $("funnel").innerHTML = D.stages.map((s) => {
      const n = byStage[s].length;
      return `<button type="button" class="stage${n ? "" : " zero"}" data-stage="${esc(s)}" aria-pressed="${view.filter === s}"
          aria-label="${esc(s)}: ${n} application${n === 1 ? "" : "s"}${n ? ". " + esc(byStage[s].map((a) => a.company).join(", ")) : ""}">
        <span class="name">${esc(s)}</span>
        <span class="track">${n ? `<span class="bar" style="width:${(n / max) * 100}%;background:${STAGE_VAR[s]}"></span>` : ""}</span>
        <span class="n">${n}</span></button>`;
    }).join("");
    $("funnel-empty").hidden = active.length > 0;
    for (const el of $("funnel").children) el.onclick = () => { view.filter = view.filter === el.dataset.stage ? "All" : el.dataset.stage; render(); saveView(); };

    $("attention").innerHTML = attention.length
      ? attention.map((x) => `<li><span class="tag ${x.tag[0]}">${esc(x.tag[1])}</span>
          <div><div class="what"><b>${esc(x.a.company)}</b> · ${esc(x.a.role)}</div><div class="when">${esc(x.when)}</div></div></li>`).join("")
      : `<li><span class="tag neutral">✓ Clear</span><div class="what">Nothing overdue or waiting on you.</div></li>`;

    // Rows
    const pill = (a) => {
      const s = a.stage;
      if (s === "Offer" || s === "Hired") return `<span class="tag good">✓ ${esc(s)}</span>`;
      if (D.outcomes.includes(s)) return `<span class="tag neutral">${esc(s)}</span>`;
      return `<span class="pill"><i style="background:${STAGE_VAR[s] || "var(--muted)"}"></i>${esc(s)}</span>`;
    };
    // Document buttons: for each .docx in the application's folder, a PDF button
    // (when the folder has a matching PDF) and a Word button. They link to the
    // file in the documents repo on GitHub via /raw/, which serves the file
    // itself; for a private repo GitHub only serves it to a browser signed in to
    // an account with access. This app never stores documents or GitHub tokens.
    const rawLink = (a, f) => `${D.repoUrl}/raw/${encodeURIComponent(D.branch)}/${`${a.folder}/${f}`.split("/").map(encodeURIComponent).join("/")}`;
    const docButtons = (a) => {
      if (!D.repoUrl || !a.folder) return "";
      const docs = a.files.filter((f) => /\.docx$/i.test(f));
      if (!docs.length) return "";
      const label = (f) => /cover[_ -]?letter/i.test(f) ? "Cover letter" : /resume|\bcv\b/i.test(f) ? "Resume" : f.replace(/\.docx$/i, "");
      const ordered = [...docs].sort((x, y) => (label(x) === "Resume" ? -1 : label(y) === "Resume" ? 1 : 0));
      return `<div class="open-docs">${ordered.map((f, i) => {
        const pdf = f.replace(/\.docx$/i, ".pdf");
        const hasPdf = a.files.includes(pdf);
        return `<span class="doc-pair">
          ${hasPdf ? `<a class="btn${i ? " secondary" : ""}" href="${esc(rawLink(a, pdf))}" target="_blank" rel="noopener" title="${esc(pdf)}">${esc(label(f))} PDF</a>` : ""}
          <a class="btn secondary" href="${esc(rawLink(a, f))}" target="_blank" rel="noopener" title="${esc(f)}">${esc(label(f))} (Word)</a>
        </span>`;
      }).join("")}</div>
        <div class="btn-note">Downloads from GitHub. Sign in to GitHub in this browser if a link says "Not Found".</div>`;
    };
    const fileLink = (a, f) => D.repoUrl && a.folder ? `${D.repoUrl}/blob/${D.branch}/${a.folder}/${f}` : "";
    const row = (a) => {
      const idle = a.kind === "active" && a.idle !== null
        ? `<div class="idle${a.stage === "Applied" && a.idle >= FOLLOW_UP_DAYS ? " stale" : ""}" title="Days since last activity">${a.idle}d</div>`
        : `<div class="idle">${esc(fmt(a.lastActivity))}</div>`;
      const third = a.kind === "active"
        ? `<div class="cell"><span class="k">Next</span>${esc(a.next || "—")}</div>`
        : `<div class="cell"><span class="k">Lesson</span>${esc(a.lesson || "—")}</div>`;
      const files = a.files.length
        ? `<div class="files">${a.files.map((f) => fileLink(a, f) ? `<a href="${esc(fileLink(a, f))}" target="_blank" rel="noopener">${esc(f)}</a>` : `<span>${esc(f)}</span>`).join("")}</div>`
        : `<span class="cell">No folder</span>`;
      const tl = a.timeline.length
        ? `<ul class="tl">${a.timeline.map((t) => `<li><span class="d">${esc(fmt(t.date))}</span>${t.kind === "note" ? '<span class="note-t">Note</span>' : ""}${esc(t.text)}${t.kind === "note" ? ` <button class="del" type="button" data-del="${t.id}" data-app="${a.id}" aria-label="Delete this note" title="Delete note">×</button>` : ""}</li>`).join("")}</ul>`
        : `<div class="cell">Nothing on the timeline yet.</div>`;
      return `<details class="app" data-id="${a.id}"${view.open.includes(String(a.id)) ? " open" : ""}>
        <summary>
          <div style="min-width:0"><div class="co">${esc(a.company)}</div><div class="ro">${esc(a.role)}</div></div>
          <div class="cell">${pill(a)}</div>
          <div class="cell"><span class="k">Comp</span>${esc(a.comp || "—")}</div>
          ${third}${idle}
        </summary>
        <div class="body">
          <div>
            <div class="row-actions"><button class="btn" type="button" data-edit="${a.id}">Update status or add a note</button></div>
            <h3>Details</h3>
            <dl>
              <dt>Status</dt><dd>${esc(a.status)}</dd>
              <dt>Fit</dt><dd>${esc(a.verdict || "Not assessed")}</dd>
              <dt>Found</dt><dd>${esc(fmt(a.found) || "—")}</dd>
              <dt>Source</dt><dd>${esc(a.source || "—")}</dd>
              ${a.kind === "active" ? `<dt>Next step</dt><dd>${esc(a.next || "—")}</dd>` : `<dt>Lesson</dt><dd>${esc(a.lesson || "—")}</dd>`}
              ${a.url ? `<dt>Posting</dt><dd><a href="${esc(a.url)}" target="_blank" rel="noopener">Original listing</a></dd>` : ""}
            </dl>
            <h3>Files</h3>${docButtons(a)}${files}
          </div>
          <div><h3>Timeline</h3>${tl}</div>
        </div>
      </details>`;
    };

    // Active list + filters
    $("filters").innerHTML = ["All", ...D.stages].map((c) => `<button type="button" class="chip" data-f="${esc(c)}" aria-pressed="${view.filter === c}">${esc(c)}${c === "All" ? "" : ` · ${byStage[c].length}`}</button>`).join("")
      + `<input class="search" id="q" type="search" placeholder="Search company, role, notes" aria-label="Search all applications" value="${esc(view.q)}">`;
    for (const b of $("filters").querySelectorAll(".chip")) b.onclick = () => { view.filter = b.dataset.f; render(); saveView(); };
    const qEl = $("q");
    qEl.oninput = () => { view.q = qEl.value; renderLists(); saveView(); };

    function renderLists() {
      const q = view.q.trim().toLowerCase();
      const match = (a) => !q || [a.company, a.role, a.status, a.next, a.lesson, a.source, ...a.timeline.map((t) => t.text)].join(" ").toLowerCase().includes(q);
      const order = (a) => D.stages.indexOf(a.stage);
      const list = active.filter((a) => (view.filter === "All" || a.stage === view.filter) && match(a))
        .sort((x, y) => order(y) - order(x) || (y.idle ?? 0) - (x.idle ?? 0));
      $("active").innerHTML = list.length ? list.map(row).join("")
        : `<div class="empty">${active.length ? "No active applications match." : "Nothing active right now."}</div>`;
      $("active-count").textContent = view.filter === "All" && !q ? `· ${active.length}` : `· ${list.length} of ${active.length}`;

      // Closed: outcome chips + time window
      const inWindow = (a) => {
        if (view.when === "all") return true;
        const d = parse(a.lastActivity); if (!d) return false;
        if (view.when === "year") return d.getFullYear() === today.getFullYear();
        return (today - d) / DAY <= +view.when;
      };
      const pool = D.closed.filter((a) => match(a) && inWindow(a));
      const counts = Object.fromEntries(D.outcomes.map((o) => [o, pool.filter((a) => a.stage === o).length]));
      $("closed-filters").innerHTML = ["All", ...D.outcomes].map((c) => `<button type="button" class="chip" data-c="${esc(c)}" aria-pressed="${view.closed === c}">${esc(c)} · ${c === "All" ? pool.length : counts[c]}</button>`).join("");
      for (const b of $("closed-filters").querySelectorAll(".chip")) b.onclick = () => { view.closed = b.dataset.c; renderLists(); saveView(); };
      $("closed-when").value = view.when;
      const closed = pool.filter((a) => view.closed === "All" || a.stage === view.closed)
        .sort((x, y) => (y.lastActivity || "").localeCompare(x.lastActivity || ""));
      $("closed").innerHTML = closed.length ? closed.map(row).join("") : `<div class="empty">No closed applications match.</div>`;
      $("closed-count").textContent = closed.length === D.closed.length ? `· ${D.closed.length}` : `· ${closed.length} of ${D.closed.length}`;

      const hist = D.history.filter(match);
      $("history-count").textContent = `(${D.history.length})`;
      $("history").innerHTML = `<thead><tr><th>Company</th><th>Role</th><th>Framing / lesson</th><th aria-label="Actions"></th></tr></thead><tbody>`
        + (hist.length ? hist.map((h) => `<tr><td>${esc(h.company)}</td><td>${esc(h.role)}</td><td>${esc(h.lesson)}</td><td class="act"><button class="linkbtn" type="button" data-edit="${h.id}">Update</button></td></tr>`).join("")
          : `<tr><td colspan="4" class="empty">Nothing matches.</td></tr>`) + `</tbody>`;
    }
    renderLists();
    $("history-fold").open = !!view.history;
  }

  $("closed-when").onchange = (e) => { view.when = e.target.value; render(); saveView(); };
  $("history-fold").addEventListener("toggle", saveView);
  document.addEventListener("toggle", (e) => { if (e.target.matches && e.target.matches("details.app")) saveView(); }, true);

  // ---- Edit / add dialog ----
  const dlg = $("edit");
  let editing = null;   // application object, or "new"
  const F = (id) => $("f-" + id);
  const syncFields = () => {
    const s = F("status").value;
    const isOutcome = D.outcomes.includes(s);
    const current = editing === "new" ? "" : (editing.kind === "history" ? "History" : editing.stage);
    $("w-next").hidden = isOutcome;
    $("w-lesson").hidden = !isOutcome;
    // The date stamps a status change or a note; hide it when neither is happening.
    $("w-date").hidden = editing !== "new" && s === current && !F("note").value.trim();
  };
  function openEdit(app) {
    editing = app;
    const isNew = app === "new";
    $("new-fields").hidden = !isNew;
    $("edit-title").textContent = isNew ? "Add an application" : "Update";
    $("edit-who").textContent = isNew ? "" : `${app.company} · ${app.role}`;
    const opts = (list, label) => `<optgroup label="${label}">${list.map((s) => `<option>${esc(s)}</option>`).join("")}</optgroup>`;
    F("status").innerHTML = (!isNew && app.kind === "history" ? `<option value="History">History (no status yet)</option>` : "")
      + opts(D.stages, "In progress") + opts(D.outcomes, "Closed");
    F("status").value = isNew ? "Applied" : app.kind === "history" ? "History" : (D.stages.includes(app.stage) || D.outcomes.includes(app.stage) ? app.stage : "Applied");
    F("company").value = ""; F("role").value = "";
    F("date").value = iso(today);
    F("next").value = isNew ? "" : app.next || "";
    F("lesson").value = isNew ? "" : app.lesson || "";
    F("note").value = "";
    $("edit-msg").textContent = "";
    $("edit-save").disabled = false;
    syncFields();
    dlg.showModal();
    (isNew ? F("company") : F("status")).focus();
  }
  F("status").onchange = syncFields;
  F("note").oninput = syncFields;
  $("edit-cancel").onclick = () => dlg.close();
  $("add").onclick = () => openEdit("new");

  $("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const s = F("status").value, isOutcome = D.outcomes.includes(s);
    const body = { date: F("date").value || undefined };
    if (s !== "History") body.status = s;
    if (isOutcome) body.lesson = F("lesson").value; else body.next_step = F("next").value;
    const note = F("note").value.trim();
    $("edit-save").disabled = true; $("edit-msg").textContent = "";
    try {
      if (editing === "new") {
        if (!F("company").value.trim()) throw new Error("Company is required.");
        const created = await api("POST", "/api/applications", { ...body, company: F("company").value, role: F("role").value, found: iso(today) });
        if (note) await api("POST", `/api/applications/${created.id}/events`, { text: note, kind: "note", date: body.date });
        view.open = [...new Set([...view.open, String(created.id)])];
      } else {
        if (note) body.note = note;
        // Don't send unchanged text fields, so "nothing changed" is detectable.
        if (body.next_step !== undefined && body.next_step === (editing.next || "")) delete body.next_step;
        if (body.lesson !== undefined && body.lesson === (editing.lesson || "")) delete body.lesson;
        const current = editing.kind === "history" ? "History" : editing.stage;
        if (body.status === current) delete body.status;
        await api("PATCH", `/api/applications/${editing.id}`, body);
        view.open = [...new Set([...view.open, String(editing.id)])];
      }
      store.set("view", view);
      dlg.close();
      await load();
      toast("Saved");
    } catch (err) {
      $("edit-msg").textContent = err.message === "Nothing to change" ? "Nothing changed yet." : err.message;
      $("edit-save").disabled = false;
    }
  });

  document.addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-edit]");
    if (ed) { const a = window.__byId[ed.dataset.edit]; if (a) openEdit(a); return; }
    const del = e.target.closest("[data-del]");
    if (del) {
      if (!confirm("Delete this note?")) return;
      try { await api("DELETE", `/api/applications/${del.dataset.app}/events/${del.dataset.del}`); await load(); toast("Note deleted"); }
      catch (err) { alert(err.message); }
    }
  });

  // ---- Load + live refresh ----
  async function load() {
    const data = await api("GET", "/api/dashboard");
    if (D && data.version === D.version) return false;
    if (D) saveView();
    D = data;
    render();
    return true;
  }
  const setLive = (ok) => { const el = $("live"); if (el) { el.classList.toggle("off", !ok); el.lastChild.textContent = ok ? "Live" : "Offline"; } };
  async function poll() {
    if (document.hidden || dlg.open) return;
    try { await load(); setLive(true); } catch { setLive(false); }
  }
  load().then(() => { const s = view; if (s.scroll) scrollTo(0, s.scroll); }).catch((err) => {
    $("sub").textContent = "Couldn't load: " + err.message;
  });
  setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", poll);
})();
