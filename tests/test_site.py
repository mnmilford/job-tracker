"""The Pages build: landing page + the real front end running on a fake in-browser API."""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_site_builds(tmp_path):
    out = tmp_path / "site"
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_site.py"), str(out)], check=True, capture_output=True)
    demo = out / "demo"
    html = (demo / "index.html").read_text()
    # paths work under a subpath (/job-tracker/), and the mock API loads before anything else
    assert '"/static/' not in html
    assert html.index('src="mock-api.js"') < html.index('src="static/app.js"')
    assert (demo / "static" / "app.js").exists() and (demo / "mock-api.js").exists()
    # starting data comes from the real tracker.dashboard(), with an anchor date to shift from
    data = json.loads((demo / "demo-data.json").read_text())
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", data["asOf"])
    apps = data["active"] + data["closed"] + data["history"]
    assert apps and all("path" in a for a in apps)
    assert data["demo"] is True and data["docsViewer"] is False
    assert not (out / "demo" / "dataset.json").exists()


def test_front_end_has_no_absolute_static_imports():
    """Absolute /static/ paths in JS would break the Pages demo, which lives under a subpath."""
    for f in (ROOT / "app" / "static" / "js").rglob("*.js"):
        assert '"/static/' not in f.read_text(), f
