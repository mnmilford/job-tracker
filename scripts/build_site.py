"""Build the GitHub Pages site (landing page + click-around demo) into _site/.

    python3 scripts/build_site.py            # -> _site/
    python3 scripts/build_site.py out_dir    # -> out_dir/

What goes where:
    site/*                 -> _site/                 landing page, images
    app/static/*           -> _site/demo/static/     the real front end, unchanged
    app/static/index.html  -> _site/demo/index.html  paths made relative, mock API injected first
    site/demo/mock-api.js  -> _site/demo/mock-api.js answers /api/* in the browser
    site/demo/dataset.json -> _site/demo/demo-data.json
        the invented applications, run through the real tracker.dashboard() so the
        demo's starting data has exactly the shape the app expects.

Nothing here touches the app or its database; the front end stays build-free.
"""
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("JOB_TRACKER_NO_AUTOAPP", "1")

from app import tracker  # noqa: E402
from app.config import Settings  # noqa: E402
from app.db import connect  # noqa: E402

SITE = ROOT / "site"
STATIC = ROOT / "app" / "static"
BANNER_OLD = "Demo with made-up data. Changes are allowed and reset when the server restarts."
BANNER_NEW = "Demo with made-up data, running entirely in your browser. Click anything. It all resets when you reload."


def demo_data(dataset: dict) -> dict:
    settings = Settings()
    settings.demo_mode = True
    settings.owner_name = ""
    settings.docs_repo_url = ""
    settings.docs_github_token = ""
    with tempfile.TemporaryDirectory() as tmp:
        conn = connect(str(Path(tmp) / "demo.db"), init=True)
        try:
            tracker.import_all(conn, dataset)
            data = tracker.dashboard(conn, settings)
        finally:
            conn.close()
    data["asOf"] = dataset["asOf"]  # the day the dataset's dates are written relative to
    data["docsViewer"] = False  # no documents in the demo
    return data


def demo_index() -> str:
    html = (STATIC / "index.html").read_text()
    html = html.replace('href="/static/', 'href="static/').replace('src="/static/', 'src="static/')
    if '"/static/' in html:
        raise SystemExit("index.html still has an absolute /static/ path the demo can't serve")
    html = html.replace("<title>Job Tracker</title>", "<title>Job Tracker demo</title>")
    if BANNER_OLD not in html:
        raise SystemExit("demo banner text changed in app/static/index.html; update BANNER_OLD")
    html = html.replace(BANNER_OLD, BANNER_NEW)
    # The mock API must load before anything else fetches or reads localStorage.
    html, n = re.subn(r'(<meta charset="utf-8">)', r'\1\n<script src="mock-api.js"></script>', html, count=1)
    if n != 1:
        raise SystemExit("couldn't find <meta charset> in app/static/index.html")
    return html


def build(out: Path) -> Path:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SITE, out, ignore=shutil.ignore_patterns("dataset.json", ".DS_Store"))
    demo = out / "demo"
    shutil.copytree(STATIC, demo / "static")
    (demo / "index.html").write_text(demo_index())
    dataset = json.loads((SITE / "demo" / "dataset.json").read_text())
    (demo / "demo-data.json").write_text(json.dumps(demo_data(dataset), ensure_ascii=False))
    (out / ".nojekyll").write_text("")  # serve files as-is
    return out


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "_site"
    print(f"Built {build(target.resolve())}")
