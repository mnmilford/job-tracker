# Job Tracker

A small, self-hosted web app for running a job search: every application, its status, next step, and a dated timeline, on one page that works the same on a desktop and a phone. AI agents (Claude, in my case) keep it current through the same API the page uses: they log new applications, read Gmail for rejections and interview invites, and update statuses, with every change attributed on the timeline.

I use it for my own search. The code is public; my data isn't. It lives only in the server's database. The demo runs on made-up data.

## What it does

- **Where things stand:** a stage strip and the active applications grouped by stage, with a right-hand rail for **Today** (overdue next steps, applications quiet for 10+ days, anything the email sync couldn't decide, with one-click Done / Snooze / Followed up / Ghosted), **Since you last looked** (what agents changed since you last marked it seen), and **Coming up**.
- **Flow chart:** a Sankey diagram of how applications moved through the stages to their outcomes, filterable by date, source and more, downloadable as PNG or SVG. It only draws stages with recorded evidence, so skipped stages stay skipped and imported rows with just an outcome show as "Stage not recorded".
- **Update fast:** change status from the badge on any row (Drafting → Applied → Recruiter screen → Interviewing → Offer, or Rejected / Withdrawn / Ghosted / Hired), and edit everything else inline in a side drawer: next step with a date picker, comp, source, posting link, fit, notes. Status changes and notes land on the timeline. Keyboard shortcuts for all of it (press `?`).
- **Your look, synced:** an Appearance panel with five themes and control over every color (light and dark), font, size, density, corner radius and badge style, with a contrast check. Settings sync through the server, separately for computers and phones.
- **Archive:** closed applications and old history rows, filterable by outcome and time window, and searchable along with everything else (including notes).
- **Live:** the page notices changes made elsewhere (another device, or an agent) within 30 seconds.
- **Documents in the app:** each application shows its resume and cover letter as **PDF** and **Word** buttons. PDFs open in a built-in viewer (PDF.js, so it works the same on phones), read live from the private documents repo on GitHub. Without a docs token configured, the buttons link to GitHub instead.
- **Agent-friendly API:** bearer-token access, and every write records who made it (`dashboard`, `claude`, ...).

## How it's built

```
Browser ──HTTPS──> Caddy (TLS; asks Authelia, then adds proxy secret) ──> uvicorn/FastAPI on 127.0.0.1 ──> SQLite (WAL)
                     └─forward_auth─> Authelia (login)
Claude  ──HTTPS + Bearer token──> Caddy (skips Authelia for bearer requests) ──┘   (app checks the token)
GitHub Actions: tests on every push; on main, deploy over SSH with a forced-command key
```

- **Backend:** Python, FastAPI, SQLite. No ORM; the schema is three tables (`app/db.py`). One connection per request, WAL mode, and `BEGIN IMMEDIATE` writes, so overlapping writes (an agent syncing while you edit on your phone) queue up instead of colliding. There's a test for exactly that.
- **Front end:** one HTML page and plain ES modules, no build step and no dependencies. `tokens.css` holds every color, size and spacing value as a CSS variable (the Appearance panel overrides them); `app.css` has the shared primitives; `js/core/` is the data layer (API client, model, polling, change tracking, every write) and `js/ui/` has one module per surface (list, rail, drawer, status menu, quick add, PDF viewer, flow chart, appearance, shortcuts). PDF.js 4.10.38 (Apache-2.0) is vendored in `app/static/vendor/pdfjs` and loaded only when a PDF is opened.
- **Rules live in one place** (`app/tracker.py`): moving between in-progress and closed, stamping outcome dates, keeping the timeline, all-or-nothing imports.

### Security model

- The app listens on `127.0.0.1` only and runs as its own unprivileged user under a hardened systemd unit.
- **Browsers** sign in at Authelia. Caddy checks every browser request with Authelia (`forward_auth`) and, only for approved ones, adds a shared secret header (after stripping any copy the client sent). Authelia's access rule names the one user allowed in. Token-less requests without that secret are refused, so other processes on the server, or an accidentally exposed port, get nothing.
- **Agents** send a bearer token (32+ chars, compared in constant time). Caddy sends bearer requests straight to the app without asking Authelia, and the app rejects any token it doesn't know.
- **CSRF:** browser writes must carry `X-Requested-With: job-tracker`. Cross-site forms can't set it, and cross-site scripts would need a CORS preflight the app never grants.
- **Import** (replace everything) is token-only.
- **Documents:** the server reads them from GitHub with a fine-grained token limited to Contents: read on the one docs repo, and only serves files an application lists, inside its own folder, as PDF or Word. Nothing is cached or stored.
- **Deploys** use an SSH key whose `authorized_keys` entry forces the deploy script, so the key can't open a shell.

## API

| Method | Path | What |
|---|---|---|
| GET | `/api/dashboard` | Everything the page renders, plus a `version` that changes on every write |
| GET | `/api/applications[?kind=active\|closed\|history]` | List |
| GET | `/api/applications/{id}` | One, with its timeline |
| POST | `/api/applications` | Create (`company` required; `status` defaults to Drafting) |
| PATCH | `/api/applications/{id}` | Any of `status`, `date`, `next_step`, `lesson`, `note`, plain fields |
| POST | `/api/applications/{id}/events` | Add a timeline entry or note |
| DELETE | `/api/applications/{id}/events/{eid}` | Delete a note |
| PUT | `/api/inbox` | Record an email sync: `checked` date and `review` items |
| GET | `/api/prefs` | Appearance settings: `{desktop, mobile}` |
| PUT | `/api/prefs/{desktop\|mobile}` | Save one device class's settings (`{prefs: {...}}`, a JSON object under 16 KB) |
| GET | `/api/export` | Full JSON backup |
| POST | `/api/import` | Replace everything from an export (token only) |

## Run it locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
DEMO_MODE=1 .venv/bin/uvicorn app.main:app --reload --port 8300   # http://127.0.0.1:8300, fake data
.venv/bin/pytest -q
```

`app/importer.py` converts the markdown tracker I used before this app (a README table plus per-application notes) into the import format.

## Deploy

See [`deploy/SETUP.md`](deploy/SETUP.md): one-time droplet setup (user, systemd, Caddy and Authelia, deploy key), then pushes to `main` deploy themselves after the tests pass.
