// JSON API client. Same contract as the original front end:
// - writes carry X-Requested-With: job-tracker (the server's CSRF check)
// - redirect: "manual", because when the Authelia session ends the proxy answers
//   with a redirect to its portal on another domain (or a 401). A fetch can't
//   follow that, so we report it as signed out, not offline.
export const SIGNED_OUT = "Signed out. Reload the page to sign in again.";
export class SignedOut extends Error { constructor() { super(SIGNED_OUT); this.name = "SignedOut"; } }
export const signedOut = (res) => res.type === "opaqueredirect" || res.status === 401;

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Requested-With": "job-tracker" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    redirect: "manual",
  });
  if (signedOut(res)) throw new SignedOut();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/** Raw file fetch (PDFs) with the same signed-out handling. Returns a Uint8Array. */
export async function fetchBytes(path) {
  const res = await fetch(path, { credentials: "same-origin", redirect: "manual" });
  if (signedOut(res)) throw new SignedOut();
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail; } catch {}
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
