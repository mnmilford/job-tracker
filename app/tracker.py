"""Tracker rules: stages, status changes, notes, and the dashboard payload.

Status rules (same as the /status skill they replace):
  - In-progress stages live in "active". Setting one moves the row to active.
  - Outcomes live in "closed" as "<Outcome> (YYYY-MM-DD)". Setting one moves it there.
  - "history" rows (old tracker, no status) move out the first time they get one.
  - Every status change and note becomes a dated timeline event.
"""
import json
import re
import sqlite3
from datetime import date as Date

from .db import get_meta, set_meta, transaction
from .docs import enabled as docs_enabled

STAGES = ["Drafting", "Applied", "Recruiter screen", "Interviewing", "Offer"]
OUTCOMES = ["Rejected", "Withdrawn", "Ghosted", "Hired"]
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
STATUS_EVENT_RE = re.compile(r"^Status:\s*(.+?)\s*→\s*(.+?)\s*$")
ADDED_EVENT_RE = re.compile(r"^Added as\s+(.+?)\s*$")
FIELDS = ["found", "company", "role", "comp", "source", "next_step", "lesson", "folder", "posting_url", "verdict"]
PREF_SLOTS = ("desktop", "mobile")   # appearance settings sync per device class
PREFS_MAX_BYTES = 16_000


class NotFound(Exception):
    pass


class Invalid(ValueError):
    pass


