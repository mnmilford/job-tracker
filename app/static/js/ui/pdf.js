// In-app PDF viewer. Renders with PDF.js (vendored in /static/vendor/pdfjs,
// loaded on first use) so it looks the same on desktop and phones; Android
// browsers can't show a PDF inline on their own. Files come through
// /api/applications/<id>/files/<name>, read live from the GitHub branch.
import { fetchBytes, SignedOut } from "../core/api.js";

let dlg, titleEl, metaEl, bodyEl, msgEl, openEl, dlEl;
let lib = null;
let run = 0;   // bumps on every open/close, so a stale render stops drawing

const svg = (d) => `<svg class="ico" aria-hidden="true" viewBox="0 0 16 16">${d}</svg>`;

function ensure() {
  if (dlg) return;
  dlg = document.createElement("dialog");
  dlg.className = "dlg pdf-dlg";
  dlg.setAttribute("aria-labelledby", "pdf-title");
  dlg.innerHTML = `
    <div class="pdf-head">
      <div class="pdf-titles">
        <h2 id="pdf-title" class="ellipsis">Document</h2>
        <span class="pdf-meta muted tnum" aria-live="polite"></span>
      </div>
      <div class="pdf-actions">
        <a class="btn sm ghost" id="pdf-open" target="_blank" rel="noopener" aria-label="Open in new tab" title="Open in new tab">${svg('<path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5"/>')}<span>Open in new tab</span></a>
        <a class="btn sm ghost" id="pdf-download" aria-label="Download" title="Download">${svg('<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>')}<span>Download</span></a>
        <button class="btn sm" type="button" id="pdf-close">Close</button>
      </div>
    </div>
    <div class="pdf-body" tabindex="0" aria-label="Document pages"><div class="pdf-msg" role="status">Loading…</div></div>`;
  document.body.append(dlg);
  titleEl = dlg.querySelector("#pdf-title");
  metaEl = dlg.querySelector(".pdf-meta");
  bodyEl = dlg.querySelector(".pdf-body");
  msgEl = dlg.querySelector(".pdf-msg");
  openEl = dlg.querySelector("#pdf-open");
  dlEl = dlg.querySelector("#pdf-download");
  dlg.querySelector("#pdf-close").addEventListener("click", () => dlg.close());
  // Click on the backdrop (the dialog box itself, outside its content) closes.
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => { run++; clear(); });
}

function clear() { bodyEl.querySelectorAll(".pdf-page").forEach((c) => c.remove()); metaEl.textContent = ""; }
function say(text, error = false) { msgEl.hidden = false; msgEl.textContent = text; msgEl.classList.toggle("err", error); }

async function pdfjs() {
  if (!lib) {
    lib = await import("/static/vendor/pdfjs/pdf.min.js");
    lib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdfjs/pdf.worker.min.js";
  }
  return lib;
}

/** Open a PDF from an application's folder in the viewer. */
export async function open(appId, name) {
  ensure();
  const id = ++run;
  const url = `/api/applications/${encodeURIComponent(appId)}/files/${encodeURIComponent(name)}`;
  const title = name.replace(/\.pdf$/i, "").replace(/_/g, " ");
  titleEl.textContent = title;
  titleEl.title = name;
  openEl.href = url;
  dlEl.href = `${url}?download=1`;
  clear();
  say("Loading…");
  if (!dlg.open) dlg.showModal();
  dlg.querySelector("#pdf-close").focus();
  try {
    const data = await fetchBytes(url);
    const L = await pdfjs();
    if (id !== run) return;
    const doc = await L.getDocument({ data }).promise;
    if (id !== run) { doc.destroy(); return; }
    msgEl.hidden = true;
    metaEl.textContent = doc.numPages === 1 ? "1 page" : `${doc.numPages} pages`;
    const cs = getComputedStyle(bodyEl);
    const room = bodyEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const width = Math.max(240, Math.min(room, 860));
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (id !== run) { doc.destroy(); return; }
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * dpr });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `${title}, page ${n} of ${doc.numPages}`);
      bodyEl.append(canvas);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    }
  } catch (err) {
    if (id !== run) return;
    clear();
    say(err instanceof SignedOut ? err.message : `Couldn't show this file. ${err.message}`, true);
  }
}

export const isOpen = () => !!dlg?.open;
