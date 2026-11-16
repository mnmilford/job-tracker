from app.importer import convert

README = """# Job Applications

Inbox last checked: 2026-11-16 (Gmail)

## Active

| Found | Company | Role | Comp | Source | Status | Next step | Folder |
|---|---|---|---|---|---|---|---|
| 2026-11-16 | Acme | Analyst | $90K | Lever | Applied | Follow up by 2026-11-30 | [link](applications/2026-11-16_acme) |

## Inbox: needs review

- Foo and Bar: no reply since August. Ghosted?

## Closed

| Found | Company | Role | Comp | Source | Status | Why it closed / lesson | Folder |
|---|---|---|---|---|---|---|---|
| 2026-08-10 | Globex | TAM | | Globex careers | Rejected (2026-08-17) | Form rejection. | |

## History (old)

| Company | Role | Framing / lesson |
|---|---|---|
| Initech | Head of Support | Led with management scope. |
"""

NOTES = """# Acme

## Fit
Verdict: match. Good fit.

## Timeline
- 2026-11-16: Found; resume built
- 2026-11-16: Applied via Workday
"""


def test_convert(tmp_path):
    (tmp_path / "README.md").write_text(README)
    folder = tmp_path / "applications" / "2026-11-16_acme"
    folder.mkdir(parents=True)
    (folder / "notes.md").write_text(NOTES)
    (folder / "posting.md").write_text("# Acme\nURL: https://example.com/job\n")
    (folder / "Resume.docx").write_bytes(b"x")
    (folder / "Resume.pdf").write_bytes(b"x")

    out = convert(tmp_path)
    apps = {a["company"]: a for a in out["applications"]}
    assert set(apps) == {"Acme", "Globex", "Initech"}
    acme = apps["Acme"]
    assert acme["kind"] == "active" and acme["next_step"] == "Follow up by 2026-11-30"
    assert acme["verdict"] == "match. Good fit." and acme["posting_url"] == "https://example.com/job"
    assert acme["files"] == ["Resume.docx", "notes.md", "posting.md"]
    assert [t["text"] for t in acme["timeline"]] == ["Found; resume built", "Applied via Workday"]
    assert apps["Globex"]["lesson"] == "Form rejection." and apps["Globex"]["kind"] == "closed"
    assert apps["Initech"]["kind"] == "history" and apps["Initech"]["lesson"] == "Led with management scope."
    assert out["meta"] == {"inbox_checked": "2026-11-16", "inbox_review": ["Foo and Bar: no reply since August. Ghosted?"]}


def test_crlf_readme(tmp_path):
    (tmp_path / "README.md").write_bytes(README.replace("\n", "\r\n").encode())
    out = convert(tmp_path)
    assert len(out["applications"]) == 3
    assert out["applications"][0]["status"] == "Applied"
