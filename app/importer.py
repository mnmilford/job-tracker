"""Convert a markdown job-search repo into job-tracker's import format.

Reads the layout the original repo used:
  README.md      "## Active", "## Closed", "## History..." tables,
                 "Inbox last checked: YYYY-MM-DD", bullets under "## Inbox: needs review"
  applications/<folder>/notes.md    "Verdict: ..." line, "## Timeline" bullets "- YYYY-MM-DD: text"
  applications/<folder>/posting.md  "URL: ..." line

Usage:
  python -m app.importer /path/to/job-search > export.json
  curl -X POST https://<host>/api/import -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" --data @export.json

The output holds real data: keep it out of this repo (export*.json is gitignored).
"""
import json
import re
import sys
from pathlib import Path


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse_tables(md: str) -> dict[str, list[dict]]:
    sections: dict[str, list[dict]] = {}
    section, header = None, None
    for line in md.splitlines():
        h = re.match(r"^##\s+(.*)", line)
        if h:
            section, header = h.group(1).strip(), None
            continue
        if not section or not line.strip().startswith("|"):
            header = None
            continue
        cells = _cells(line)
        if header is None:
            header = [c.lower() for c in cells]
            continue
        if all(re.fullmatch(r":?-+:?", c) for c in cells):
            continue
        sections.setdefault(section, []).append(dict(zip(header, cells + [""] * (len(header) - len(cells)))))

    def pick(prefix: str) -> list[dict]:
        return [r for k, rows in sections.items() if k.lower().startswith(prefix) for r in rows]

    return {"active": pick("active"), "closed": pick("closed"), "history": pick("history")}


def read_folder(root: Path, rel: str) -> dict:
    info = {"files": [], "verdict": "", "timeline": [], "posting_url": ""}
    d = root / rel if rel else None
    if not d or not d.is_dir():
        return info
    info["files"] = sorted(f.name for f in d.iterdir() if f.is_file() and not f.name.startswith(".")
                           and f.suffix.lower() not in (".pdf", ".png"))
    notes = d / "notes.md"
    if notes.exists():
        md = notes.read_text(encoding="utf-8")
        v = re.search(r"^Verdict:\s*(.+)$", md, re.M)
        if v and "match / stretch / miss" not in v.group(1):
            info["verdict"] = v.group(1).strip()
        tl = re.split(r"^## Timeline\s*$", md, flags=re.M)
        if len(tl) > 1:
            body = re.split(r"^##\s", tl[1], flags=re.M)[0]
            for m in re.finditer(r"^- (\d{4}-\d{2}-\d{2}):\s*(.+)$", body, re.M):
                info["timeline"].append({"date": m.group(1), "text": m.group(2).strip(), "kind": "timeline", "source": "import"})
    posting = d / "posting.md"
    if posting.exists():
        u = re.search(r"^URL:\s*(https?://\S+)", posting.read_text(encoding="utf-8"), re.M)
        if u:
            info["posting_url"] = u.group(1)
    return info


def convert(root: Path) -> dict:
    readme = (root / "README.md").read_text(encoding="utf-8")
    tables = parse_tables(readme)
    apps = []
    for kind, rows in tables.items():
        for r in rows:
            folder = (re.search(r"\(([^)]+)\)", r.get("folder", "")) or [None, ""])[1]
            f = read_folder(root, folder)
            apps.append({
                "kind": kind,
                "found": r.get("found", ""),
                "company": r.get("company", ""),
                "role": r.get("role", ""),
                "comp": r.get("comp", ""),
                "source": r.get("source", ""),
                "status": r.get("status", ""),
                "next_step": r.get("next step", ""),
                "lesson": r.get("why it closed / lesson") or r.get("framing / lesson") or "",
                "folder": folder,
                "posting_url": f["posting_url"],
                "verdict": f["verdict"],
                "files": f["files"],
                "timeline": f["timeline"],
            })
    checked = re.search(r"^Inbox last checked:\s*(\d{4}-\d{2}-\d{2})", readme, re.M)
    review_block = re.split(r"^##\s+Inbox: needs review\s*$", readme, flags=re.M)
    review = []
    if len(review_block) > 1:
        body = re.split(r"^##\s", review_block[1], flags=re.M)[0]
        review = [l[2:].strip() for l in re.findall(r"^- .+$", body, re.M) if not re.match(r"_?none", l[2:].strip(), re.I)]
    return {
        "format": "job-tracker/1",
        "applications": apps,
        "meta": {"inbox_checked": checked.group(1) if checked else "", "inbox_review": review},
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.importer /path/to/job-search > export.json")
    json.dump(convert(Path(sys.argv[1])), sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
