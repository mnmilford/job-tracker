// Job Tracker front end: entry point. Plain ES modules, no build step.
// Core (js/core): api, store, format, state (model + polling), changes
// (since-last-look), actions (all writes). UI (js/ui): one module per surface,
// each with an init() that mounts itself and listens to state events.
import { state, on, load, startPolling, setView } from "./js/core/state.js";
import { esc, fmt } from "./js/core/format.js";
import * as list from "./js/ui/list.js";
import * as rail from "./js/ui/rail.js";
import * as drawer from "./js/ui/drawer.js";
import * as quickadd from "./js/ui/quickadd.js";
import * as prefs from "./js/ui/prefs.js";
import * as shortcuts from "./js/ui/shortcuts.js";
import * as sankey from "./js/ui/sankey.js";

const $ = (id) => document.getElementById(id);

// ---- Top bar ----
function renderHeader() {
  const M = state.M;
  $("title").innerHTML = `Job search${M.owner ? ` <span class="owner">· ${esc(M.owner)}</span>` : ""}`;
  $("demo-banner").hidden = !M.demo;
  renderSub();
}
function renderSub() {
  const M = state.M;
  const gmail = !M ? "" : M.inbox.checked ? `Gmail checked ${esc(fmt(M.inbox.checked))}` : "Gmail not checked yet";
  $("sub").innerHTML = `<span class="live${state.live.ok ? "" : " off"}" id="live"><i aria-hidden="true"></i><span>${esc(state.live.label)}</span></span>${gmail ? ` <span aria-hidden="true">·</span> <span>${gmail}</span>` : ""}`;
}

const q = $("q");
q.value = state.view.q;
let qTimer;
q.addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => setView({ q: q.value }), 80); });
q.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (q.value) { q.value = ""; setView({ q: "" }); } else q.blur(); e.stopPropagation(); }
  if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); q.blur(); list.focusFirst(); }
});
$("new-btn").onclick = () => quickadd.open();
$("prefs-btn").onclick = () => prefs.open();
$("mode-btn").onclick = () => prefs.cycleMode();
$("help-btn").onclick = () => shortcuts.openHelp();
$("flow-btn").onclick = () => sankey.open();

// The wide-desktop drawer sits under the sticky top bar; track where that ends
// (it moves while the demo banner scrolls away, and when the bar wraps).
const topbar = document.querySelector(".topbar");
const syncTopbar = () => document.documentElement.style.setProperty("--topbar-bottom", `${Math.max(0, Math.round(topbar.getBoundingClientRect().bottom))}px`);
new ResizeObserver(syncTopbar).observe(topbar);
addEventListener("scroll", syncTopbar, { passive: true });
addEventListener("resize", syncTopbar);
syncTopbar();

on("data", renderHeader);
on("live", renderSub);

// ---- Mount ----
prefs.init();
list.init($("main"));
rail.init($("rail"));
drawer.init($("drawer"));
quickadd.init();
shortcuts.init();
sankey.init();

load({ force: true }).catch((err) => {
  $("sub").textContent = "Couldn't load: " + err.message;
});
startPolling();
