from conftest import H, TOKEN, make

AUTH = {"Authorization": f"Bearer {TOKEN}"}


def find(client, company):
    d = client.get("/api/dashboard").json()
    for kind in ("active", "closed", "history"):
        for a in d[kind]:
            if a["company"] == company:
                return a
    raise AssertionError(company)


# ---- auth ----

def test_bad_token_rejected(client):
    r = client.get("/api/dashboard", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_good_token_reads(seeded):
    assert seeded.get("/api/dashboard", headers=AUTH).status_code == 200


def test_browser_without_token_must_be_local(tmp_path):
    from fastapi.testclient import TestClient
    from app.config import Settings
    from app.main import create_app
    s = Settings(); s.db_path = str(tmp_path / "x.db"); s.api_tokens = {}; s.demo_mode = False
    remote = TestClient(create_app(s), client=("203.0.113.9", 5000))
    assert remote.get("/api/dashboard").status_code == 401
    assert remote.get("/").status_code == 401


def test_browser_write_needs_csrf_header(seeded):
    a = find(seeded, "Northwind Labs")
    r = seeded.patch(f"/api/applications/{a['id']}", json={"note": "hi"})
    assert r.status_code == 403
    r = seeded.patch(f"/api/applications/{a['id']}", json={"note": "hi"}, headers=H)
    assert r.status_code == 200


def test_token_write_needs_no_csrf_header(seeded):
    a = find(seeded, "Northwind Labs")
    r = seeded.patch(f"/api/applications/{a['id']}", json={"note": "from claude"}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["timeline"][-1]["source"] == "claude"


def test_import_only_with_token(seeded):
    r = seeded.post("/api/import", json={"applications": []}, headers=H)
    assert r.status_code == 403


# ---- status rules ----

def test_active_to_rejected_moves_to_closed(seeded):
    a = find(seeded, "Northwind Labs")
    r = seeded.patch(f"/api/applications/{a['id']}", json={"status": "Rejected", "date": "2026-11-20", "lesson": "Form rejection"}, headers=H)
    assert r.status_code == 200, r.text
    b = find(seeded, "Northwind Labs")
    assert b["kind"] == "closed" and b["status"] == "Rejected (2026-11-20)" and b["lesson"] == "Form rejection"
    assert b["timeline"][-1]["text"] == "Status: Applied → Rejected" and b["timeline"][-1]["kind"] == "status"


def test_closed_back_to_active(seeded):
    a = find(seeded, "Quillfeather")
    seeded.patch(f"/api/applications/{a['id']}", json={"status": "Recruiter screen", "next_step": "Call 2026-12-01"}, headers=H)
    b = find(seeded, "Quillfeather")
    assert b["kind"] == "active" and b["stage"] == "Recruiter screen" and b["nextDate"] == "2026-12-01"


def test_history_row_gets_status(seeded):
    a = find(seeded, "Sundial AI")
    seeded.patch(f"/api/applications/{a['id']}", json={"status": "Ghosted", "date": "2026-11-16"}, headers=H)
    b = find(seeded, "Sundial AI")
    assert b["kind"] == "closed" and b["status"] == "Ghosted (2026-11-16)"
    assert b["timeline"][-1]["text"] == "Status: History → Ghosted"


def test_same_stage_keeps_status_text_and_updates_next(seeded):
    a = find(seeded, "Atlas Freight")
    seeded.patch(f"/api/applications/{a['id']}", json={"status": "Recruiter screen", "next_step": "Moved to 2026-11-19"}, headers=H)
    b = find(seeded, "Atlas Freight")
    assert b["status"] == "Recruiter screen" and b["next"] == "Moved to 2026-11-19"
    assert not any(t["kind"] == "status" and "Atlas" in t["text"] for t in b["timeline"])


def test_unknown_status_rejected(seeded):
    a = find(seeded, "Atlas Freight")
    r = seeded.patch(f"/api/applications/{a['id']}", json={"status": "Maybe"}, headers=H)
    assert r.status_code == 422


def test_nothing_to_change(seeded):
    a = find(seeded, "Atlas Freight")
    r = seeded.patch(f"/api/applications/{a['id']}", json={}, headers=H)
    assert r.status_code == 422 and "Nothing" in r.json()["detail"]


def test_bad_date_rejected(seeded):
    a = find(seeded, "Atlas Freight")
    r = seeded.patch(f"/api/applications/{a['id']}", json={"note": "x", "date": "11/20/2026"}, headers=H)
    assert r.status_code == 422


# ---- notes ----

def test_note_add_and_delete(seeded):
    a = find(seeded, "Cobalt Systems")
    r = seeded.patch(f"/api/applications/{a['id']}", json={"note": "Line one\nline two | pipe"}, headers=H)
    note = r.json()["timeline"][-1]
    assert note["kind"] == "note" and note["text"] == "Line one line two | pipe" and note["source"] == "dashboard"
    r = seeded.delete(f"/api/applications/{a['id']}/events/{note['id']}", headers=H)
    assert r.status_code == 200 and all(t["id"] != note["id"] for t in r.json()["timeline"])


def test_only_notes_can_be_deleted(seeded):
    a = find(seeded, "Brightline Health")
    status_or_timeline = next(t for t in a["timeline"] if t["kind"] != "note")
    r = seeded.delete(f"/api/applications/{a['id']}/events/{status_or_timeline['id']}", headers=H)
    assert r.status_code == 404


def test_agent_timeline_event(seeded):
    a = find(seeded, "Cobalt Systems")
    r = seeded.post(f"/api/applications/{a['id']}/events", json={"text": "Rejection email (Gmail)", "date": "2026-11-18"}, headers=AUTH)
    assert r.status_code == 201 and r.json()["timeline"][-1]["source"] == "claude"


# ---- create / inbox / export ----

def test_create_and_outcome_create(seeded):
    r = seeded.post("/api/applications", json={"company": "New Co", "role": "TAM", "status": "Applied"}, headers=H)
    assert r.status_code == 201 and r.json()["kind"] == "active"
    r = seeded.post("/api/applications", json={"company": "Old Co", "status": "Rejected", "date": "2026-10-01"}, headers=AUTH)
    assert r.json()["kind"] == "closed" and r.json()["status"] == "Rejected (2026-10-01)"
    assert seeded.post("/api/applications", json={"company": ""}, headers=H).status_code == 422


def test_inbox_meta(seeded):
    r = seeded.put("/api/inbox", json={"checked": "2026-11-17", "review": ["one", "", "two"]}, headers=AUTH)
    assert r.json() == {"inboxChecked": "2026-11-17", "inboxReview": ["one", "two"]}
    d = seeded.get("/api/dashboard").json()
    assert d["inboxChecked"] == "2026-11-17"


def test_export_import_roundtrip(seeded, tmp_path):
    exported = seeded.get("/api/export", headers=AUTH).json()
    other = make(tmp_path / "b")
    assert other.post("/api/import", json=exported, headers=AUTH).status_code == 200
    again = other.get("/api/export", headers=AUTH).json()
    strip = lambda d: [(a["company"], a["kind"], a["status"], [(t["date"], t["text"], t["kind"]) for t in a["timeline"]]) for a in d["applications"]]
    assert strip(again) == strip(exported)


def test_import_is_all_or_nothing(seeded):
    before = seeded.get("/api/export", headers=AUTH).json()
    bad = {"applications": [{"kind": "active", "company": "Fine"}, {"kind": "nope", "company": "Bad"}]}
    assert seeded.post("/api/import", json=bad, headers=AUTH).status_code == 422
    assert seeded.get("/api/export", headers=AUTH).json() == before


def test_dashboard_version_changes_on_write(seeded):
    v1 = seeded.get("/api/dashboard").json()["version"]
    a = find(seeded, "Cobalt Systems")
    seeded.patch(f"/api/applications/{a['id']}", json={"note": "bump"}, headers=H)
    assert seeded.get("/api/dashboard").json()["version"] != v1


def test_index_and_static_served(client):
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/healthz").json() == {"ok": True}
