"""Settings, all from environment variables (see deploy/job-tracker.env.example).

Auth model (AUTH_MODE=proxy, the default):
  - Browsers sign in at the reverse proxy (Caddy). The app listens on 127.0.0.1
    only, so anything that reaches it without a token came through that login.
  - Agents (Claude) send "Authorization: Bearer <token>". Caddy lets those
    through without its login, and the app checks the token itself.
DEMO_MODE=1 serves seeded fake data with no auth, for the public portfolio demo.
"""
import os
from dataclasses import dataclass, field


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, "1" if default else "0").strip().lower() in ("1", "true", "yes", "on")


def _tokens(raw: str) -> dict[str, str]:
    """API_TOKENS="claude:abc...,backup:def..." -> {"abc...": "claude", ...}. Tokens under 32 chars are ignored."""
    out = {}
    for part in filter(None, (p.strip() for p in raw.split(","))):
        name, _, token = part.partition(":")
        if len(token) >= 32:
            out[token] = name or "token"
    return out


@dataclass
class Settings:
    db_path: str = field(default_factory=lambda: os.environ.get("DB_PATH", "data/tracker.db"))
    auth_mode: str = field(default_factory=lambda: os.environ.get("AUTH_MODE", "proxy"))
    api_tokens: dict = field(default_factory=lambda: _tokens(os.environ.get("API_TOKENS", "")))
    owner_name: str = field(default_factory=lambda: os.environ.get("OWNER_NAME", ""))
    docs_repo_url: str = field(default_factory=lambda: os.environ.get("DOCS_REPO_URL", "").rstrip("/"))
    docs_branch: str = field(default_factory=lambda: os.environ.get("DOCS_BRANCH", "main"))
    demo_mode: bool = field(default_factory=lambda: _bool("DEMO_MODE"))

    def check(self) -> None:
        if self.demo_mode:
            return
        if self.auth_mode != "proxy":
            raise RuntimeError("Not starting: AUTH_MODE must be 'proxy' (the only mode so far)")
