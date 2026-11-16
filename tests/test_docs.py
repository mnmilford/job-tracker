"""Document endpoint: files come from the docs repo on GitHub (mocked here), and
only files an application lists, in its own folder, as PDF or Word, are served."""
import urllib.error

import pytest

from app import docs
from tests.conftest import H, TOKEN, make

REPO = "https://github.com/someone/private-docs"
FOLDER = "applications/2026-11-20_acme_tam"
FILES = ["Resume_Acme.docx", "Resume_Acme.pdf", "notes.md"]


@pytest.fixture
def calls(monkeypatch):
    seen = []

    def fake_get(url, token):
        seen.append((url, token))
        if "missing" in url:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        if "expired" in url:
            raise urllib.error.HTTPError(url, 401, "Bad credentials", {}, None)
        return b"%PDF-1.7 fake" if url.split("?")[0].endswith(".pdf") else b"PK fake docx"

    monkeypatch.setattr(docs, "_github_get", fake_get)
    return seen


def app_with(client, files=FILES, folder=FOLDER):
    r = client.post("/api/applications", json={"company": "Acme", "folder": folder, "files": files}, headers=H)
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.fixture
def viewer(tmp_path):
    return make(tmp_path, docs_repo_url=REPO, docs_github_token="ghp_" + "x" * 36)


def test_pdf_inline_from_github(viewer, calls):
    i = app_with(viewer)
    r = viewer.get(f"/api/applications/{i}/files/Resume_Acme.pdf")
    assert r.status_code == 200
    assert r.content == b"%PDF-1.7 fake"
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"] == 'inline; filename="Resume_Acme.pdf"'
    assert r.headers["cache-control"] == "private, no-store"
    url, token = calls[-1]
    assert url == f"https://api.github.com/repos/someone/private-docs/contents/{FOLDER}/Resume_Acme.pdf?ref=main"
    assert token.startswith("ghp_")


def test_word_and_download_are_attachments(viewer, calls):
    i = app_with(viewer)
    r = viewer.get(f"/api/applications/{i}/files/Resume_Acme.docx")
    assert r.status_code == 200 and r.headers["content-disposition"].startswith("attachment;")
    assert "wordprocessingml" in r.headers["content-type"]
    r = viewer.get(f"/api/applications/{i}/files/Resume_Acme.pdf?download=1")
    assert r.headers["content-disposition"].startswith("attachment;")


@pytest.mark.parametrize("name", ["notes.md", "Other.pdf", "..%2F..%2Fsecret.pdf", ".hidden.pdf"])
def test_only_listed_pdf_or_word_files(viewer, calls, name):
    i = app_with(viewer, files=FILES + [".hidden.pdf"])
    assert viewer.get(f"/api/applications/{i}/files/{name}").status_code == 404
    assert calls == []


@pytest.mark.parametrize("folder", ["", "../outside", "applications/../../etc", "/abs/path/.."])
def test_folder_must_be_a_plain_relative_path(viewer, calls, folder):
    i = app_with(viewer, folder=folder)
    assert viewer.get(f"/api/applications/{i}/files/Resume_Acme.pdf").status_code == 404
    assert calls == []


def test_github_errors_are_explained(viewer, calls):
    i = app_with(viewer, files=["missing.pdf", "expired.pdf"])
    r = viewer.get(f"/api/applications/{i}/files/missing.pdf")
    assert r.status_code == 404 and "Not on GitHub" in r.json()["detail"]
    r = viewer.get(f"/api/applications/{i}/files/expired.pdf")
    assert r.status_code == 502 and "token" in r.json()["detail"]


def test_not_configured_without_token(client, calls):
    i = app_with(client)
    r = client.get(f"/api/applications/{i}/files/Resume_Acme.pdf")
    assert r.status_code == 501
    assert calls == []
    assert client.get("/api/dashboard").json()["docsViewer"] is False


def test_dashboard_flags_viewer(viewer):
    assert viewer.get("/api/dashboard").json()["docsViewer"] is True


def test_needs_login_or_token(viewer, calls):
    i = app_with(viewer)
    path = f"/api/applications/{i}/files/Resume_Acme.pdf"
    viewer.headers.pop("X-Proxy-Secret")
    assert viewer.get(path).status_code == 401
    assert viewer.get(path, headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200


def test_demo_serves_bundled_files(tmp_path):
    c = make(tmp_path, demo_mode=True)
    d = c.get("/api/dashboard").json()
    a = next(x for x in d["active"] if x["company"] == "Brightline Health")
    r = c.get(f"/api/applications/{a['id']}/files/Jordan_Rivera_Resume_Brightline.pdf")
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
