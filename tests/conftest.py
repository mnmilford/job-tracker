import os

os.environ["JOB_TRACKER_NO_AUTOAPP"] = "1"   # don't build the module-level app from the real environment

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

TOKEN = "t" * 40
SECRET = "s" * 40
H = {"X-Requested-With": "job-tracker"}


def make(tmp_path, **kw):
    s = Settings()
    s.db_path = str(tmp_path / "t.db")
    s.api_tokens = {TOKEN: "claude"}
    s.proxy_secret = SECRET
    s.demo_mode = False
    s.owner_name = "Test"
    for k, v in kw.items():
        setattr(s, k, v)
    # By default the client behaves like a browser that came through the Authelia login.
    return TestClient(create_app(s), headers={"X-Proxy-Secret": SECRET})


@pytest.fixture
def client(tmp_path):
    return make(tmp_path)


@pytest.fixture
def seeded(client):
    import json
    from pathlib import Path
    data = json.loads((Path(__file__).parent.parent / "demo" / "seed.json").read_text())
    r = client.post("/api/import", json=data, headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200, r.text
    return client
