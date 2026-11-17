// Pure formatting helpers. No DOM, no state.
export const DAY = 864e5;
export const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Midnight today, local time. Recomputed on every call so a tab left open overnight stays right. */
export const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/** "2026-11-20", "2026-11" or any text containing one -> Date at local midnight, or null. */
export const parse = (s) => {
  const m = String(s || "").match(/(\d{4})-(\d{2})(?:-(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +(m[3] || 1)) : null;
};
export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (n, from = today()) => { const d = new Date(from); d.setDate(d.getDate() + n); return d; };
export const daysSince = (s) => { const d = parse(s); return d ? Math.round((today() - d) / DAY) : null; };

/** "Nov 20", or "Nov 20, 2025" outside this year, or "Nov 2026" for a month-only value. */
export const fmt = (s) => {
  const d = parse(s); if (!d) return s || "";
  const t = today();
  return d.toLocaleDateString("en-US", String(s).match(/\d{4}-\d{2}-\d{2}/)
    ? { month: "short", day: "numeric", year: d.getFullYear() === t.getFullYear() ? undefined : "numeric" }
    : { month: "short", year: "numeric" });
};

/** Relative label for a date: "Today", "Tomorrow", "Yesterday", "Fri", "in 9d", "3d ago". */
export const rel = (s) => {
  const n = daysSince(s); if (n === null) return "";
  if (n === 0) return "Today";
  if (n === -1) return "Tomorrow";
  if (n === 1) return "Yesterday";
  if (n < 0 && n > -7) return parse(s).toLocaleDateString("en-US", { weekday: "short" });
  return n < 0 ? `in ${-n}d` : `${n}d ago`;
};

/** Replace the first YYYY-MM-DD in text with a new date, or append " by <date>". */
export const withDate = (text, date, fallback = "Follow up") => {
  const t = String(text || "").trim();
  if (!date) return t.replace(/\s*(by\s+)?\d{4}-\d{2}-\d{2}(\s+\d{1,2}:\d{2}(\s*[A-Z]{2,4})?)?/, "").trim();
  return DATE_RE.test(t) ? t.replace(/\d{4}-\d{2}-\d{2}/, date) : `${t || fallback} by ${date}`;
};

/** The first YYYY-MM-DD in a string, or "". */
export const dateIn = (text) => (String(text || "").match(DATE_RE) || [""])[0];

export const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;
