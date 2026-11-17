# One-time droplet setup

Target: `https://jobtracker.thezdev.com`, served by Caddy, with login handled by Authelia, running the app as its own locked-down user. After this, every push to `main` that passes tests deploys itself.

Assumes Ubuntu 22.04+ (Python 3.10 or newer) with Caddy installed from the official package, running under systemd on the host (not in Docker). Authelia should already be running and reachable from Caddy (its default is `127.0.0.1:9091`). If Caddy or Authelia runs in a container, stop at step 5 and say so: the addresses Caddy talks to change. Run everything as your normal sudo user unless a step says otherwise.

## 1. DNS

Add an `A` record: `jobtracker.thezdev.com` → your droplet's IPv4 (and `AAAA` if you use IPv6). Caddy gets the TLS certificate automatically once this resolves.

```bash
dig +short jobtracker.thezdev.com
```

## 2. User, code, and data directory

The app gets its own user with no password and no sudo beyond restarting itself. If anything ever goes wrong in it, it can't touch your other apps.

```bash
sudo apt-get install -y python3-venv git curl sqlite3
sudo adduser --system --group --home /opt/job-tracker --shell /bin/bash jobtracker
sudo -u jobtracker git clone https://github.com/mnmilford/job-tracker /opt/job-tracker
sudo -u jobtracker python3 -m venv /opt/job-tracker/.venv
sudo -u jobtracker /opt/job-tracker/.venv/bin/pip install -r /opt/job-tracker/requirements.txt
sudo install -d -o jobtracker -g jobtracker -m 750 /var/lib/job-tracker /var/lib/job-tracker/backups
```

## 3. Settings

```bash
sudo install -d -m 755 /etc/job-tracker
sudo cp /opt/job-tracker/deploy/job-tracker.env.example /etc/job-tracker/job-tracker.env
sudo chmod 600 /etc/job-tracker/job-tracker.env
python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # run twice: one proxy secret, one API token
sudo nano /etc/job-tracker/job-tracker.env                       # PROXY_SECRET=<first>, API_TOKENS=claude:<second>
```

- The **proxy secret** also goes to Caddy in step 5. Nobody else ever needs it, Authelia included.
- The **API token** is Claude's key. Keep it in your password manager; you'll paste it into a secure form when Claude asks for it, never into chat.

## 4. Service

```bash
sudo cp /opt/job-tracker/deploy/job-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now job-tracker
curl -s http://127.0.0.1:8300/healthz        # {"ok":true}
```

Let the `jobtracker` user run exactly the two commands the deploy script needs, and nothing else. (No wildcards: a pattern like `journalctl -u job-tracker *` would let it read any service's logs, and journalctl's pager can open a root shell.)

```bash
echo 'jobtracker ALL=(root) NOPASSWD: /usr/bin/systemctl restart job-tracker, /usr/bin/journalctl -u job-tracker -n 40 --no-pager' | sudo tee /etc/sudoers.d/job-tracker
sudo chmod 440 /etc/sudoers.d/job-tracker
sudo visudo -c
```

## 5. Caddy and Authelia

Give Caddy the proxy secret from step 3 as a file it reads on each request. A reload picks it up, so your other sites never go down, and unlike a systemd `Environment=` line it isn't visible to other users through `systemctl show`. Write it with no trailing newline:

```bash
sudo sh -c 'umask 027; grep "^PROXY_SECRET=" /etc/job-tracker/job-tracker.env | cut -d= -f2- | tr -d "\n" > /etc/caddy/jobtracker-proxy-secret'
sudo chown root:caddy /etc/caddy/jobtracker-proxy-secret && sudo chmod 640 /etc/caddy/jobtracker-proxy-secret
```

Copy the block from `deploy/Caddyfile.example` into your Caddyfile. It matches this droplet's Authelia: `127.0.0.1:9091`, served under the `/authelia` path prefix, so the endpoint is `/authelia/api/authz/forward-auth`. If yours listens elsewhere or at its own domain's root, change the address or drop the prefix. Then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Then tell Authelia who may open the tracker: merge `deploy/authelia.example.yml` into Authelia's `configuration.yml`. Two parts:

- **Cookie:** widen the *existing* session cookie to `thezdev.com` rather than adding a second one. Overlapping cookie domains make Authelia refuse to start, which takes every app behind it down. The portal stays at `https://apps.thezdev.com/authelia`. Everyone is signed out once.
- **Access rule:** it names only your user, so anyone else with an Authelia login (for your other apps) is turned away. Keep it above any broader `*.thezdev.com` rule, because Authelia uses the first rule that matches.

