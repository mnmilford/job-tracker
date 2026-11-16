"""HTTP layer. Run: uvicorn app.main:app --host 127.0.0.1 --port 8300"""
import hmac
import json
import os
import tempfile
from pathlib import Path

from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import tracker
from .config import Settings
from .db import connect

STATIC = Path(__file__).parent / "static"
DEMO_SEED = Path(__file__).parent.parent / "demo" / "seed.json"
LOCAL_PEERS = {"127.0.0.1", "::1", "testclient"}   # "testclient" is FastAPI's test client


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    settings.check()
    if settings.demo_mode:
        # Fresh copy of the fake data on every start; visitors can click around freely.
        settings.db_path = os.path.join(tempfile.mkdtemp(prefix="job-tracker-demo-"), "demo.db")
    conn = connect(settings.db_path)
    if settings.demo_mode and DEMO_SEED.exists():
        tracker.import_all(conn, json.loads(DEMO_SEED.read_text()))

    app = FastAPI(title="Job Tracker", docs_url=None, redoc_url=None, openapi_url="/api/openapi.json")
    app.state.settings, app.state.conn = settings, conn

    # ---- auth ----
    def caller(request: Request) -> str:
        """Who is calling: a token name, 'browser' (came through the proxy login), or 'demo'."""
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            token = header[7:].strip()
            for known, name in settings.api_tokens.items():
                if hmac.compare_digest(token, known):
                    return name
            raise HTTPException(401, "Invalid API token")
        if settings.demo_mode:
            return "demo"
        # No token: trusted only when it comes from this machine, i.e. through the
        # proxy, which already made the browser sign in. If the port is ever exposed
        # by mistake, outside callers still get nothing without a token.
        if (request.client.host if request.client else "") not in LOCAL_PEERS:
            raise HTTPException(401, "Sign in through the site, or send an API token")
        return "browser"

    def writer(request: Request, who: str = Depends(caller)) -> str:
        """Writes from a browser must be same-origin fetches. A cross-site form or
        image can't set this header, and a cross-site fetch that sets it needs a
        CORS preflight we never answer, so the proxy's login can't be ridden (CSRF)."""
        if who in ("browser", "demo") and request.headers.get("x-requested-with") != "job-tracker":
            raise HTTPException(403, "Missing X-Requested-With: job-tracker")
        return who

    def source_of(who: str) -> str:
        return "dashboard" if who in ("browser", "demo") else who

    @app.exception_handler(tracker.NotFound)
    async def _nf(_, exc):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(tracker.Invalid)
    async def _inv(_, exc):
        return JSONResponse({"detail": str(exc)}, status_code=422)

    # ---- pages ----
    @app.get("/healthz")
    def healthz():
        conn.execute("SELECT 1")
        return {"ok": True}

    @app.get("/", include_in_schema=False)
    def index(_: str = Depends(caller)):
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    # ---- reads ----
    @app.get("/api/dashboard")
    def get_dashboard(_: str = Depends(caller)):
        return tracker.dashboard(conn, settings)

    @app.get("/api/applications")
    def list_apps(kind: str | None = None, _: str = Depends(caller)):
        return tracker.list_applications(conn, kind)

    @app.get("/api/applications/{app_id}")
    def get_app(app_id: int, _: str = Depends(caller)):
        return tracker.get_application(conn, app_id)

    @app.get("/api/export")
    def export(_: str = Depends(caller)):
        return tracker.export_all(conn)

    # ---- writes ----
    @app.post("/api/applications", status_code=201)
    def create(data: dict = Body(...), who: str = Depends(writer)):
        return tracker.create_application(conn, data, source_of(who))

    @app.patch("/api/applications/{app_id}")
    def update(app_id: int, data: dict = Body(...), who: str = Depends(writer)):
        return tracker.update_application(conn, app_id, data, source_of(who))

    @app.post("/api/applications/{app_id}/events", status_code=201)
    def add_event(app_id: int, data: dict = Body(...), who: str = Depends(writer)):
        return tracker.add_event(conn, app_id, data.get("text"), data.get("date"), data.get("kind") or "timeline", source_of(who))

    @app.delete("/api/applications/{app_id}/events/{event_id}")
    def delete_note(app_id: int, event_id: int, _: str = Depends(writer)):
        return tracker.delete_event(conn, app_id, event_id)

    @app.put("/api/inbox")
    def put_inbox(data: dict = Body(...), _: str = Depends(writer)):
        return tracker.set_inbox(conn, data.get("checked"), data.get("review"))

    @app.post("/api/import")
    def do_import(data: dict = Body(...), who: str = Depends(writer)):
        if who in ("browser", "demo"):
            raise HTTPException(403, "Import replaces everything; only an API token can do it")
        return tracker.import_all(conn, data)

    return app


app = create_app() if os.environ.get("JOB_TRACKER_NO_AUTOAPP") != "1" else None
