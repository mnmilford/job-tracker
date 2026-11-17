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
- **Front end:** one HTML page and plain ES modules, no build step and no dependencies. `tokens.css` holds every color, size and spacing value as a CSS variable (the Appearance panel overrides them); `app.css` has the shared primitives and `css/` one stylesheet per surface; `js/core/` is the data layer (API client, model, polling, change tracking, every write) and `js/ui/` has one module per surface (list, rail, drawer, status menu, quick add, PDF viewer, flow chart, appearance, shortcuts). PDF.js 4.10.38 (Apache-2.0) is vendored in `app/static/vendor/pdfjs` and loaded only when a PDF is opened.
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

## Run it yourself

Go as far as you like: look at the demo, run it on your own computer, or set it up for your own job search.

### 1. Try it in your browser

Open the hosted demo: https://mnmilford.github.io/job-tracker/. It runs on made-up data, so click anything.

### 2. Run the demo on your computer

Takes about 2 minutes. You need **Python 3.12 or newer** (it's what the tests run on) and **git**.

**macOS or Linux**

1. Get the code:
   ```bash
   git clone https://github.com/mnmilford/job-tracker.git
   ```
   ```bash
   cd job-tracker
   ```
2. Make a virtual environment and install the two dependencies (FastAPI and uvicorn):
   ```bash
   python3 -m venv .venv
   ```
   ```bash
   .venv/bin/pip install -r requirements.txt
   ```
3. Start it in demo mode:
   ```bash
   DEMO_MODE=1 .venv/bin/uvicorn app.main:app --port 8300
   ```
4. Open http://127.0.0.1:8300.

**Windows (PowerShell)**

1. Get the code:
   ```powershell
   git clone https://github.com/mnmilford/job-tracker.git
   ```
   ```powershell
   cd job-tracker
   ```
2. Make a virtual environment and install the dependencies:
   ```powershell
   py -m venv .venv
   ```
   ```powershell
   .venv\Scripts\pip install -r requirements.txt
   ```
3. Start it in demo mode:
   ```powershell
   $env:DEMO_MODE="1"; .venv\Scripts\uvicorn app.main:app --port 8300
   ```
4. Open http://127.0.0.1:8300.

You'll see the tracker filled with a dozen or so fake applications. Change statuses, edit things, try the flow chart and the Appearance panel. Demo mode has no login and keeps nothing: every restart brings back the same fake data. To stop it, press `Ctrl+C` in the terminal.

### 3. Use it for real

For your own job search, run it on a small Linux server, so you can reach it from your phone too. The cheapest VPS is plenty. The app has no open mode: it only answers requests that a reverse proxy let through after a login, or that carry an API token. The simplest login is Caddy's built-in basic auth (a username and password the browser asks for), which is what these steps use.

You need: a server running Ubuntu 24.04 (it ships Python 3.12), a domain or subdomain you can point at it, and ports 80 and 443 open.

1. **Point your domain at the server.** Add an `A` record for, say, `tracker.example.com` with the server's IP address. Caddy gets the HTTPS certificate on its own once this resolves.

2. **Install Caddy** from its official package: https://caddyserver.com/docs/install#debian-ubuntu-raspbian

3. **Install the app as its own service.** Follow steps 2, 3 and 4 of [`deploy/SETUP.md`](deploy/SETUP.md). They make a `jobtracker` user, put the code in `/opt/job-tracker`, keep the data in `/var/lib/job-tracker`, and start a systemd service on `127.0.0.1:8300`. In step 3 you fill in `/etc/job-tracker/job-tracker.env`:
   - `PROXY_SECRET`: a random string Caddy will add to every request that got past the login. Make one with:
     ```bash
     python3 -c "import secrets; print(secrets.token_urlsafe(32))"
     ```
     It has to be at least 32 characters, or the app refuses to start.
   - `OWNER_NAME`: your name, shown in the page header.
   - `API_TOKENS`: optional, for AI agents and for importing data (see step 6 and the next section). The format is `name:token`, comma-separated. Tokens shorter than 32 characters are silently ignored, so make them with the same command.
   - `DOCS_REPO_URL` and `DOCS_GITHUB_TOKEN`: leave empty unless you keep your resumes in a GitHub repo ([`SETUP.md`](deploy/SETUP.md) step 9).

   Check that it's up: `curl -s http://127.0.0.1:8300/healthz` should print `{"ok":true}`.

4. **Give Caddy the same secret.** This copies `PROXY_SECRET` from the app's settings into a file only Caddy can read:
   ```bash
   sudo sh -c 'umask 027; grep "^PROXY_SECRET=" /etc/job-tracker/job-tracker.env | cut -d= -f2- | tr -d "\n" > /etc/caddy/jobtracker-proxy-secret'
   ```
   ```bash
   sudo chown root:caddy /etc/caddy/jobtracker-proxy-secret && sudo chmod 640 /etc/caddy/jobtracker-proxy-secret
   ```

5. **Set up the login.** Pick a password and hash it (Caddy asks for it twice and prints a hash that starts with `$2a$`):
   ```bash
   caddy hash-password
   ```
   Then open `/etc/caddy/Caddyfile`, paste in the block from [`deploy/Caddyfile.basic-auth.example`](deploy/Caddyfile.basic-auth.example), and change three things: the domain, the username, and the hash. If the server runs nothing else, replace the whole file with that block. Check it and load it:
   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile
   ```
   ```bash
   sudo systemctl reload caddy
   ```
   Open `https://tracker.example.com`. Your browser asks for the username and password, then shows an empty tracker. From the command line, `curl -s -o /dev/null -w '%{http_code}\n' https://tracker.example.com/` should print `401`, and so should `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8300/api/dashboard` on the server (no secret, no entry).

6. **Add your applications.** Either start empty and add them from the page, or load a file. Import replaces everything, so it only works with an API token. The file uses the format of [`demo/seed.json`](demo/seed.json), which is also what `GET /api/export` gives back:
   ```bash
   curl -X POST https://tracker.example.com/api/import \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     --data @my-applications.json
   ```
   Here `$TOKEN` is one of your `API_TOKENS` (run `TOKEN=<your token>` first).

From here, [`deploy/SETUP.md`](deploy/SETUP.md) covers the rest: nightly backups (step 8), automatic deploys from your own fork with GitHub Actions (step 6), and the hardened systemd unit. To pull in updates by hand, run `sudo -u jobtracker /opt/job-tracker/deploy/remote-deploy.sh`. If you want a nicer login page, remember-me sessions, or one login across several of your apps, SETUP.md step 5 puts [Authelia](https://www.authelia.com/) in front instead of basic auth. That's how my own copy runs.

### 4. Connect an AI agent (optional)

Agents use the same API as the page, with a bearer token instead of the login. Put a token in `API_TOKENS` in `/etc/job-tracker/job-tracker.env` (for example `API_TOKENS=claude:<token>`), then `sudo systemctl restart job-tracker`. The name before the colon is what shows on the timeline next to every change the agent makes. Caddy sends bearer requests straight to the app, which checks the token itself.

In these examples, `$TOKEN` is that token (run `TOKEN=<your token>` first).

Add an application:

```bash
curl -X POST https://tracker.example.com/api/applications \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"company": "Acme", "role": "Support Engineer", "status": "Applied"}'
```

Read everything the page shows:

```bash
curl https://tracker.example.com/api/dashboard -H "Authorization: Bearer $TOKEN"
```

The [API](#api) table above lists every endpoint. Keep the token somewhere safe, like a password manager: anyone with it can read and change your tracker.

### Working on the code

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
DEMO_MODE=1 .venv/bin/uvicorn app.main:app --reload --port 8300   # reloads when you edit
.venv/bin/pytest -q
```

`app/importer.py` converts the markdown tracker I used before this app (a README table plus per-application notes) into the import format.

## Deploy

The short version, with a basic-auth login, is in [Run it yourself](#3-use-it-for-real). [`deploy/SETUP.md`](deploy/SETUP.md) has the full one-time server setup (user, systemd, Caddy and Authelia, deploy key), after which pushes to `main` deploy themselves once the tests pass.
