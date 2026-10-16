#!/usr/bin/env python3
"""Nudgeline web app (runs only on your own computer).

    python app.py            ->  opens http://127.0.0.1:8000

Upload your data, pick a tone, run, then review / edit / approve the drafts in the browser.
Nothing is ever posted or sent: the app only drafts text and exports the rows you approve.
"""

import argparse
import contextlib
import json
import re
import shutil
import sys
import threading
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

from drafter import both, comments, emails, review
from drafter.common import LLM, ROOT, TONES, _find_keys, load_env

WEB = ROOT / "webui"
RUNS = ROOT / "output" / "ui"
UPLOADS = RUNS / "uploads"
MAX_BODY = 8 * 1024 * 1024
SITE = ROOT / "frontend"
STATIC = {  # URL -> (file, content type)
    "/site/": (SITE / "index.html", "text/html; charset=utf-8"),
    "/site/styles.css": (SITE / "styles.css", "text/css; charset=utf-8"),
    "/site/script.js": (SITE / "script.js", "application/javascript; charset=utf-8"),
    "/app": (WEB / "index.html", "text/html; charset=utf-8"),
    "/styles.css": (WEB / "styles.css", "text/css; charset=utf-8"),
    "/app.js": (WEB / "app.js", "application/javascript; charset=utf-8"),
}
EDITABLE = ("comment", "subject", "body")
FILE_LOCK = threading.Lock()
JOB = {"state": "idle", "run": "", "done": 0, "total": 0, "log": [], "error": ""}
JOB_LOCK = threading.Lock()


# ---------- helpers ----------
def defaults():
    p = ROOT / "profile.json"
    d = {"name": "", "service": "", "about": "", "tone": "friendly"}
    if p.exists():
        try:
            d.update({k: v for k, v in json.loads(p.read_text(encoding="utf-8")).items() if k in d})
        except Exception:
            pass
    return d


