#!/usr/bin/env bash
# Runs on the droplet as the jobtracker user, triggered by GitHub Actions over
# SSH (it's the forced command on the deploy key, so that key can do nothing else).
# Wrapped in main() so bash has read the whole script before git replaces it.
set -euo pipefail

main() {
  cd /opt/job-tracker
  echo "Deploying: $(git rev-parse --short HEAD) -> origin/main"
  git fetch --quiet origin main
  git reset --quiet --hard origin/main
  .venv/bin/pip install --quiet --disable-pip-version-check -r requirements.txt
  sudo /usr/bin/systemctl restart job-tracker
  for i in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:8300/healthz >/dev/null 2>&1; then
      echo "Healthy at $(git rev-parse --short HEAD)"
      return 0
    fi
    sleep 1
  done
  echo "Service didn't come back healthy. Recent logs:" >&2
  sudo /usr/bin/journalctl -u job-tracker -n 40 --no-pager >&2 || true
  return 1
}

main "$@"
