// Toasts: one at a time, bottom center, optional action button (Undo).
let current = null;
export function toast(text, { action, onAction, ms = 4000 } = {}) {
  current?.remove();
  const t = document.createElement("div");
  t.className = "toast"; t.setAttribute("role", "status");
  t.append(document.createTextNode(text));
  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "toast-action"; b.textContent = action;
    b.onclick = async () => { t.remove(); try { await onAction(); } catch (e) { toast(e.message); } };
    t.append(b);
  }
  document.body.append(t);
  current = t;
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 300); }, action ? ms + 2000 : ms);
}
