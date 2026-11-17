// Appearance: theme engine + the customizer dialog.
//
// Settings sync through the server in two slots, "desktop" and "mobile"
// (touch-first devices). The synced object is the settings plus the color mode.
// The server copy for this device's slot wins; localStorage is this device's
// cache so the inline script in index.html can paint the theme before any JS:
//   jt-prefs        the settings object (see DEFAULT_PREFS)
//   jt-theme        color mode, "auto" | "light" | "dark" (same key as the old app)
//   jt-theme-css    the generated CSS, replayed by the inline script in index.html
//   jt-theme-attrs  data-* attributes for <html>, e.g. {"badge":"tint"}, also replayed
//
// Every change rebuilds one CSS string that overrides tokens.css: light values
// on :root, dark values under the same two selectors tokens.css uses. Only
// tokens that differ from the Default theme are written, so Default is "".
// Color values here are theme data, not styling: they only ever land in that
// generated CSS or in swatch previews.
import { store } from "../core/store.js";
import { esc } from "../core/format.js";
import { state, on } from "../core/state.js";
import { api } from "../core/api.js";
import { toast } from "./toast.js";

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGBA_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i;

/** "#abc", "#aabbcc", "rgb(1,2,3)", "rgba(1,2,3,.5)" -> {r,g,b,a} or null. Nothing else is accepted. */
export function parseColor(s) {
  s = String(s ?? "").trim();
  let m = s.match(HEX_RE);
  if (m) {
    let h = m[1]; if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = s.match(RGBA_RE);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    const a = m[4] == null ? 1 : Number(m[4]);
    if (r > 255 || g > 255 || b > 255 || !(a >= 0 && a <= 1)) return null;
    return { r, g, b, a };
  }
  return null;
}
const hex2 = (n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
const toHex = (c) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
export function fmtColor(c) {
  if (c.a >= 1) return toHex(c);
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+c.a.toFixed(3)})`;
}
/** Canonical form, so equal colors compare equal as strings. null if invalid. */
export const normColor = (s) => { const c = parseColor(s); return c ? fmtColor(c) : null; };
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
/** a mixed toward b by t (0..1), opaque result. */
const mix = (a, b, t) => {
  const A = over(parseColor(a), WHITE), B = over(parseColor(b), WHITE);
  return fmtColor({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t, a: 1 });
};
const alpha = (s, a) => { const c = parseColor(s); return fmtColor({ ...c, a }); };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
/** WCAG contrast of fg on bg (fg composited over bg if translucent; bg over white). */
export function contrast(fg, bg) {
  const B = over(parseColor(bg), WHITE), F = over(parseColor(fg), B);
  const [l1, l2] = [lum(F), lum(B)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
/** Push ink toward black or white (whichever the bg needs) until it reads at `min`. */
function readable(ink, bg, min = 4.5) {
  if (contrast(ink, bg) >= min) return ink;
  const target = lum(over(parseColor(bg), WHITE)) > 0.18 ? "#000000" : "#ffffff";
  for (let t = 0.1; t <= 1.0001; t += 0.1) { const c = mix(ink, target, t); if (contrast(c, bg) >= min) return c; }
  return target;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
// The Default theme, copied from tokens.css (a parity check in the dev
// tests compares these to getComputedStyle). Dark inherits anything tokens.css
// doesn't redefine for dark.
const DEF_LIGHT = {
  page: "#f9f9f7", surface: "#fcfcfb", raised: "#ffffff", hover: "rgba(11, 11, 11, 0.04)",
  ink: "#0b0b0b", "ink-2": "#52514e", muted: "#6b6a65", grid: "#e1e0d9", axis: "#c3c2b7", border: "rgba(11, 11, 11, 0.1)",
  accent: "#2f6b69", "accent-bg": "#eaf4f4", "on-accent": "#ffffff", brand: "#3a7d7b", focus: "#2f6b69",
  s1: "#86b6ef", s2: "#5598e7", s3: "#2a78d6", s4: "#1c5cab", s5: "#104281",
  warn: "#fab219", "warn-ink": "#8a5a00", "warn-bg": "#fdf3dc", serious: "#ec835a",
  critical: "#d03b3b", "critical-ink": "#b42323", "critical-bg": "#fbeaea",
  good: "#0ca30c", "good-ink": "#006300", "good-bg": "#e6f5e6", "on-warn": "#0b0b0b", "doc-paper": "#ffffff",
};
const DEF_DARK = {
  ...DEF_LIGHT,
  page: "#0d0d0d", surface: "#1a1a19", raised: "#222220", hover: "rgba(255, 255, 255, 0.05)",
  ink: "#f0efec", "ink-2": "#c3c2b7", muted: "#9a988f", grid: "#2c2c2a", axis: "#383835", border: "rgba(255, 255, 255, 0.1)",
  accent: "#6cc0bc", "accent-bg": "#1d3433", "on-accent": "#0d0d0d", brand: "#6cc0bc", focus: "#6cc0bc",
  s1: "#184f95", s2: "#256abf", s3: "#3987e5", s4: "#6da7ec", s5: "#9ec5f4",
  "warn-ink": "#f5c55a", "warn-bg": "#3a2e12", "critical-ink": "#f08a8a", "critical-bg": "#3a1a1a", "good-ink": "#4cc84c", "good-bg": "#16301a",
};
export const DEFAULTS = { light: canon(DEF_LIGHT), dark: canon(DEF_DARK) };
const ALL_TOKENS = Object.keys(DEF_LIGHT);
function canon(o) { const r = {}; for (const k in o) r[k] = normColor(o[k]); return r; }

const STAGE_FALLBACK = ["Drafting", "Applied", "Recruiter screen", "Interviewing", "Offer"];
const stageName = (i) => (state.M?.stages || STAGE_FALLBACK)[i] || `Stage ${i + 1}`;
// The tokens the customizer edits, grouped as in the dialog.
const GROUPS = [
  { name: "Surfaces", rows: [["page", "Page"], ["surface", "Surface"], ["raised", "Raised"], ["border", "Border"], ["grid", "Grid lines"]] },
  { name: "Text", rows: [["ink", "Text"], ["ink-2", "Secondary text"], ["muted", "Muted text"]] },
  { name: "Accent", rows: [["accent", "Accent"], ["accent-bg", "Accent tint"], ["on-accent", "Text on accent"]] },
  { name: "Stages", rows: [1, 2, 3, 4, 5].map((n) => [`s${n}`, () => stageName(n - 1)]) },
  { name: "Status", rows: [["critical", "Critical"], ["warn", "Warning"], ["good", "Good"]] },
];
const EDITABLE = new Set(GROUPS.flatMap((g) => g.rows.map((r) => r[0])));

// ---------------------------------------------------------------------------
// Presets: each defines light AND dark. Anything left out falls back to
// Default, then derive() fills the companions (hover, focus, *-ink, *-bg).
// ---------------------------------------------------------------------------
const PRESETS = [
  { id: "default", name: "Default", note: "Warm neutrals, teal accent", light: {}, dark: {} },
  {
    id: "graphite", name: "Graphite", note: "Cool greys, indigo",
    light: {
      page: "#f5f6f8", surface: "#fbfbfc", raised: "#ffffff", hover: "rgba(17, 24, 39, 0.045)",
      ink: "#0f131a", "ink-2": "#454c5a", muted: "#636a78", grid: "#e1e4e9", axis: "#c3c8d1", border: "rgba(17, 24, 39, 0.11)",
      accent: "#4f46e5", "accent-bg": "#eef0fd", "on-accent": "#ffffff", brand: "#4f46e5", focus: "#4f46e5",
      s1: "#97a6fa", s2: "#7b85f6", s3: "#6366f1", s4: "#4338ca", s5: "#312e81",
    },
    dark: {
      page: "#0c0d10", surface: "#15171b", raised: "#1c1f24", hover: "rgba(226, 232, 240, 0.05)",
      ink: "#eceef2", "ink-2": "#b9bec9", muted: "#8f95a2", grid: "#262930", axis: "#353943", border: "rgba(226, 232, 240, 0.1)",
      accent: "#8b93f8", "accent-bg": "#23254a", "on-accent": "#0c0d10", brand: "#8b93f8", focus: "#8b93f8",
      s1: "#3d36b4", s2: "#5149e6", s3: "#6c70f2", s4: "#959cf9", s5: "#c3c9fd",
    },
  },
  {
    id: "stages", name: "Stage hues", note: "A distinct color per stage", badge: "tint",
    light: { s1: "#71809a", s2: "#2f7de1", s3: "#8257e6", s4: "#0e8f83", s5: "#1f9a46" },
    dark: { s1: "#94a3b8", s2: "#5ea2f7", s3: "#a78bfa", s4: "#2fc9b6", s5: "#4fd17c" },
  },
  {
    id: "paper", name: "Paper", note: "Cream, serif, sepia ink", font: "serif",
    light: {
      page: "#f4eee0", surface: "#faf6ec", raised: "#fffdf7", hover: "rgba(74, 52, 26, 0.05)",
      ink: "#2a2017", "ink-2": "#57483a", muted: "#75644f", grid: "#e3d9c3", axis: "#c9bb9c", border: "rgba(74, 52, 26, 0.15)",
      accent: "#2e5e3c", "accent-bg": "#e3ecd9", "on-accent": "#fffdf7", brand: "#2e5e3c", focus: "#2e5e3c",
      s1: "#c8a970", s2: "#b8843f", s3: "#8e8a3c", s4: "#5a7f48", s5: "#2e5e3c",
      warn: "#d6a03a", "warn-ink": "#7a4f06", "warn-bg": "#f6e8c6",
      critical: "#b5412f", "critical-ink": "#9a3020", "critical-bg": "#f4dfd5",
      good: "#4c8a3a", "good-ink": "#2f5f22", "good-bg": "#e2ecd3", "doc-paper": "#fffdf7",
    },
    dark: {
      page: "#19150f", surface: "#221d16", raised: "#2a241b", hover: "rgba(255, 238, 205, 0.05)",
      ink: "#efe6d3", "ink-2": "#cdbfa4", muted: "#a5967c", grid: "#362e23", axis: "#4a4033", border: "rgba(255, 238, 205, 0.11)",
      accent: "#93c49e", "accent-bg": "#24382a", "on-accent": "#19150f", brand: "#93c49e", focus: "#93c49e",
      s1: "#6b5a38", s2: "#957040", s3: "#9a9748", s4: "#76a35f", s5: "#a4d09b",
      warn: "#e0b04a", "warn-ink": "#f0c96e", "warn-bg": "#3a2f17",
      critical: "#d9705f", "critical-ink": "#f0a090", "critical-bg": "#3d211a",
      good: "#79b865", "good-ink": "#9ed48c", "good-bg": "#1f3219",
    },
  },
  {
    id: "contrast", name: "High contrast", note: "Black and white, bold lines",
    light: {
      page: "#ffffff", surface: "#ffffff", raised: "#ffffff", hover: "rgba(0, 0, 0, 0.07)",
      ink: "#000000", "ink-2": "#1c1c1c", muted: "#474747", grid: "#8c8c8c", axis: "#000000", border: "rgba(0, 0, 0, 0.6)",
      accent: "#0040c8", "accent-bg": "#dce6ff", "on-accent": "#ffffff", brand: "#0040c8", focus: "#0040c8",
      s1: "#5b93ef", s2: "#2a6fe0", s3: "#0b52c4", s4: "#063c96", s5: "#021f5e",
      warn: "#c77700", "warn-ink": "#5c3700", "warn-bg": "#ffe9c2",
      critical: "#c40000", "critical-ink": "#990000", "critical-bg": "#ffdcdc",
      good: "#007a00", "good-ink": "#004d00", "good-bg": "#d6f5d6",
    },
    dark: {
      page: "#000000", surface: "#000000", raised: "#0f0f0f", hover: "rgba(255, 255, 255, 0.1)",
      ink: "#ffffff", "ink-2": "#ececec", muted: "#bdbdbd", grid: "#808080", axis: "#ffffff", border: "rgba(255, 255, 255, 0.6)",
      accent: "#ffd60a", "accent-bg": "#3d3300", "on-accent": "#000000", brand: "#ffd60a", focus: "#ffd60a",
      s1: "#3577e0", s2: "#5c96f5", s3: "#8ab4ff", s4: "#b8d1ff", s5: "#e6efff",
      warn: "#ffb000", "warn-ink": "#ffcf5c", "warn-bg": "#3d2a00",
      critical: "#ff5555", "critical-ink": "#ff9090", "critical-bg": "#420000",
      good: "#3ddc3d", "good-ink": "#80f080", "good-bg": "#003d00",
    },
  },
];
for (const p of PRESETS) { p.light = canon(p.light); p.dark = canon(p.dark); }
const presetById = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];

// ---------------------------------------------------------------------------
// Non-color knobs
// ---------------------------------------------------------------------------
const SYSTEM_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONTS = [
  { id: "system", name: "System", stack: null, sample: SYSTEM_STACK },
  { id: "humanist", name: "Humanist", stack: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif" },
  { id: "rounded", name: "Rounded", stack: "ui-rounded, 'Avenir Next', Avenir, Montserrat, Corbel, 'URW Gothic', sans-serif" },
  { id: "serif", name: "Serif", stack: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif" },
  { id: "mono", name: "Mono", stack: "var(--font-mono)", sample: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
];
const fontById = (id) => FONTS.find((f) => f.id === id) || FONTS[0];
const DENSITY = { compact: "3px", comfortable: "4px", spacious: "5px" };
const WIDTH = { standard: "1360px", wide: "1680px", full: "100%" };
const BADGES = ["dot", "tint", "solid"];
const MODES = ["auto", "light", "dark"];

const DEFAULT_PREFS = Object.freeze({
  v: 1, preset: "default", colors: { light: {}, dark: {} },
  font: "system", size: 14, density: "comfortable", radius: 8, badge: "dot", width: "standard", reduceMotion: false,
});
const fresh = () => JSON.parse(JSON.stringify(DEFAULT_PREFS));

/**
 * Validate a settings object. Lenient mode (saved prefs) drops bad values;
 * strict mode (Import) throws with a readable message. Only whitelisted keys,
 * enums, clamped numbers and strictly parsed colors survive, because the
 * result is turned into CSS and replayed before first paint.
 */
function sanitize(raw, strict = false) {
  const out = fresh();
  const bad = (msg) => { if (strict) throw new Error(msg); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { bad("That isn't a settings object."); return out; }
  const pick = (key, ok, set) => {
    if (raw[key] === undefined) return;
    if (ok(raw[key])) set(raw[key]); else bad(`"${key}" has a value I don't recognize.`);
  };
  pick("preset", (v) => PRESETS.some((p) => p.id === v), (v) => (out.preset = v));
  pick("font", (v) => FONTS.some((f) => f.id === v), (v) => (out.font = v));
  pick("density", (v) => Object.hasOwn(DENSITY, v), (v) => (out.density = v));
  pick("width", (v) => Object.hasOwn(WIDTH, v), (v) => (out.width = v));
  pick("badge", (v) => BADGES.includes(v), (v) => (out.badge = v));
  pick("size", (v) => Number.isFinite(+v) && v !== "" && v !== null, (v) => (out.size = Math.round(Math.min(18, Math.max(12, +v)))));
  pick("radius", (v) => Number.isFinite(+v) && v !== "" && v !== null, (v) => (out.radius = Math.round(Math.min(14, Math.max(0, +v)))));
  pick("reduceMotion", (v) => typeof v === "boolean", (v) => (out.reduceMotion = v));
  if (raw.colors !== undefined) {
    if (!raw.colors || typeof raw.colors !== "object") bad('"colors" should be {light: {...}, dark: {...}}.');
    else for (const mode of ["light", "dark"]) {
      const src = raw.colors[mode];
      if (src === undefined) continue;
      if (!src || typeof src !== "object") { bad(`"colors.${mode}" should be an object.`); continue; }
      for (const [tok, val] of Object.entries(src)) {
        const c = normColor(val);
        if (!EDITABLE.has(tok)) bad(`"${tok}" isn't a color you can set.`);
        else if (!c) bad(`"${val}" isn't a color I can read (${mode} ${tok}). Use #rrggbb or rgba().`);
        else out.colors[mode][tok] = c;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
let prefs = sanitize(store.get("prefs", null));
let mode = MODES.includes(store.get("theme", "auto")) ? store.get("theme", "auto") : "auto";
const root = document.documentElement;
const darkMQ = window.matchMedia?.("(prefers-color-scheme: dark)");
const shownMode = () => (mode === "auto" ? (darkMQ?.matches ? "dark" : "light") : mode);

/** Base colors for a mode before user edits (Default + preset). */
const presetColors = (p, m) => ({ ...DEFAULTS[m], ...presetById(p.preset)[m] });

/** Final colors for a mode: Default, then preset, then edits, then derived companions. */
export function resolve(p, m) {
  const base = DEFAULTS[m], pre = presetById(p.preset)[m], ed = p.colors[m] || {};
  const v = { ...base, ...pre, ...ed };
  const explicit = new Set([...Object.keys(pre), ...Object.keys(ed)]);
  const changed = (t) => v[t] !== base[t];
  const dark = m === "dark";
  const derive = (t, fn) => { if (!explicit.has(t)) v[t] = fn(); };
  if (changed("ink")) {
    derive("hover", () => alpha(v.ink, dark ? 0.05 : 0.04));
    derive("border", () => alpha(v.ink, 0.1));
  }
  if (changed("ink") || changed("page")) derive("axis", () => mix(v.page, v.ink, dark ? 0.2 : 0.24));
  if (changed("accent")) { derive("brand", () => v.accent); derive("focus", () => v.accent); }
  if (changed("accent") || changed("surface")) derive("accent-bg", () => mix(v.surface, v.accent, dark ? 0.2 : 0.11));
  for (const s of ["warn", "critical", "good"]) {
    if (!(changed(s) || changed("surface") || changed("ink"))) continue;
    derive(`${s}-bg`, () => mix(v.surface, v[s], dark ? 0.2 : 0.13));
    derive(`${s}-ink`, () => readable(mix(v[s], v.ink, dark ? 0.3 : 0.45), v[`${s}-bg`]));
  }
  return v;
}

const decl = (o) => Object.entries(o).map(([k, val]) => `--${k}: ${val};`).join(" ");
/** The override CSS for a settings object. "" for pure Default. */
export function buildCSS(p) {
  const L = resolve(p, "light"), D = resolve(p, "dark");
  const light = {}, dark = {};
  for (const t of ALL_TOKENS) {
    const lc = L[t] !== DEFAULTS.light[t], dc = D[t] !== DEFAULTS.dark[t];
    if (lc) light[t] = L[t];
    // tokens.css doesn't redefine every token for dark (warn, critical...),
    // so a light override would leak into dark: write dark whenever either changed.
    if (lc || dc) dark[t] = D[t];
  }
  const f = fontById(p.font);
  if (f.stack) light["font-ui"] = f.stack;
  if (p.size !== 14) light["fs-base"] = `${p.size}px`;
  if (p.density !== "comfortable") light.space = DENSITY[p.density];
  if (p.radius !== 8) light.radius = `${p.radius}px`;
  if (p.width !== "standard") light["content-max"] = WIDTH[p.width];
  if (p.reduceMotion) Object.assign(light, { "dur-fast": "0ms", dur: "0ms", "dur-slow": "0ms" });
  let css = "";
  if (Object.keys(light).length) css += `:root { ${decl(light)} }\n`;
  if (Object.keys(dark).length) {
    css += `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${decl(dark)} } }\n`;
    css += `:root[data-theme="dark"] { ${decl(dark)} }\n`;
  }
  return css;
}

const ATTR_KEYS = ["badge"];
function applyTheme() {
  const css = buildCSS(prefs);
  let el = document.getElementById("jt-theme");
  if (css) {
    if (!el) { el = document.createElement("style"); el.id = "jt-theme"; }
    if (el.textContent !== css) el.textContent = css;
    if (el !== document.head.lastElementChild) document.head.appendChild(el);
  } else el?.remove();
  store.setRaw("theme-css", css || null);
  const attrs = prefs.badge !== "dot" ? { badge: prefs.badge } : {};
  for (const k of ATTR_KEYS) { if (attrs[k]) root.setAttribute(`data-${k}`, attrs[k]); else root.removeAttribute(`data-${k}`); }
  if (Object.keys(attrs).length) store.set("theme-attrs", attrs); else store.del("theme-attrs");
}
function save({ upload = true } = {}) {
  if (JSON.stringify(prefs) === JSON.stringify(DEFAULT_PREFS)) store.del("prefs"); else store.set("prefs", prefs);
  applyTheme();
  if (upload) scheduleUpload();
}

// ---- server sync ----
/** "mobile" for touch-first devices (phones), "desktop" for everything else, narrow windows included. */
export const deviceSlot = () => (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ? "mobile" : "desktop");
const SLOT = deviceSlot();
const OTHER = SLOT === "desktop" ? "mobile" : "desktop";
const SLOT_TEXT = {
  desktop: { name: "Desktop theme", where: "synced to your other computers", copy: "Copy from the phone theme" },
  mobile: { name: "Phone theme", where: "synced to your other phones", copy: "Copy from the desktop theme" },
};
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
/** The synced object, in a fixed key order so two copies compare as strings. */
function synced(p = prefs, m = mode) {
  return { v: 1, preset: p.preset, colors: { light: sortObj(p.colors.light), dark: sortObj(p.colors.dark) },
    font: p.font, size: p.size, density: p.density, radius: p.radius, badge: p.badge, width: p.width,
    reduceMotion: p.reduceMotion, mode: m };
}
/** A server value -> [prefs, mode], leniently cleaned. */
const fromServer = (o) => [sanitize(o), MODES.includes(o?.mode) ? o.mode : "auto"];

let upTimer = null, inflight = false, again = false, settleUntil = 0, deferred = false;
// "prefs-dirty" marks a local change the server hasn't accepted yet (failed
// PUT, or a reload inside the debounce). While it's set, local wins and the
// next data event retries the upload instead of applying the server copy.
function scheduleUpload() { store.set("prefs-dirty", true); clearTimeout(upTimer); upTimer = setTimeout(flush, 600); }
async function flush() {
  clearTimeout(upTimer); upTimer = null;
  if (inflight) { again = true; return; }
  const body = synced();
  const srv = state.D?.prefs?.[SLOT];
  if (srv && JSON.stringify(synced(...fromServer(srv))) === JSON.stringify(body)) { store.del("prefs-dirty"); return; }
  inflight = true;
  try {
    await api("PUT", `/api/prefs/${SLOT}`, { prefs: body });
    if (JSON.stringify(synced()) === JSON.stringify(body)) store.del("prefs-dirty");
    if (state.D?.prefs) state.D.prefs[SLOT] = body; // so the next compare sees our own save
  } catch (e) {
    toast(`Couldn't sync your theme: ${e.message}. It's still saved on this device.`);
  } finally {
    inflight = false;
    // A poll that started before the PUT can land after it with the old copy.
    settleUntil = Date.now() + 2500;
    if (again) { again = false; flush(); }
  }
}
/** Mid-edit in the dialog: typing in a box, a confirm or the import box open. */
const dialogBusy = () => !!dlg?.open && (confirmFor || ioMode || (dlg.contains(document.activeElement) && document.activeElement.matches("input:not([type=range]):not([type=checkbox]):not([type=color]), textarea")));
function onData() {
  if (dlg?.open) refreshSlot();
  const srv = state.D?.prefs?.[SLOT];
  if (!srv || typeof srv !== "object") return;          // nothing on the server yet: keep local
  if (upTimer || inflight || Date.now() < settleUntil) return; // our own newer edits win
  if (store.get("prefs-dirty", false)) { flush(); return; }   // unsynced local change: push it
  const [p, m] = fromServer(srv);
  if (JSON.stringify(synced(p, m)) === JSON.stringify(synced())) return;
  if (dialogBusy()) { deferred = true; return; }
  deferred = false;
  prefs = p;
  save({ upload: false });
  setMode(m, { upload: false });
  if (dlg?.open) refresh({ cards: true, colors: true });
}

// ---- color mode ----
const MODE_ICONS = {
  light: '<svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>',
  dark: '<svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z"/></svg>',
  auto: '<svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path class="ico-fill" d="M8 2.5a5.5 5.5 0 0 1 0 11z"/></svg>',
};
const MODE_LABEL = { auto: "Auto", light: "Light", dark: "Dark" };
function renderModeBtn() {
  const b = document.getElementById("mode-btn");
  if (!b) return;
  b.innerHTML = MODE_ICONS[mode];
  b.setAttribute("aria-label", `Color mode: ${mode}`);
  b.title = `Color mode: ${MODE_LABEL[mode]}${mode === "auto" ? " (follows your system)" : ""}`;
}
function setMode(m, { upload = true } = {}) {
  const was = mode;
  mode = MODES.includes(m) ? m : "auto";
  store.set("theme", mode);
  if (upload && was !== mode) scheduleUpload();
  if (mode === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", mode);
  renderModeBtn();
  if (dlg?.open) refresh({ cards: true });
}

export function init() {
  setMode(mode, { upload: false });
  applyTheme();
  on("data", onData);
  darkMQ?.addEventListener?.("change", () => { if (dlg?.open && mode === "auto") refresh({ cards: true }); });
}
export function cycleMode() {
  setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  flush(); // one click, no need to wait out the debounce
  toast(`Color mode: ${MODE_LABEL[mode]}${mode === "auto" ? " (follows your system)" : ""}`, { ms: 1600 });
}

// ---------------------------------------------------------------------------
// Customizer dialog
// ---------------------------------------------------------------------------
let dlg = null, opener = null;
let editMode = "light";        // which mode the Colors section edits
let confirmFor = null;          // pending inline confirm: {kind: "preset", id} | {kind: "reset"}
let ioMode = null;              // null | "export" | "import"

const hasColorEdits = () => Object.keys(prefs.colors.light).length + Object.keys(prefs.colors.dark).length > 0;
const segBtn = (k, v, label, on, extra = "") =>
  `<button type="button" data-k="${k}" data-v="${esc(v)}" aria-pressed="${on}"${extra}>${label}</button>`;

function presetCard(p) {
  const m = shownMode();
  const c = { ...DEFAULTS[m], ...p[m] };
  const f = fontById(p.font || "system");
  const font = f.sample || f.stack;
  const dots = [1, 2, 3, 4, 5].map((n) => `<i style="background:${c[`s${n}`]}"></i>`).join("");
  return `<button type="button" class="pf-card" data-preset="${p.id}" aria-pressed="false">
    <span class="pf-prev" style="background:${c.page}">
      <span class="pf-prev-card" style="background:${c.surface};border-color:${c.border};color:${c.ink}">
        <span class="pf-aa" style="font-family:${esc(font)}">Aa</span>
        <span class="pf-lines"><span style="background:${c.ink}"></span><span style="background:${c.muted}"></span></span>
      </span>
      <span class="pf-prev-foot"><span class="pf-dots">${dots}</span><span class="pf-acc" style="background:${c.accent}"></span></span>
    </span>
    <span class="pf-card-label"><span class="pf-card-name">${esc(p.name)}</span><span class="pf-card-note">${esc(p.note)}</span></span>
    <span class="pf-check" aria-hidden="true"><svg class="ico" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg></span>
  </button>`;
}

function colorRows() {
  const v = resolve(prefs, editMode);
  return GROUPS.map((g) => `<div class="pf-group" role="group" aria-label="${g.name}">
    <div class="pf-group-h">${g.name}</div>
    ${g.rows.map(([tok, label]) => {
      const name = typeof label === "function" ? label() : label;
      const id = `pf-c-${tok}`;
      return `<div class="pf-row" data-tok="${tok}">
        <label for="${id}" class="pf-row-label">${esc(name)}</label>
        <span class="pf-sw"><input type="color" id="${id}-sw" data-color="${tok}" value="${toHex(parseColor(v[tok]))}" aria-label="${esc(name)} color picker" tabindex="-1"></span>
        <input class="input pf-hex tnum" id="${id}" data-hex="${tok}" value="${esc(v[tok])}" spellcheck="false" autocomplete="off" aria-describedby="pf-hex-help">
        <button type="button" class="btn ghost icon sm pf-reset" data-reset="${tok}" title="Back to the theme's color" aria-label="Reset ${esc(name)}">
          <svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M4.5 1.8v2.7h2.7"/></svg>
        </button>
      </div>`;
    }).join("")}
  </div>`).join("");
}

function render() {
  dlg.innerHTML = `
  <div class="dlg-head">
    <div class="pf-title"><h2 id="pf-title">Appearance</h2>
      <p class="pf-slot" id="pf-slot"><strong>${SLOT_TEXT[SLOT].name}</strong> <span aria-hidden="true">·</span> ${SLOT_TEXT[SLOT].where}</p></div>
    <button type="button" class="btn ghost icon" data-act="close" aria-label="Close">
      <svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>
    </button>
  </div>
  <div class="dlg-body pf-body">
    <section class="pf-sec" aria-labelledby="pf-h-theme">
      <div class="pf-sec-h">
        <h3 class="pf-h" id="pf-h-theme">Theme</h3>
        <span class="spacer"></span>
        <button type="button" class="btn sm" data-act="copy-other" id="pf-copy">${SLOT_TEXT[SLOT].copy}</button>
      </div>
      <div class="pf-presets">${PRESETS.map(presetCard).join("")}</div>
      <div class="pf-confirm" id="pf-confirm-preset" hidden></div>
    </section>

    <section class="pf-sec" aria-labelledby="pf-h-mode">
      <h3 class="pf-h" id="pf-h-mode">Mode</h3>
      <div class="seg" role="group" aria-labelledby="pf-h-mode">
        ${MODES.map((m) => segBtn("mode", m, `${MODE_ICONS[m]}<span>${MODE_LABEL[m]}</span>`, false, ' class="pf-ico-btn"')).join("")}
      </div>
    </section>

    <section class="pf-sec" aria-labelledby="pf-h-colors">
      <div class="pf-sec-h">
        <h3 class="pf-h" id="pf-h-colors">Colors</h3>
        <span class="pf-edited" id="pf-edited" hidden><span class="tag accent">Edited</span></span>
        <span class="spacer"></span>
        <span class="pf-editing" id="pf-editing-l">Editing</span>
        <div class="seg" role="group" aria-labelledby="pf-editing-l">
          ${segBtn("edit", "light", "Light", false)}${segBtn("edit", "dark", "Dark", false)}
        </div>
      </div>
      <p class="pf-hint muted" id="pf-edit-hint" hidden></p>
      <div class="pf-warns" id="pf-warns" aria-live="polite"></div>
      <div class="pf-groups" id="pf-groups">${colorRows()}</div>
      <p class="pf-hint muted" id="pf-hex-help">Type #rgb, #rrggbb or rgba(r, g, b, a). Changes show as you type.</p>
    </section>

    <section class="pf-sec" aria-labelledby="pf-h-type">
      <h3 class="pf-h" id="pf-h-type">Type</h3>
      <div class="pf-field">
        <span class="pf-label" id="pf-font-l">Font</span>
        <div class="seg pf-fonts" role="group" aria-labelledby="pf-font-l">
          ${FONTS.map((f) => segBtn("font", f.id, esc(f.name), false, ` style="font-family:${esc(f.sample || f.stack)}"`)).join("")}
        </div>
      </div>
      <div class="pf-field">
        <label class="pf-label" for="pf-size">Text size <output class="pf-out tnum" id="pf-size-out" for="pf-size"></output></label>
        <div class="pf-range"><span class="pf-a-sm" aria-hidden="true">A</span><input type="range" id="pf-size" data-range="size" min="12" max="18" step="1"><span class="pf-a-lg" aria-hidden="true">A</span></div>
      </div>
    </section>

    <section class="pf-sec" aria-labelledby="pf-h-layout">
      <h3 class="pf-h" id="pf-h-layout">Layout</h3>
      <div class="pf-grid2">
        <div class="pf-field">
          <span class="pf-label" id="pf-density-l">Density</span>
          <div class="seg" role="group" aria-labelledby="pf-density-l">
            ${segBtn("density", "compact", "Compact", false)}${segBtn("density", "comfortable", "Comfortable", false)}${segBtn("density", "spacious", "Spacious", false)}
          </div>
        </div>
        <div class="pf-field">
          <span class="pf-label" id="pf-width-l">Content width</span>
          <div class="seg" role="group" aria-labelledby="pf-width-l">
            ${segBtn("width", "standard", "Standard", false)}${segBtn("width", "wide", "Wide", false)}${segBtn("width", "full", "Full", false)}
          </div>
        </div>
        <div class="pf-field">
          <label class="pf-label" for="pf-radius">Corner radius <output class="pf-out tnum" id="pf-radius-out" for="pf-radius"></output></label>
          <div class="pf-range"><span class="pf-corner sq" aria-hidden="true"></span><input type="range" id="pf-radius" data-range="radius" min="0" max="14" step="1"><span class="pf-corner rd" aria-hidden="true"></span></div>
        </div>
        <div class="pf-field">
          <span class="pf-label" id="pf-badge-l">Stage badges</span>
          <div class="seg pf-badges" role="group" aria-labelledby="pf-badge-l">
            ${BADGES.map((b) => segBtn("badge", b, `<span class="pf-mb pf-mb-${b}"><i></i>${b === "dot" ? "Dot" : b === "tint" ? "Tint" : "Strong"}</span>`, false)).join("")}
          </div>
        </div>
      </div>
      <label class="pf-check-row"><input type="checkbox" id="pf-motion" data-check="reduceMotion"><span>Reduce motion <span class="muted">(no slide or fade animations)</span></span></label>
    </section>

    <section class="pf-sec pf-io" id="pf-io" hidden aria-labelledby="pf-io-h">
      <h3 class="pf-h" id="pf-io-h"></h3>
      <p class="pf-hint muted" id="pf-io-help"></p>
      <textarea class="textarea pf-io-text" id="pf-io-text" spellcheck="false" aria-labelledby="pf-io-h"></textarea>
      <div class="pf-io-foot"><span class="form-msg" id="pf-io-msg" role="status"></span><span class="spacer"></span>
        <button type="button" class="btn sm" data-act="io-cancel">Close</button>
        <button type="button" class="btn sm primary" data-act="io-apply" id="pf-io-apply">Apply</button></div>
    </section>
  </div>
  <div class="dlg-foot pf-foot">
    <p class="pf-note muted">Export saves a backup you can Import later.</p>
    <div class="pf-foot-btns" id="pf-foot-btns">
      <button type="button" class="btn ghost" data-act="reset">Reset all</button>
      <button type="button" class="btn" data-act="export">Export</button>
      <button type="button" class="btn" data-act="import">Import</button>
      <button type="button" class="btn primary" data-act="close">Done</button>
    </div>
    <div class="pf-confirm" id="pf-confirm-reset" hidden></div>
  </div>`;
  refresh();
}

function refreshSlot() {
  const b = dlg?.querySelector("#pf-copy");
  if (!b) return;
  const has = !!state.D?.prefs?.[OTHER];
  b.disabled = !has;
  b.title = has ? "Use the same settings here" : `No ${OTHER === "mobile" ? "phone" : "desktop"} theme saved yet`;
}

/** Bring every control in line with prefs, without rebuilding anything that has focus. */
function refresh({ cards = false, colors = false } = {}) {
  if (!dlg) return;
  const focused = document.activeElement;
  if (cards) {
    const wrap = dlg.querySelector(".pf-presets");
    const had = focused?.dataset?.preset;
    wrap.innerHTML = PRESETS.map(presetCard).join("");
    if (had) wrap.querySelector(`[data-preset="${had}"]`)?.focus();
  }
  if (colors) {
    const had = focused?.dataset?.hex || focused?.dataset?.reset;
    const which = focused?.dataset?.hex ? "hex" : "reset";
    dlg.querySelector("#pf-groups").innerHTML = colorRows();
    if (had) (dlg.querySelector(`[data-${which}="${had}"]`) || dlg.querySelector(`[data-hex="${had}"]`))?.focus();
  }
  const edited = hasColorEdits();
  for (const c of dlg.querySelectorAll(".pf-card")) {
    const on = c.dataset.preset === prefs.preset;
    c.setAttribute("aria-pressed", on);
    c.querySelector(".pf-card-note").textContent = on && edited ? "Edited by you" : presetById(c.dataset.preset).note;
  }
  const val = { mode, edit: editMode, font: prefs.font, density: prefs.density, width: prefs.width, badge: prefs.badge };
  for (const b of dlg.querySelectorAll("button[data-k]")) b.setAttribute("aria-pressed", String(val[b.dataset.k] === b.dataset.v));
  for (const r of dlg.querySelectorAll("input[data-range]")) {
    const k = r.dataset.range;
    if (r !== focused) r.value = prefs[k];
    dlg.querySelector(`#pf-${k}-out`).textContent = `${prefs[k]}px`;
  }
  const motion = dlg.querySelector("#pf-motion"); motion.checked = prefs.reduceMotion;
  dlg.querySelector("#pf-edited").hidden = !edited;
  const hint = dlg.querySelector("#pf-edit-hint");
  const shown = shownMode();
  hint.hidden = shown === editMode;
  hint.innerHTML = shown === editMode ? "" : `You're looking at ${shown} mode, so these ${editMode} colors won't show until you switch. <button type="button" class="linkbtn" data-act="preview-mode">Show ${editMode} mode</button>`;
  // color rows
  const v = resolve(prefs, editMode), base = presetColors(prefs, editMode);
  for (const row of dlg.querySelectorAll(".pf-row")) {
    const t = row.dataset.tok;
    const hex = row.querySelector("[data-hex]"), sw = row.querySelector("[data-color]");
    if (hex !== focused) { hex.value = v[t]; hex.removeAttribute("aria-invalid"); }
    sw.value = toHex(parseColor(v[t]));
    sw.parentElement.style.background = v[t];
    const custom = Object.hasOwn(prefs.colors[editMode], t) && prefs.colors[editMode][t] !== base[t];
    row.classList.toggle("is-custom", custom);
    row.querySelector("[data-reset]").hidden = !custom;
  }
  renderWarnings(v);
  refreshSlot();
}

const PAIRS = [
  ["ink", "page", "Text on page"], ["ink", "surface", "Text on surface"], ["ink-2", "surface", "Secondary text on surface"],
  ["muted", "surface", "Muted text on surface", 3], ["on-accent", "accent", "Text on accent"], ["accent", "surface", "Accent on surface"],
];
export function contrastReport(v) {
  return PAIRS.map(([fg, bg, label, soft]) => {
    const r = contrast(v[fg], v[bg]);
    const level = r >= 4.5 ? "ok" : soft && r >= soft ? "low" : "fail";
    return { fg, bg, label, ratio: r, level };
  });
}
function renderWarnings(v) {
  const box = dlg.querySelector("#pf-warns");
  const bad = contrastReport(v).filter((x) => x.level !== "ok");
  const html = bad.length
    ? `<span class="pf-warn-lead">Hard to read in ${editMode} mode:</span> ${bad.map((x) => `<span class="tag warn" title="WCAG AA asks for 4.5:1">${esc(x.label)} ${x.ratio.toFixed(1)}:1 ${x.level === "low" ? "(low)" : "(fails)"}</span>`).join(" ")}`
    : `<span class="tag good">Text contrast passes WCAG AA in ${editMode} mode</span>`;
  if (box._html !== html) { box._html = html; box.innerHTML = html; } // live region: only speak real changes
}

// ---- edits ----
function setColor(tok, value) {
  const c = normColor(value);
  if (!c) return false;
  const base = presetColors(prefs, editMode)[tok];
  if (c === base) delete prefs.colors[editMode][tok]; else prefs.colors[editMode][tok] = c;
  save(); refresh();
  return true;
}
function pickPreset(id) {
  const p = presetById(id);
  prefs.preset = p.id;
  prefs.colors = { light: {}, dark: {} };
  prefs.font = p.font || "system";
  prefs.badge = p.badge || "dot";
  confirmFor = null; showConfirm();
  save(); refresh({ cards: false });
}
function showConfirm() {
  const pBox = dlg.querySelector("#pf-confirm-preset"), rBox = dlg.querySelector("#pf-confirm-reset"), btns = dlg.querySelector("#pf-foot-btns");
  pBox.hidden = !["preset", "copy"].includes(confirmFor?.kind);
  rBox.hidden = confirmFor?.kind !== "reset";
  btns.hidden = confirmFor?.kind === "reset";
  if (confirmFor?.kind === "preset") {
    pBox.innerHTML = `<span>Switching to ${esc(presetById(confirmFor.id).name)} drops your color edits.</span>
      <button type="button" class="btn sm primary" data-act="confirm-yes">Switch</button><button type="button" class="btn sm" data-act="confirm-no">Keep my edits</button>`;
    pBox.querySelector('[data-act="confirm-yes"]').focus();
  }
  if (confirmFor?.kind === "copy") {
    const other = OTHER === "mobile" ? "phone" : "desktop";
    pBox.innerHTML = `<span>Replace this ${SLOT === "mobile" ? "phone" : "desktop"} theme with the ${other} one? Colors, type, layout and mode all change.</span>
      <button type="button" class="btn sm primary" data-act="confirm-yes">Copy</button><button type="button" class="btn sm" data-act="confirm-no">Cancel</button>`;
    pBox.querySelector('[data-act="confirm-yes"]').focus();
  }
  if (confirmFor?.kind === "reset") {
    rBox.innerHTML = `<span>Reset theme, colors, type and layout to Default?</span>
      <button type="button" class="btn sm danger" data-act="confirm-yes">Reset all</button><button type="button" class="btn sm" data-act="confirm-no">Cancel</button>`;
    rBox.querySelector('[data-act="confirm-yes"]').focus();
  }
}

function exportJSON() { return JSON.stringify({ ...prefs, mode }, null, 2); }
function showIO(kind, msg = "") {
  ioMode = kind;
  const box = dlg.querySelector("#pf-io");
  box.hidden = !kind;
  if (!kind) return;
  const ta = box.querySelector("#pf-io-text");
  box.querySelector("#pf-io-h").textContent = kind === "export" ? "Export" : "Import";
  box.querySelector("#pf-io-help").textContent = kind === "export"
    ? "Paste this into Import on your other device."
    : "Paste settings you exported, then Apply.";
  box.querySelector("#pf-io-apply").hidden = kind !== "import";
  ta.readOnly = kind === "export";
  ta.value = kind === "export" ? exportJSON() : "";
  const m = box.querySelector("#pf-io-msg");
  m.textContent = msg; m.classList.toggle("ok", kind === "export");
  box.scrollIntoView({ block: "nearest", behavior: prefs.reduceMotion ? "auto" : "smooth" });
  if (kind === "export") { ta.focus(); ta.select(); } else ta.focus();
}
async function doExport() {
  let msg = "Copied to your clipboard.";
  try { await navigator.clipboard.writeText(exportJSON()); } catch { msg = "Couldn't reach the clipboard. Select the text and copy it."; }
  showIO("export", msg);
}
function doImport() {
  const ta = dlg.querySelector("#pf-io-text"), m = dlg.querySelector("#pf-io-msg");
  m.classList.remove("ok");
  let raw;
  try { raw = JSON.parse(ta.value); } catch { m.textContent = "That isn't valid JSON. Paste the whole export, braces included."; return; }
  try {
    const next = sanitize(raw, true);
    if (raw.mode !== undefined && !MODES.includes(raw.mode)) throw new Error('"mode" should be auto, light or dark.');
    prefs = next;
    if (raw.mode) setMode(raw.mode);
    save();
    showIO(null);
    refresh({ cards: true, colors: true });
    dlg.querySelector('[data-act="import"]').focus();
    flash("Imported.");
  } catch (e) { m.textContent = e.message; }
}
function flash(text) {
  const n = dlg.querySelector(".pf-note");
  const was = "Export saves a backup you can Import later.";
  n.textContent = text; n.classList.add("pf-flash");
  clearTimeout(flash.t); flash.t = setTimeout(() => { n.textContent = was; n.classList.remove("pf-flash"); }, 2500);
}

function onClick(e) {
  const t = e.target.closest("button, [data-act]");
  if (!t || !dlg.contains(t)) return;
  const act = t.dataset.act;
  if (t.dataset.preset) {
    const id = t.dataset.preset;
    if (id === prefs.preset && !hasColorEdits()) return;
    if (hasColorEdits()) { confirmFor = { kind: "preset", id }; showConfirm(); } else pickPreset(id);
    return;
  }
  if (t.dataset.k) {
    const { k, v } = t.dataset;
    if (k === "mode") setMode(v);
    else if (k === "edit") { editMode = v; refresh(); }
    else { prefs[k] = v; save(); refresh(); }
    return;
  }
  if (t.dataset.reset) {
    delete prefs.colors[editMode][t.dataset.reset];
    save(); refresh();
    dlg.querySelector(`[data-hex="${t.dataset.reset}"]`)?.focus();
    return;
  }
  switch (act) {
    case "close": dlg.close(); break;
    case "preview-mode": setMode(editMode); break;
    case "confirm-yes":
      if (confirmFor?.kind === "copy") {
        const src = state.D?.prefs?.[OTHER];
        confirmFor = null; showConfirm();
        if (src) {
          const [p, m] = fromServer(src);
          prefs = p; save(); setMode(m);
          refresh({ cards: true, colors: true }); flash(`Copied the ${OTHER === "mobile" ? "phone" : "desktop"} theme.`);
        }
        dlg.querySelector("#pf-copy")?.focus();
      } else if (confirmFor?.kind === "preset") { const id = confirmFor.id; pickPreset(id); dlg.querySelector(`[data-preset="${id}"]`)?.focus(); }
      else if (confirmFor?.kind === "reset") {
        prefs = fresh(); confirmFor = null; showConfirm(); save(); setMode("auto");
        refresh({ cards: true, colors: true }); dlg.querySelector('[data-act="reset"]').focus(); flash("Back to Default.");
      }
      break;
    case "confirm-no": {
      const back = { preset: `[data-preset="${prefs.preset}"]`, copy: "#pf-copy" }[confirmFor?.kind] || '[data-act="reset"]';
      confirmFor = null; showConfirm(); dlg.querySelector(back)?.focus(); break;
    }
    case "copy-other": confirmFor = { kind: "copy" }; showConfirm(); break;
    case "reset": confirmFor = { kind: "reset" }; showConfirm(); break;
    case "export": doExport(); break;
    case "import": showIO("import"); break;
    case "io-cancel": showIO(null); dlg.querySelector('[data-act="export"]').focus(); break;
    case "io-apply": doImport(); break;
  }
}
function onInput(e) {
  const t = e.target;
  if (t.dataset.hex) {
    const ok = normColor(t.value);
    if (ok) t.removeAttribute("aria-invalid"); else t.setAttribute("aria-invalid", "true");
    if (ok) setColor(t.dataset.hex, t.value);
  } else if (t.dataset.color) {
    // The native picker has no alpha: keep the token's alpha when it had one.
    const tok = t.dataset.color, cur = parseColor(resolve(prefs, editMode)[tok]), pick = parseColor(t.value);
    setColor(tok, fmtColor({ ...pick, a: cur.a }));
  } else if (t.dataset.range) {
    prefs[t.dataset.range] = Math.round(+t.value); save(); refresh();
  } else if (t.dataset.check) {
    prefs[t.dataset.check] = t.checked; save(); refresh();
  }
}
function onChange(e) {
  // Leaving a half-typed hex box: show the real value again.
  if (e.target.dataset.hex) { e.target.removeAttribute("aria-invalid"); refresh(); }
}

export function open() {
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "dlg pf-sheet";
    dlg.setAttribute("aria-labelledby", "pf-title");
    // Close on a backdrop click only when the press also started there (not a text drag out of a box).
    let downOnBackdrop = false;
    dlg.addEventListener("mousedown", (e) => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) { if (downOnBackdrop) dlg.close(); } else onClick(e); });
    dlg.addEventListener("input", onInput);
    dlg.addEventListener("change", onChange);
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && confirmFor) { e.preventDefault(); confirmFor = null; showConfirm(); }
      else if (e.key === "Escape" && ioMode) { e.preventDefault(); showIO(null); }
    });
    dlg.addEventListener("close", () => {
      confirmFor = null; ioMode = null; opener?.focus?.(); opener = null;
      if (upTimer) flush();
      if (deferred) onData();
    });
    document.body.append(dlg);
  }
  if (dlg.open) return;
  opener = document.activeElement;
  editMode = shownMode();
  confirmFor = null; ioMode = null;
  render();
  dlg.showModal();
  (dlg.querySelector(".pf-card[aria-pressed=true]") || dlg.querySelector(".pf-card"))?.focus();
}
