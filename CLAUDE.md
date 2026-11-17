# job-tracker

Self-hosted job-application tracker (FastAPI + SQLite + one static page). Public repo and a portfolio piece; production runs at https://jobtracker.thezdev.com on Michael's DigitalOcean droplet.

## Non-negotiables

- **No real data in this repo, ever.** No names of real employers Michael applied to, recruiters, notes, exports, or databases. Real data lives only in the server's SQLite file. Test and demo data are invented (`demo/seed.json`). `export*.json`, `*.db`, `data/` are gitignored; keep it that way.
- No secrets in the repo. Tokens live in `/etc/job-tracker/job-tracker.env` on the server and in GitHub Actions secrets.
- `pytest -q` passes before every push. CI deploys `main` automatically, so a push to main is a production release.
- Keep the front end build-free: `app/static/index.html` loads `tokens.css`, `app.css`, `css/*.css` and the ES module `app.js`, which imports `js/core/*` (data layer: every write goes through `js/core/actions.js`) and `js/ui/*` (one module per surface). No bundler, no npm packages, no CDN.
- Component CSS uses tokens only (`var(--…)` from `tokens.css`), never raw colors or px spacing/font sizes: the Appearance panel lets the user change all of them.
- Business rules belong in `app/tracker.py`, not in routes or the front end.
- `site/` is the public landing page + click-around demo on GitHub Pages (`.github/workflows/pages.yml`). `scripts/build_site.py` copies `app/static` in unchanged and injects `site/demo/mock-api.js`, which answers `/api/*` in the browser and mirrors the write rules in `tracker.py`: change one, change the other. Front-end paths must stay relative (the demo lives under `/job-tracker/`); `tests/test_site.py` checks. Demo data (`site/demo/dataset.json`) is invented, like `demo/seed.json`.

## Auth model (don't weaken it)

Browsers log in at Authelia; Caddy checks each request with it (`forward_auth`) and injects `X-Proxy-Secret` only on approved ones, and bearer requests skip Authelia; token-less requests without it get 401. Agents use `Authorization: Bearer`. Browser writes need `X-Requested-With: job-tracker`. Import is token-only. One SQLite connection per request (never share one across threads). See README "Security model".

## Commands

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -q
DEMO_MODE=1 .venv/bin/uvicorn app.main:app --port 8300
```

## Git

Push straight to `main`; no pull requests (Michael's call, 2026-11-16). Every push to `main` is a production release: CI runs `pytest` and deploys only if it passes, so run the tests locally first and say in the commit what changed for him.
