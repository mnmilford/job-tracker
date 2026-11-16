# job-tracker

Self-hosted job-application tracker (FastAPI + SQLite + one static page). Public repo and a portfolio piece; production runs at https://jobtracker.thezdev.com on Michael's DigitalOcean droplet.

## Non-negotiables

- **No real data in this repo, ever.** No names of real employers Michael applied to, recruiters, notes, exports, or databases. Real data lives only in the server's SQLite file. Test and demo data are invented (`demo/seed.json`). `export*.json`, `*.db`, `data/` are gitignored; keep it that way.
- No secrets in the repo. Tokens live in `/etc/job-tracker/job-tracker.env` on the server and in GitHub Actions secrets.
- `pytest -q` passes before every push. CI deploys `main` automatically, so a push to main is a production release.
- Keep the front end build-free: `app/static/index.html`, `app.css`, `app.js`.
- Business rules belong in `app/tracker.py`, not in routes or the front end.

## Auth model (don't weaken it)

Browsers log in at Caddy, which injects `X-Proxy-Secret`; token-less requests without it get 401. Agents use `Authorization: Bearer`. Browser writes need `X-Requested-With: job-tracker`. Import is token-only. One SQLite connection per request (never share one across threads). See README "Security model".

## Commands

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -q
DEMO_MODE=1 .venv/bin/uvicorn app.main:app --port 8300
```

## Git

Push straight to `main`; no pull requests (Michael's call, 2026-11-16). Every push to `main` is a production release: CI runs `pytest` and deploys only if it passes, so run the tests locally first and say in the commit what changed for him.
