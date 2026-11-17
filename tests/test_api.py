from conftest import H, SECRET, TOKEN, make

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


def test_tokenless_needs_proxy_secret(tmp_path):
    """Only requests Authelia approved carry the secret Caddy adds. Local processes don't get a pass."""
    bare = make(tmp_path)
    bare.headers.pop("X-Proxy-Secret")
    assert bare.get("/api/dashboard").status_code == 401
    assert bare.get("/").status_code == 401
    assert bare.get("/api/dashboard", headers={"X-Proxy-Secret": "wrong" * 10}).status_code == 401
    assert bare.get("/api/dashboard", headers={"X-Proxy-Secret": SECRET}).status_code == 200
    assert bare.get("/healthz").status_code == 200   # health check stays open for the deploy script


def test_refuses_to_start_without_proxy_secret(tmp_path):
    import pytest
    from app.config import Settings
    from app.main import create_app
    s = Settings(); s.db_path = str(tmp_path / "x.db"); s.demo_mode = False; s.proxy_secret = "short"
    with pytest.raises(RuntimeError, match="PROXY_SECRET"):
        create_app(s)


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


def test_prefs_sync_per_device_class(seeded):
    assert seeded.get("/api/dashboard").json()["prefs"] == {"desktop": None, "mobile": None}
    v1 = seeded.get("/api/dashboard").json()["version"]
    r = seeded.put("/api/prefs/desktop", json={"prefs": {"preset": "graphite", "mode": "dark"}}, headers=H)
    assert r.status_code == 200
    d = seeded.get("/api/dashboard").json()
    assert d["prefs"] == {"desktop": {"preset": "graphite", "mode": "dark"}, "mobile": None}
    assert d["version"] != v1   # other open devices notice on their next poll
    seeded.put("/api/prefs/mobile", json={"prefs": {"preset": "paper"}}, headers=H)
    assert seeded.get("/api/prefs").json() == {"desktop": {"preset": "graphite", "mode": "dark"}, "mobile": {"preset": "paper"}}


def test_prefs_validation(seeded):
    assert seeded.put("/api/prefs/desktop", json={"prefs": {"a": 1}}).status_code == 403   # browser write needs CSRF header
    assert seeded.put("/api/prefs/tablet", json={"prefs": {}}, headers=H).status_code == 422
    assert seeded.put("/api/prefs/desktop", json={"prefs": "dark"}, headers=H).status_code == 422
    assert seeded.put("/api/prefs/desktop", json={"prefs": {"x": "y" * 20000}}, headers=H).status_code == 422


def test_import_keeps_prefs_unless_given(seeded):
    seeded.put("/api/prefs/desktop", json={"prefs": {"preset": "graphite"}}, headers=H)
    export = seeded.get("/api/export").json()
    assert export["meta"]["prefs"]["desktop"] == {"preset": "graphite"}
    export["meta"].pop("prefs")
    assert seeded.post("/api/import", json=export, headers=AUTH).status_code == 200
    assert seeded.get("/api/prefs").json()["desktop"] == {"preset": "graphite"}


def _path(kind, timeline, stage=""):
    from app.tracker import path_of
    tl = [{"text": t, "kind": k} for k, t in timeline]
    return path_of({"kind": kind, "stage": stage, "timeline": tl})


def test_path_skipped_stage_stays_skipped():
    p = _path("closed", [("status", "Added as Applied"), ("status", "Status: Applied → Interviewing"),
                         ("status", "Status: Interviewing → Offer"), ("status", "Status: Offer → Hired")])
    assert p == {"reached": ["Applied", "Interviewing", "Offer"], "exitKnown": True}


def test_path_closed_without_evidence():
    assert _path("closed", []) == {"reached": [], "exitKnown": False}
    # free text about the stage counts as evidence of reaching it, not of where it closed
    assert _path("closed", [("timeline", "Applied (Gmail)")]) == {"reached": ["Applied"], "exitKnown": False}


def test_path_reopened_then_closed_again():
    p = _path("closed", [("status", "Status: Applied → Rejected"), ("status", "Status: Rejected → Recruiter screen"),
                         ("status", "Status: Recruiter screen → Ghosted")])
    assert p == {"reached": ["Applied", "Recruiter screen"], "exitKnown": True}
    p = _path("active", [("status", "Status: Applied → Rejected"), ("status", "Status: Rejected → Applied")], stage="Applied")
    assert p == {"reached": ["Applied"], "exitKnown": False}


def test_path_history_and_text_rules():
    # leaving History gives no stage; a word that only begins like a stage doesn't count
    assert _path("closed", [("status", "Status: History → Rejected")]) == {"reached": [], "exitKnown": False}
    assert _path("history", [("timeline", "Offered a coffee chat"), ("note", "Interview prep notes")]) == {"reached": [], "exitKnown": False}
    assert _path("active", [("note", "Recruiter screen went well")], stage="Interviewing")["reached"] == ["Recruiter screen", "Interviewing"]


def test_dashboard_carries_paths(seeded):
    d = seeded.get("/api/dashboard").json()
    ridgeway = next(a for a in d["closed"] if a["company"] == "Ridgeway Software")
    assert ridgeway["path"] == {"reached": ["Applied", "Interviewing", "Offer"], "exitKnown": True}
    tidewater = next(a for a in d["closed"] if a["company"] == "Tidewater Co.")
    assert tidewater["path"] == {"reached": [], "exitKnown": False}


def test_static_modules_revalidate(client):
    """After a deploy, browsers must not mix a new page with old cached modules."""
    for path in ("/static/app.js", "/static/js/core/state.js", "/static/tokens.css"):
        r = client.get(path)
        assert r.status_code == 200 and r.headers["cache-control"] == "no-cache", path
    assert "max-age" in client.get("/static/vendor/pdfjs/pdf.min.js").headers["cache-control"]


def test_index_and_static_served(client):
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/healthz").json() == {"ok": True}