def list_runs():
    RUNS.mkdir(parents=True, exist_ok=True)
    runs = sorted(RUNS.glob("run_*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [p.stem for p in runs if not p.stem.endswith("_approved")]


def run_path(run_id):
    if not re.fullmatch(r"run_[0-9_]+", run_id or ""):
        raise ValueError("bad run id")
    p = RUNS / f"{run_id}.csv"
    if not p.exists():
        raise FileNotFoundError("run not found")
    return p


def describe_upload(path):
    try:
        records = both.load_records(path)
    except SystemExit as e:
        raise ValueError(str(e.code))
    raw = both._read_rows(path)
    return {
        "file": Path(path).name,
        "rows": len(raw),
        "usable": len(records),
        "columns": list(raw[0].keys()) if raw else [],
        "preview": [
            {"company": r["company"], "owner": r["name"], "email": r["email"], "post": r["notes"][:90]}
            for r in records[:3]
        ],
    }


class Log:
    """Collects the tool's printed lines so the browser can show progress."""

    def __init__(self):
        self.buf = ""

    def write(self, s):
        self.buf += s
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            self.line(line.strip())
        return len(s)

    def flush(self):
        pass

    def line(self, line):
        if not line:
            return
        with JOB_LOCK:
            JOB["log"].append(line)
            JOB["log"] = JOB["log"][-60:]
            m = re.search(r"(\d+) to process", line)
            if m:
                JOB["total"] = int(m.group(1))
            m = re.match(r"\[(\d+)/(\d+)\]", line)
            if m:
                JOB["done"], JOB["total"] = int(m.group(1)), int(m.group(2))


def worker(cfg, out_path):
    try:
        with contextlib.redirect_stdout(Log()):
            name = cfg["name"] or "Me"
            profile = {
                "name": name, "service": cfg["service"], "about": cfg["about"], "tone": cfg["tone"],
                "signoff": name, "opt_out_line": "If this isn't relevant, just reply 'no' and I won't email again.",
            }
            template_path = None
            if cfg["template"].strip():
                template_path = str(out_path.with_suffix(".template.txt"))
                Path(template_path).write_text(cfg["template"].strip(), encoding="utf-8")
            args = SimpleNamespace(
                input=str(UPLOADS / cfg["file"]), output=str(out_path), limit=cfg["limit"],
                gap=0 if cfg["dry_run"] else 0.5, fetch_sites=False, template=template_path,
                dry_run=cfg["dry_run"],
            )
            both.run(args, profile, LLM(dry_run=cfg["dry_run"], model=cfg["model"]))
        with JOB_LOCK:
            JOB["state"] = "done"
    except SystemExit as e:
        with JOB_LOCK:
            JOB.update(state="error", error=str(e.code))
    except Exception as e:  # keep the server alive whatever happens
        with JOB_LOCK:
            JOB.update(state="error", error=f"{type(e).__name__}: {e}")


def read_run(run_id):
    _, rows = review.read_rows(run_path(run_id))
    return rows


def update_row(run_id, row_id, payload):
    p = run_path(run_id)
    with FILE_LOCK:
        fields, rows = review.read_rows(p)
        row = next((r for r in rows if r.get("id") == row_id), None)
        if not row:
            raise FileNotFoundError("row not found")
        for k in EDITABLE:
            if k in payload and isinstance(payload[k], str):
                row[k] = payload[k]
        decision = payload.get("decision")
        if decision == "approve":
            row["status"] = "approved"
        elif decision == "reject":
            row["status"] = "rejected"
        elif decision == "reset":
            row["status"] = "needs_edit" if row.get("qa_flags") else "draft"
        review.write_rows(p, fields, rows)
        return row


def export_approved(run_id):
    p = run_path(run_id)
    fields, rows = review.read_rows(p)
    ready = [r for r in rows if r.get("status") == "approved"]
    if not ready:
        raise ValueError("No approved rows yet. Approve at least one draft first.")
    stamp = datetime.now().isoformat(timespec="seconds")
    for r in ready:
        r["reviewed_at"] = stamp
    out = p.with_name(p.stem + "_approved.csv")
    review.write_rows(out, fields + ["reviewed_at"], ready)
    return out.read_bytes(), out.name


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "Nudgeline"

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code, msg):
        self.send(code, {"error": msg})

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("File is too large (limit 8 MB).")
        return self.rfile.read(n) if n else b""

    def json_body(self):
        raw = self.body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path in ("/", "/index.html"):
                return self.send(302, b"", "text/plain", {"Location": "/site/" if SITE.exists() else "/app"})
            if url.path == "/site":
                return self.send(302, b"", "text/plain", {"Location": "/site/"})
            if url.path in STATIC:
                path, ctype = STATIC[url.path]
                if not path.exists():
                    return self.fail(404, "Not found")
                return self.send(200, path.read_bytes(), ctype)
            if url.path == "/api/status":
                load_env()
                with JOB_LOCK:
                    job = dict(JOB, log=list(JOB["log"][-8:]))
                return self.send(200, {"keys": sorted(_find_keys()), "job": job, "runs": list_runs(),
                                       "defaults": defaults(), "tones": list(TONES)})
            if url.path == "/api/models":
                load_env()
                try:
                    llm = LLM()
                    return self.send(200, {"provider": llm.provider, "default": llm.model, "models": llm.available_models()})
                except SystemExit as e:
                    return self.send(200, {"provider": "", "default": "", "models": [], "note": str(e.code)})
                except Exception as e:
                    return self.send(200, {"provider": "", "default": "", "models": [], "note": f"{type(e).__name__}: {e}"})
            if url.path == "/api/results":
                run = parse_qs(url.query).get("run", [""])[0]
                return self.send(200, {"run": run, "rows": read_run(run)})
            if url.path == "/api/export":
                run = parse_qs(url.query).get("run", [""])[0]
                data, name = export_approved(run)
                return self.send(200, data, "text/csv; charset=utf-8",
                                 {"Content-Disposition": f'attachment; filename="{name}"'})
            self.fail(404, "Not found")
        except (ValueError, FileNotFoundError) as e:
            self.fail(400, str(e))
        except Exception as e:
            self.fail(500, f"{type(e).__name__}: {e}")

    def do_POST(self):
        if self.headers.get("X-Nudgeline") != "1":  # blocks cross-site form posts
            return self.fail(403, "Forbidden")
        url = urlparse(self.path)
        try:
            if url.path == "/api/upload":
                name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(self.headers.get("X-Filename", "data.csv")).name)
                if Path(name).suffix.lower() not in (".csv", ".xlsx", ".xlsm", ".json"):
                    raise ValueError("Use a .csv, .xlsx or .json file.")
                UPLOADS.mkdir(parents=True, exist_ok=True)
                dest = UPLOADS / f"{datetime.now():%H%M%S}_{name}"
                dest.write_bytes(self.body())
                try:
                    return self.send(200, describe_upload(dest))
                except Exception:
                    dest.unlink(missing_ok=True)
                    raise
            if url.path == "/api/sample":
                UPLOADS.mkdir(parents=True, exist_ok=True)
                dest = UPLOADS / "sample_old_data.csv"
                shutil.copy(ROOT / "sample" / "old_data.csv", dest)
                return self.send(200, describe_upload(dest))
            if url.path == "/api/run":
                d = self.json_body()
                cfg = {
                    "file": Path(str(d.get("file", ""))).name,
                    "name": str(d.get("name", "")).strip()[:60],
                    "service": str(d.get("service", "")).strip()[:200],
                    "about": str(d.get("about", "")).strip()[:400],
                    "tone": d.get("tone") if d.get("tone") in TONES else "friendly",
                    "template": str(d.get("template", ""))[:3000],
                    "limit": max(1, min(int(d.get("limit") or 5), 200)),
                    "model": re.sub(r"[^A-Za-z0-9._:/-]", "", str(d.get("model", "")))[:80],
                    "dry_run": bool(d.get("dry_run")),
                }
                if not (UPLOADS / cfg["file"]).is_file():
                    raise ValueError("Upload a file first.")
                if not cfg["service"] or not cfg["about"]:
                    raise ValueError("Fill in 'Service you offer' and 'About you'.")
                if not cfg["dry_run"]:
                    load_env()
                    if not _find_keys():
                        raise ValueError("No API key found. Add GROQ_API_KEY to the .env file, or tick 'Test run'.")
                with JOB_LOCK:
                    if JOB["state"] == "running":
                        raise ValueError("A run is already in progress.")
                    run_id = f"run_{datetime.now():%Y%m%d_%H%M%S}"
                    JOB.update(state="running", run=run_id, done=0, total=0, log=[], error="")
                RUNS.mkdir(parents=True, exist_ok=True)
                threading.Thread(target=worker, args=(cfg, RUNS / f"{run_id}.csv"), daemon=True).start()
                return self.send(200, {"run": run_id})
            if url.path == "/api/update":
                d = self.json_body()
                return self.send(200, update_row(d.get("run", ""), d.get("id", ""), d))
            self.fail(404, "Not found")
        except (ValueError, FileNotFoundError, json.JSONDecodeError) as e:
            self.fail(400, str(e))
        except Exception as e:
            self.fail(500, f"{type(e).__name__}: {e}")


def main():
    ap = argparse.ArgumentParser(description="Nudgeline web app")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    load_env()
    RUNS.mkdir(parents=True, exist_ok=True)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    except OSError:
        sys.exit(f"Port {a.port} is busy. Try: python app.py --port {a.port + 1}")
    url = f"http://127.0.0.1:{a.port}/"
    print(f"Nudgeline is running at {url}  (press Ctrl+C to stop)")
    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
