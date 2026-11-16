"""Serve an application's documents (PDF, Word) from the documents repo on GitHub.

The documents live in a private GitHub repo (DOCS_REPO_URL, branch DOCS_BRANCH).
Browsers can't display files from a private repo inside this app, so the server
fetches each file on request with a read-only token (DOCS_GITHUB_TOKEN: a
fine-grained token with Contents: read on that one repo) and passes it through.
Nothing is cached or stored: every request reads what's on the branch right now.

Only files the application lists, inside its own folder, with an allowed
extension, can be requested, so a crafted URL can't reach anything else in the repo.
"""
import re
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
MAX_BYTES = 20 * 1024 * 1024
DEMO_DOCS = Path(__file__).parent.parent / "demo" / "docs"
_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,150}$")
_REPO = re.compile(r"^https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+?)(?:\.git)?/?$")


class DocsError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def enabled(settings) -> bool:
    return bool(settings.demo_mode or (settings.docs_github_token and _REPO.match(settings.docs_repo_url or "")))


def resolve(app: dict, name: str) -> tuple[str, str]:
    """Check the request against the application; return (repo path, content type)."""
    ext = Path(name).suffix.lower()
    if ext not in TYPES:
        raise DocsError(404, "Only PDF and Word files can be opened here")
    if not _SEGMENT.match(name) or name not in (app.get("files") or []):
        raise DocsError(404, "That file isn't listed on this application")
    folder = (app.get("folder") or "").strip("/")
    parts = folder.split("/") if folder else []
    if not parts or any(p in (".", "..") or not _SEGMENT.match(p) for p in parts):
        raise DocsError(404, "This application has no documents folder")
    return f"{folder}/{name}", TYPES[ext]


def _github_get(url: str, token: str) -> bytes:
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "job-tracker",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise DocsError(502, "File is too large to open here")
    return data


def fetch(settings, path: str) -> bytes:
    if settings.demo_mode:
        f = DEMO_DOCS / Path(path).name
        if not f.is_file():
            raise DocsError(404, "No such demo file")
        return f.read_bytes()
    if not enabled(settings):
        raise DocsError(501, "Document viewing isn't set up on this server (DOCS_GITHUB_TOKEN)")
    owner, repo = _REPO.match(settings.docs_repo_url).groups()
    url = (f"https://api.github.com/repos/{owner}/{repo}/contents/{quote(path)}"
           f"?ref={quote(settings.docs_branch or 'main', safe='')}")
    try:
        return _github_get(url, settings.docs_github_token)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise DocsError(404, f"Not on GitHub's {settings.docs_branch or 'main'} branch yet: {path}")
        if e.code in (401, 403):
            raise DocsError(502, "GitHub refused the documents token (expired, or missing Contents: read)")
        raise DocsError(502, f"GitHub returned {e.code}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise DocsError(502, f"Couldn't reach GitHub: {getattr(e, 'reason', e)}")
