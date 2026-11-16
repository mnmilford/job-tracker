"""Overlapping writes (e.g. an agent's sync while the phone saves) must all land."""
from concurrent.futures import ThreadPoolExecutor

from conftest import H, TOKEN

AUTH = {"Authorization": f"Bearer {TOKEN}"}


def test_concurrent_writes_all_succeed(seeded):
    apps = seeded.get("/api/applications?kind=active", headers=AUTH).json()
    target = apps[0]["id"]
    before = len(seeded.get(f"/api/applications/{target}", headers=AUTH).json()["timeline"])

    def write(i):
        hdrs = AUTH if i % 2 else H
        r = seeded.patch(f"/api/applications/{target}", json={"note": f"note {i}"}, headers=hdrs)
        r2 = seeded.get("/api/dashboard", headers=AUTH)
        return r.status_code, r2.status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(write, range(40)))
    assert all(r == (200, 200) for r in results), [r for r in results if r != (200, 200)][:5]
    after = seeded.get(f"/api/applications/{target}", headers=AUTH).json()["timeline"]
    assert len(after) == before + 40
    assert sorted(t["text"] for t in after if t["text"].startswith("note ")) == sorted(f"note {i}" for i in range(40))