Check the result before restarting, so a bad config never takes Authelia down (write it as `configuration.yml.new` first):

```bash
sudo docker run --rm -v /opt/authelia:/config:ro authelia/authelia:4.39.15 authelia validate-config --config /config/configuration.yml.new
sudo mv /opt/authelia/configuration.yml.new /opt/authelia/configuration.yml && sudo docker restart authelia
```

How long you stay signed in is up to Authelia's `session` settings. Its defaults end a session after 5 minutes idle or 1 hour total, so on a phone you'd sign in nearly every visit; ticking "Remember me" stretches that to a month (`remember_me`). When a session ends, the page shows "Signed out" and a reload takes you to the Authelia portal.

Check both doors:

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://jobtracker.thezdev.com/                    # 302 to https://apps.thezdev.com/authelia/
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer wrong' https://jobtracker.thezdev.com/api/dashboard   # 401 from the app
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8300/api/dashboard                                   # 401: local but no secret
```

Then open it in a browser: you should land on the Authelia portal, and after signing in, back on the tracker. That proves the login and the secret work end to end. It'll be empty until step 7.

## 6. Automatic deploys (GitHub Actions)

Make a key used only for deploys. Its forced command means GitHub can run the deploy script and nothing else.

```bash
ssh-keygen -t ed25519 -N '' -C 'job-tracker deploy' -f ~/jt_deploy
sudo install -d -o jobtracker -g jobtracker -m 700 /opt/job-tracker/.ssh
echo "command=\"/opt/job-tracker/deploy/remote-deploy.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat ~/jt_deploy.pub)" \
  | sudo -u jobtracker tee /opt/job-tracker/.ssh/authorized_keys
sudo chmod 600 /opt/job-tracker/.ssh/authorized_keys
ssh-keyscan -t ed25519 <droplet IP or hostname>     # output = DEPLOY_KNOWN_HOSTS
cat ~/jt_deploy                                      # output = DEPLOY_SSH_KEY
```

If your sshd only allows specific users (`AllowUsers` in `/etc/ssh/sshd_config`), add `jobtracker` there and reload sshd.

In GitHub: **job-tracker → Settings → Secrets and variables → Actions → New repository secret**, add:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | droplet IP or hostname |
| `DEPLOY_SSH_KEY` | contents of `~/jt_deploy` (the private key) |
| `DEPLOY_KNOWN_HOSTS` | the `ssh-keyscan` line |

Then delete the local copy: `shred -u ~/jt_deploy ~/jt_deploy.pub`. Re-run the latest **CI** workflow in the Actions tab; the deploy job should end with `Healthy at <sha>`.

## 7. Load your data

Tell Claude the app is up. It will ask for the API token through a secure form, then import the current tracker from the job-search repo with `POST /api/import`.

## 8. Backups

Nightly SQLite snapshot, 14 days kept:

```bash
echo '15 3 * * * jobtracker sqlite3 /var/lib/job-tracker/tracker.db ".backup /var/lib/job-tracker/backups/tracker-$(date +\%F).db" && find /var/lib/job-tracker/backups -name "tracker-*.db" -mtime +14 -delete' \
  | sudo tee /etc/cron.d/job-tracker-backup
```

`GET /api/export` also returns everything as JSON, which is what an off-server backup should use.

## 9. Document viewer (optional)

Lets the app show each application's PDF in a built-in viewer and serve the Word file, read live from the documents repo. Without it, the PDF and Word buttons link to GitHub, which only works in a browser signed in to GitHub.

1. GitHub: Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   - Repository access: **Only select repositories** → your documents repo.
   - Permissions → Repository permissions → **Contents: Read-only**. Nothing else.
   - Expiration: your call. When it expires, the viewer says "GitHub refused the documents token"; make a new one and repeat step 2.
2. On the server, add it and restart:
   ```bash
   sudo nano /etc/job-tracker/job-tracker.env        # DOCS_GITHUB_TOKEN=github_pat_...
   sudo systemctl restart job-tracker
   ```
3. Reload the app. PDF buttons now open the viewer.

The token can only read that one repo. The app fetches a file when you open it and keeps no copy.

## Troubleshooting

```bash
sudo systemctl status job-tracker
sudo journalctl -u job-tracker -n 50 --no-pager
sudo -u jobtracker /opt/job-tracker/deploy/remote-deploy.sh     # run a deploy by hand
```
