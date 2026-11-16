# Job Tracker

A small, self-hosted web app for running a job search: every application, its status, next step, and a dated timeline, on one page that works the same on a desktop and a phone. AI agents (Claude, in my case) keep it current through the same API the page uses: they log new applications, read Gmail for rejections and interview invites, and update statuses, with every change attributed on the timeline.

I use it for my own search. The code is public; my data isn't. It lives only in the server's database. The demo runs on made-up data.

## What it does

- **Pipeline at a glance:** counts by stage, a funnel, and a "Needs attention" list (overdue next steps, applications quiet for 10+ days, anything the email sync couldn't decide).
- **Update from anywhere:** change status (Drafting → Applied → Recruiter screen → Interviewing → Offer, or Rejected / Withdrawn / Ghosted / Hired), set the next step, record why something closed, and add notes. Status changes and notes land on the timeline.
- **Closed applications, filterable** by outcome and time window, and searchable along with everything else (including notes).
- **Live:** the page notices changes made elsewhere (another device, or an agent) within 30 seconds.
- **Agent-friendly API:** bearer-token access, and every write records who made it (`dashboard`, `claude`, ...).

## How it's built

```
Browser ──HTTPS──> Caddy (TLS + login) ──> uvicorn/FastAPI on 127.0.0.1 ──> SQLite (WAL)
Claude  ──HTTPS + Bearer token──> Caddy (skips login for bearer requests) ──┘   (app checks the token)
GitHub Actions: tests on every push; on main, deploy over SSH with a forced-command key
```

- **Backend:** Python, FastAPI, SQLite. No ORM; the schema is three tables (`app/db.py`).
- **Front end:** one HTML page, one stylesheet, one script. No build step.
- **Rules live in one place** (`app/tracker.py`): moving between in-progress and closed, stamping outcome dates, keeping the timeline, all-or-nothing imports.

### Security model

- The app listens on `127.0.0.1` only and runs as its own unprivileged user under a hardened systemd unit.
- **Browsers** authenticate at the reverse proxy. Requests without a token are accepted only from the local machine (that is, through the proxy), so an accidentally exposed port still gives nothing away.
- **Agents** send a bearer token (32+ chars, compared in constant time). The proxy lets bearer requests skip its login, and the app rejects any token it doesn't know.
- **CSRF:** browser writes must carry `X-Requested-With: job-tracker`. Cross-site forms can't set it, and cross-site scripts would need a CORS preflight the app never grants.
- **Import** (replace everything) is token-only.
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

See [`deploy/SETUP.md`](deploy/SETUP.md): one-time droplet setup (user, systemd, Caddy, deploy key), then pushes to `main` deploy themselves after the tests pass.
