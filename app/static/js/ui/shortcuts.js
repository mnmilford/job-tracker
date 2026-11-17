// Global keyboard shortcuts and the "?" help dialog.
// Ignored while typing (inputs handle their own Esc), while a modal dialog or a
// popover menu is open (they handle their own keys), and with Ctrl/Cmd/Alt.
import { state, setView, openDrawer } from "../core/state.js";
import * as list from "./list.js";
import * as drawer from "./drawer.js";
import * as statusmenu from "./statusmenu.js";
import * as quickadd from "./quickadd.js";
import * as prefs from "./prefs.js";
import * as sankey from "./sankey.js";

const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const inLayer = (el) => !!el?.closest?.("dialog[open], .pop, [role=menu]");
const modalOpen = () => !!document.querySelector("dialog[open]");

/** The app keyboard commands act on: the list selection, else the open drawer. */
const currentId = () => state.selectedId || state.drawerId;
function openIn(id, field) {
  if (!id) return false;
  if (state.drawerId !== id) openDrawer(id);
  if (field) requestAnimationFrame(() => drawer.focusField(field));
  return true;
}

function onKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const t = e.target;
  if (typing(t) || inLayer(t) || modalOpen() || statusmenu.isOpen()) return;
  const k = e.key;
  const done = () => e.preventDefault();

  // "?" first: it's Shift+/ on most layouts.
  if (k === "?") { done(); openHelp(); return; }
  if (k === "/") { done(); const q = document.getElementById("q"); q?.focus(); q?.select(); return; }
  if (k === ",") { done(); prefs.open(); return; }
  if (k === "Escape") { if (drawer.isOpen()) { done(); drawer.close(); } return; }
  if (k === "n" || k === "N") { done(); quickadd.open(); return; }

  if (k === "j" || k === "ArrowDown" || k === "k" || k === "ArrowUp") {
    // Arrows inside a focused control that scrolls (the drawer body) stay native.
    if (k.startsWith("Arrow") && t?.closest?.("#drawer") && !t.closest("[data-id], .row")) return;
    done();
    list.move(k === "j" || k === "ArrowDown" ? 1 : -1);
    if (drawer.isOpen() && state.selectedId && state.selectedId !== state.drawerId) openDrawer(state.selectedId);
    return;
  }
  if (k === "Enter" || k === "o") {
    // Enter on a button or link already does its own thing.
    if (k === "Enter" && t?.closest?.("button, a, summary, [role=button]")) return;
    done(); list.openSelected(); return;
  }
  if (k === "s") {
    const id = currentId(), app = state.M?.byId?.[id];
    if (!app) return;
    done();
    const anchor = (drawer.isOpen() && state.drawerId === id && drawer.badgeEl()) || list.badgeFor(id) || drawer.badgeEl();
    if (anchor) statusmenu.open(anchor, app);
    else { openIn(id); requestAnimationFrame(() => { const b = drawer.badgeEl(); if (b) statusmenu.open(b, app); }); }
    return;
  }
  if (k === "e") { if (openIn(currentId(), "next")) done(); return; }
  if (k === "c") { if (openIn(currentId(), "note")) done(); return; }
  if (k === "a") { done(); setView({ archiveOpen: !state.view.archiveOpen }); return; }
  if (k === "f") { done(); sankey.open(); return; }
  if (/^[0-5]$/.test(k)) {
    if (!state.M) return;
    const stage = k === "0" ? "All" : state.M.stages[+k - 1];
    if (!stage) return;
    done(); setView({ stage: state.view.stage === stage && k !== "0" ? "All" : stage });
    return;
  }
}

export function init() {
  document.addEventListener("keydown", onKey);
}

// ---- help ----
const K = (...keys) => keys.map((x) => (x === "or" ? '<span>or</span>' : x === "to" ? '<span>to</span>' : `<kbd class="kbd">${x}</kbd>`)).join("");
const GROUPS = [
  { name: "Move around", rows: [
    ["Search", K("/")],
    ["Next application", K("j", "or", "↓")],
    ["Previous application", K("k", "or", "↑")],
    ["Open selected", K("Enter", "or", "o")],
    ["Close the panel", K("Esc")],
  ] },
  { name: "Act on the selected one", rows: [
    ["Change status", K("s")],
    ["Edit next step", K("e")],
    ["Add a note", K("c")],
    ["New application", K("n")],
  ] },
  { name: "Filter", rows: [
    ["One stage", K("1", "to", "5")],
    ["All stages", K("0")],
    ["Show or hide archive", K("a")],
  ] },
  { name: "This page", rows: [
    ["Flow chart", K("f")],
    ["Appearance", K(",")],
    ["Color mode", '<span>button in the top bar</span>'],
    ["These shortcuts", K("?")],
  ] },
];

let dlg = null;
export function openHelp() {
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "dlg kb-dlg";
    dlg.setAttribute("aria-labelledby", "kb-title");
    dlg.innerHTML = `
      <div class="dlg-head"><h2 id="kb-title">Keyboard shortcuts</h2>
        <button type="button" class="btn ghost icon" data-close aria-label="Close"><svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
      <div class="dlg-body"><div class="kb-cols">${GROUPS.map((g) => `<div class="kb-group" role="group" aria-label="${g.name}"><h3>${g.name}</h3>
        ${g.rows.map(([label, keys]) => `<div class="kb-row"><span>${label}</span><span class="kb-keys">${keys}</span></div>`).join("")}</div>`).join("")}</div></div>
      <div class="dlg-foot"><span class="kb-foot-note">Shortcuts pause while you're typing in a box.</span><button type="button" class="btn primary" data-close>Done</button></div>`;
    let opener = null;
    dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest("[data-close]")) dlg.close(); });
    dlg.addEventListener("close", () => { opener?.focus?.(); opener = null; });
    dlg.addEventListener("keydown", (e) => { if (e.key === "?" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); dlg.close(); } });
    dlg._setOpener = (el) => { opener = el; };
    document.body.append(dlg);
  }
  if (dlg.open) return;
  dlg._setOpener(document.activeElement);
  dlg.showModal();
  dlg.querySelector("[data-close].primary").focus();
}
