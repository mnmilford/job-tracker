// Quick add: the "New application" dialog. Built for speed: type the company,
// Tab, the role, Enter. Everything else is optional and tucked under "More".
import { select } from "../core/state.js";
import { create } from "../core/actions.js";
import { esc, iso, today, withDate, dateIn } from "../core/format.js";

const STATUSES = ["Drafting", "Applied", "Recruiter screen", "Interviewing"];
const DEFAULT_STATUS = "Applied";

let dlg, form, msg, submitBtn, status = DEFAULT_STATUS, busy = false;

export function init() {
  dlg = document.createElement("dialog");
  dlg.className = "dlg qa-dlg";
  dlg.setAttribute("aria-labelledby", "qa-title");
  dlg.innerHTML = `
    <form novalidate>
      <div class="dlg-head">
        <h2 id="qa-title">New application</h2>
        <button class="btn icon ghost sm" type="button" data-close aria-label="Close" title="Close (Esc)"><svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
      </div>
      <div class="dlg-body">
        <div class="field">
          <label for="qa-company">Company</label>
          <input class="input" id="qa-company" name="company" autocomplete="off" required aria-required="true" aria-describedby="qa-msg">
        </div>
        <div class="field">
          <label for="qa-role">Role</label>
          <input class="input" id="qa-role" name="role" autocomplete="off">
        </div>
        <div class="field">
          <label for="qa-url">Posting URL</label>
          <input class="input" id="qa-url" name="posting_url" type="url" placeholder="https://" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <span class="label" id="qa-status-l">Status</span>
          <div class="seg qa-seg" role="group" aria-labelledby="qa-status-l">
            ${STATUSES.map((s) => `<button type="button" data-status="${esc(s)}" aria-pressed="false">${esc(s)}</button>`).join("")}
          </div>
        </div>
        <div class="field">
          <label for="qa-next">Next step</label>
          <div class="qa-next">
            <input class="input" id="qa-next" name="next" autocomplete="off" placeholder="Follow up with the recruiter">
            <input class="input qa-date" type="date" name="nextDate" aria-label="Next step date">
          </div>
        </div>
        <details class="qa-more">
          <summary>More</summary>
          <div class="qa-more-body">
            <div class="field-row">
              <div class="field"><label for="qa-comp">Comp</label><input class="input" id="qa-comp" name="comp" autocomplete="off" placeholder="$120–140K"></div>
              <div class="field"><label for="qa-source">Source</label><input class="input" id="qa-source" name="source" autocomplete="off" placeholder="LinkedIn, referral…"></div>
            </div>
            <div class="field qa-date-field">
              <label for="qa-date">Date</label>
              <input class="input qa-date" type="date" id="qa-date" name="date">
              <span class="help">When you found it or applied. Stamps the status.</span>
            </div>
            <div class="field">
              <label for="qa-note">Note</label>
              <textarea class="textarea" id="qa-note" name="note" rows="2" placeholder="Anything worth remembering"></textarea>
            </div>
          </div>
        </details>
      </div>
      <div class="dlg-foot">
        <span class="form-msg" id="qa-msg" role="alert"></span>
        <span class="qa-hint muted"><kbd class="kbd">↵</kbd> to add</span>
        <button class="btn ghost" type="button" data-close>Cancel</button>
        <button class="btn primary" type="submit">Add application</button>
      </div>
    </form>`;
  document.body.append(dlg);
  form = dlg.querySelector("form");
  msg = dlg.querySelector("#qa-msg");
  submitBtn = dlg.querySelector('[type="submit"]');

  for (const b of dlg.querySelectorAll("[data-close]")) b.addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.querySelector(".qa-seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-status]");
    if (b) setStatus(b.dataset.status);
  });
  form.addEventListener("input", (e) => {
    const t = e.target;
    if (t.name === "next") form.nextDate.value = dateIn(t.value);
    if (t.name === "nextDate") form.next.value = withDate(form.next.value, t.value);
    if (t.name === "company" && t.value.trim()) { msg.textContent = ""; t.removeAttribute("aria-invalid"); }
  });
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
}

function setStatus(s) {
  status = s;
  for (const b of dlg.querySelectorAll("[data-status]")) b.setAttribute("aria-pressed", String(b.dataset.status === s));
}

export function open() {
  if (!dlg) init();
  if (dlg.open) { form.company.focus(); return; }
  form.reset();
  setStatus(DEFAULT_STATUS);
  form.date.value = iso(today());
  dlg.querySelector(".qa-more").open = false;
  msg.textContent = "";
  form.company.removeAttribute("aria-invalid");
  submitBtn.disabled = false;
  busy = false;
  dlg.showModal();
  form.company.focus();
}

async function submit() {
  if (busy) return;
  const v = (n) => form[n].value.trim();
  const company = v("company");
  if (!company) {
    msg.textContent = "Add a company name.";
    form.company.setAttribute("aria-invalid", "true");
    form.company.focus();
    return;
  }
  const date = form.date.value || iso(today());
  const body = { company, status, date, found: date };
  if (v("next")) body.next_step = v("next");   // the date input already wrote its date into the text
  for (const [name, key] of [["role", "role"], ["posting_url", "posting_url"], ["comp", "comp"], ["source", "source"]]) if (v(name)) body[key] = v(name);
  busy = true;
  submitBtn.disabled = true;
  msg.textContent = "";
  try {
    const id = await create(body, v("note"));
    dlg.close();
    select(id);
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    busy = false;
    submitBtn.disabled = false;
  }
}

export const isOpen = () => !!dlg?.open;