def clean(value, limit: int = 600) -> str:
    """One line of plain text: no newlines, collapsed spaces, capped length."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def valid_date(value: str | None) -> str:
    if not value:
        return Date.today().isoformat()
    try:
        return Date.fromisoformat(value).isoformat()
    except ValueError:
        raise Invalid(f"Not a date: {value!r} (use YYYY-MM-DD)")


def stage_of(status: str) -> str:
    s = (status or "").lower()
    for st in STAGES + OUTCOMES:
        if s.startswith(st.lower()):
            return st
    return re.split(r"[(,;]", status or "")[0].strip() or "Unknown"


# ---------- reads ----------

def _row(conn: sqlite3.Connection, app_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    if not row:
        raise NotFound(f"No application {app_id}")
    return row


def _events(conn, app_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT id, date, text, kind, source FROM events WHERE application_id = ? ORDER BY date, id", (app_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def to_dict(conn, row: sqlite3.Row) -> dict:
    d = dict(row)
    d["files"] = json.loads(d["files"] or "[]")
    d["stage"] = "" if d["kind"] == "history" else stage_of(d["status"])
    d["timeline"] = _events(conn, d["id"])
    return d


def _starts_with_stage(text: str) -> str:
    """'Recruiter screen; asked for times' -> 'Recruiter screen'. Whole words only."""
    low = text.lower()
    for st in STAGES:
        if low.startswith(st.lower()) and (len(low) == len(st) or not low[len(st)].isalpha()):
            return st
    return ""


def path_of(app: dict) -> dict:
    """Which in-progress stages an application is known to have reached, for the
    flow chart. Only recorded evidence counts, so the chart never shows a flow
    that didn't happen:
      - status events: "Added as X" and both ends of "Status: X → Y"
      - timeline or note text that starts with a stage name ("Recruiter screen; ...")
      - the current stage of an active application
    Skipped stages stay skipped (Applied → Interviewing doesn't imply a screen).
    exitKnown: for a closed application, whether a status event records the
    stage it closed from. Imported rows usually only say "Rejected (date)"."""
    reached, exit_known = set(), False
    for t in app["timeline"]:
        text = (t["text"] or "").strip()
        m = STATUS_EVENT_RE.match(text) if t["kind"] == "status" else None
        a = ADDED_EVENT_RE.match(text) if t["kind"] == "status" else None
        if m:
            src, dst = m.group(1), m.group(2)
            reached.update(x for x in (src, dst) if x in STAGES)
            if dst in OUTCOMES:
                exit_known = src in STAGES
            elif dst in STAGES:
                exit_known = False          # reopened; a later close decides again
        elif a:
            if a.group(1) in STAGES:
                reached.add(a.group(1))
        elif st := _starts_with_stage(text):
            reached.add(st)
    if app["kind"] == "active" and app.get("stage") in STAGES:
        reached.add(app["stage"])
    return {"reached": [s for s in STAGES if s in reached], "exitKnown": app["kind"] == "closed" and exit_known}


def get_application(conn, app_id: int) -> dict:
    return to_dict(conn, _row(conn, app_id))


def list_applications(conn, kind: str | None = None) -> list[dict]:
    sql, args = "SELECT * FROM applications", ()
    if kind:
        sql, args = sql + " WHERE kind = ?", (kind,)
    return [to_dict(conn, r) for r in conn.execute(sql + " ORDER BY id", args).fetchall()]


def dashboard(conn, settings) -> dict:
    """Same shape the old generated dashboard used, so the front end ports cleanly."""
    def shape(a: dict) -> dict:
        dates = DATE_RE.findall(" ".join([a["found"], a["status"], *[t["date"] for t in a["timeline"]]]))
        return {
            "id": a["id"], "kind": a["kind"], "found": a["found"], "company": a["company"], "role": a["role"],
            "comp": a["comp"], "source": a["source"], "status": a["status"], "stage": a["stage"],
            "next": a["next_step"], "nextDate": (DATE_RE.findall(a["next_step"]) or [""])[0],
            "lesson": a["lesson"], "folder": a["folder"], "url": a["posting_url"], "verdict": a["verdict"],
            "files": a["files"], "timeline": a["timeline"], "lastActivity": max(dates) if dates else "",
            "path": path_of(a),
        }
    apps = [shape(a) for a in list_applications(conn)]
    return {
        "version": str(get_meta(conn, "revision", 0)),
        "owner": settings.owner_name,
        "repoUrl": settings.docs_repo_url,
        "branch": settings.docs_branch,
        "docsViewer": docs_enabled(settings),
        "demo": settings.demo_mode,
        "stages": STAGES,
        "outcomes": OUTCOMES,
        "inboxChecked": get_meta(conn, "inbox_checked", ""),
        "inboxReview": get_meta(conn, "inbox_review", []),
        "prefs": get_prefs(conn),
        "active": [a for a in apps if a["kind"] == "active"],
        "closed": [a for a in apps if a["kind"] == "closed"],
        "history": [a for a in apps if a["kind"] == "history"],
    }


# ---------- writes ----------

def _add_event(conn, app_id: int, date: str, text: str, kind: str, source: str) -> None:
    conn.execute(
        "INSERT INTO events (application_id, date, text, kind, source) VALUES (?, ?, ?, ?, ?)",
        (app_id, date, text, kind, source),
    )


def _bump(conn) -> None:
    """Every write increments a revision; the dashboard polls it to know when to re-render."""
    set_meta(conn, "revision", get_meta(conn, "revision", 0) + 1)


def _touch(conn, app_id: int) -> None:
    conn.execute("UPDATE applications SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?", (app_id,))
    _bump(conn)


def create_application(conn, data: dict, source: str = "app") -> dict:
    company = clean(data.get("company"), 120)
    if not company:
        raise Invalid("company is required")
    status = clean(data.get("status")) or "Drafting"
    stage = stage_of(status)
    if stage not in STAGES + OUTCOMES:
        raise Invalid(f"Unknown status: {status}")
    kind = "active" if stage in STAGES else "closed"
    if kind == "closed":
        status = f"{stage} ({valid_date(data.get('date'))})"
    else:
        status = stage
    values = {f: clean(data.get(f), 1000) for f in FIELDS}
    values["company"] = company
    values["found"] = values["found"] or Date.today().isoformat()
    with transaction(conn):
        cur = conn.execute(
            f"INSERT INTO applications (kind, status, files, {', '.join(FIELDS)}) VALUES (?, ?, ?, {', '.join('?' * len(FIELDS))})",
            (kind, status, json.dumps(data.get("files") or []), *[values[f] for f in FIELDS]),
        )
        app_id = cur.lastrowid
        _add_event(conn, app_id, values["found"], f"Added as {stage}", "status", source)
        _bump(conn)
    return get_application(conn, app_id)


def update_application(conn, app_id: int, data: dict, source: str = "app") -> dict:
    """Change status and/or fields, optionally with a note. data keys:
    status, date, next_step, lesson, note, plus any plain field in FIELDS."""
    with transaction(conn):
        row = _row(conn, app_id)
        kind, status = row["kind"], row["status"]
        old_stage = "History" if kind == "history" else stage_of(status)
        changes: dict = {}
        when = valid_date(data.get("date"))

        target = clean(data.get("status"))
        if target:
            if target not in STAGES + OUTCOMES:
                raise Invalid(f"Unknown status: {target}. Use one of: {', '.join(STAGES + OUTCOMES)}")
            if target != old_stage:
                if target in STAGES:
                    kind, status = "active", target
                    if "next_step" not in data and row["kind"] != "active":
                        changes["next_step"] = ""
                else:
                    kind, status = "closed", f"{target} ({when})"
                _add_event(conn, app_id, when, f"Status: {old_stage} → {target}", "status", source)

        for f in FIELDS:
            if f in data and data[f] is not None:
                changes[f] = clean(data[f], 1000)
        if "company" in changes and not changes["company"]:
            raise Invalid("company can't be empty")
        if "files" in data and data["files"] is not None:
            changes["files"] = json.dumps([clean(x, 200) for x in data["files"]])

        note = clean(data.get("note"), 2000)
        if note:
            _add_event(conn, app_id, when, note, "note", source)

        if not (target and target != old_stage) and not changes and not note:
            raise Invalid("Nothing to change")

        changes.update(kind=kind, status=status)
        conn.execute(
            f"UPDATE applications SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
            (*changes.values(), app_id),
        )
        _touch(conn, app_id)
    return get_application(conn, app_id)


def add_event(conn, app_id: int, text: str, date: str | None = None, kind: str = "timeline", source: str = "app") -> dict:
    text = clean(text, 2000)
    if not text:
        raise Invalid("text is required")
    if kind not in ("timeline", "note"):
        raise Invalid("kind must be timeline or note")
    with transaction(conn):
        _row(conn, app_id)
        _add_event(conn, app_id, valid_date(date), text, kind, source)
        _touch(conn, app_id)
    return get_application(conn, app_id)


def delete_event(conn, app_id: int, event_id: int) -> dict:
    with transaction(conn):
        cur = conn.execute("DELETE FROM events WHERE id = ? AND application_id = ? AND kind = 'note'", (event_id, app_id))
        if cur.rowcount == 0:
            raise NotFound("No such note on this application (only notes can be deleted)")
        _touch(conn, app_id)
    return get_application(conn, app_id)


def set_inbox(conn, checked: str | None, review: list[str] | None) -> dict:
    with transaction(conn):
        if checked is not None:
            set_meta(conn, "inbox_checked", valid_date(checked))
        if review is not None:
            set_meta(conn, "inbox_review", [clean(r, 600) for r in review if clean(r)])
        _bump(conn)
    return {"inboxChecked": get_meta(conn, "inbox_checked", ""), "inboxReview": get_meta(conn, "inbox_review", [])}


def get_prefs(conn) -> dict:
    return {slot: get_meta(conn, f"prefs_{slot}", None) for slot in PREF_SLOTS}


def set_prefs(conn, slot: str, prefs) -> dict:
    """Save one device class's appearance settings (an opaque JSON object the
    front end owns). Bumps the revision so other open devices pick it up."""
    if slot not in PREF_SLOTS:
        raise Invalid(f"Unknown prefs slot: {slot!r}. Use one of: {', '.join(PREF_SLOTS)}")
    if not isinstance(prefs, dict):
        raise Invalid("prefs must be a JSON object")
    if len(json.dumps(prefs)) > PREFS_MAX_BYTES:
        raise Invalid(f"prefs are too large (limit {PREFS_MAX_BYTES} bytes)")
    with transaction(conn):
        set_meta(conn, f"prefs_{slot}", prefs)
        _bump(conn)
    return {"slot": slot, "prefs": prefs}


# ---------- import / export ----------

def export_all(conn) -> dict:
    return {
        "format": "job-tracker/1",
        "applications": [
            {k: v for k, v in a.items() if k not in ("stage",)} for a in list_applications(conn)
        ],
        "meta": {"inbox_checked": get_meta(conn, "inbox_checked", ""), "inbox_review": get_meta(conn, "inbox_review", []),
                 "prefs": get_prefs(conn)},
    }


def import_all(conn, payload: dict) -> dict:
    """Replace everything with an export (or importer output). All or nothing."""
    apps = payload.get("applications")
    if not isinstance(apps, list):
        raise Invalid("payload.applications must be a list")
    with transaction(conn):
        conn.execute("DELETE FROM events")
        conn.execute("DELETE FROM applications")
        for a in apps:
            kind = a.get("kind")
            if kind not in ("active", "closed", "history"):
                raise Invalid(f"bad kind {kind!r} for {a.get('company')!r}")
            if not clean(a.get("company")):
                raise Invalid("every application needs a company")
            cur = conn.execute(
                f"INSERT INTO applications (kind, status, files, {', '.join(FIELDS)}) VALUES (?, ?, ?, {', '.join('?' * len(FIELDS))})",
                (kind, clean(a.get("status")), json.dumps(a.get("files") or []), *[clean(a.get(f), 1000) for f in FIELDS]),
            )
            for t in a.get("timeline") or []:
                _add_event(conn, cur.lastrowid, valid_date(t.get("date")), clean(t.get("text"), 2000),
                           t.get("kind") if t.get("kind") in ("timeline", "note", "status") else "timeline",
                           clean(t.get("source")) or "import")
        meta = payload.get("meta") or {}
        set_meta(conn, "inbox_checked", meta.get("inbox_checked") or "")
        set_meta(conn, "inbox_review", meta.get("inbox_review") or [])
        # Appearance settings aren't application data: keep them unless the payload carries them.
        for slot, value in (meta.get("prefs") or {}).items():
            if slot in PREF_SLOTS and (value is None or isinstance(value, dict)):
                set_meta(conn, f"prefs_{slot}", value)
        _bump(conn)
    return {"imported": len(apps)}
