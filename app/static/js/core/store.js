// localStorage wrapper. Per-device conveniences only; it can be empty or throw
// (private windows, blocked storage), so every call is guarded.
const P = "jt-";
export const store = {
  get(k, def) { try { const v = localStorage.getItem(P + k); return v === null ? def : JSON.parse(v) ?? def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch {} },
  raw(k) { try { return localStorage.getItem(P + k); } catch { return null; } },
  setRaw(k, v) { try { if (v === null) localStorage.removeItem(P + k); else localStorage.setItem(P + k, v); } catch {} },
  del(k) { try { localStorage.removeItem(P + k); } catch {} },
};
