# One-time droplet setup

Target: `https://jobtracker.thezdev.com`, served by Caddy (which already handles login for your other apps), running the app as its own locked-down user. After this, every push to `main` that passes tests deploys itself.

Assumes Ubuntu 22.04+ (Python 3.10 or newer) with Caddy installed from the official package, running under systemd on the host (not in Docker). If your Caddy runs in a container, stop at step 5 and say so: the address it proxies to changes. Run everything as your normal sudo user unless a step says otherwise.

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

- The **proxy secret** also goes to Caddy in step 5. Nobody else ever needs it.
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

## 5. Caddy

Give Caddy the proxy secret from step 3 as a file it reads on each request. A reload picks it up, so your other sites never go down, and unlike a systemd `Environment=` line it isn't visible to other users through `systemctl show`. Write it with no trailing newline:

```bash
sudo sh -c 'umask 027; grep "^PROXY_SECRET=" /etc/job-tracker/job-tracker.env | cut -d= -f2- | tr -d "\n" > /etc/caddy/jobtracker-proxy-secret'
sudo chown root:caddy /etc/caddy/jobtracker-proxy-secret && sudo chmod 640 /etc/caddy/jobtracker-proxy-secret
```

Copy the block from `deploy/Caddyfile.example` into your Caddyfile, and put the same login directive your other sites use inside the second `handle`. Then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Check both doors:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://jobtracker.thezdev.com/                                   # 401 or a login redirect
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer wrong' https://jobtracker.thezdev.com/api/dashboard   # 401 from the app
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8300/api/dashboard                                   # 401: local but no secret
curl -s -o /dev/null -w '%{http_code}\n' -u michael https://jobtracker.thezdev.com/api/dashboard                  # 200 after the password prompt (basic_auth): login + secret work end to end
```

Then open it in a browser and sign in. It'll be empty until step 7.

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

## Troubleshooting

```bash
sudo systemctl status job-tracker
sudo journalctl -u job-tracker -n 50 --no-pager
sudo -u jobtracker /opt/job-tracker/deploy/remote-deploy.sh     # run a deploy by hand
```
