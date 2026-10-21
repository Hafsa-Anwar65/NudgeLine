#!/usr/bin/env python3
"""Nudgeline web app (runs only on your own computer).

    python app.py            ->  opens http://127.0.0.1:8000

Upload your data, pick a tone, run, then review / edit / approve the drafts in the browser.
Nothing is ever posted or sent: the app only drafts text and exports the rows you approve.
"""

import argparse
import contextlib
import json
import random
import re
import shutil
import sys
import threading
import time
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import accounts
import demo
from http.cookies import SimpleCookie
from drafter import both, comments, emails, review
from drafter import router
from drafter.common import ROOT, TONES, _find_keys, load_env
from drafter.router import Router as LLM

WEB = ROOT / "webui"
RUNS = ROOT / "output" / "ui"
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
JOBS = {}  # user id -> job state (each user has their own run)


def new_job():
    return {"state": "idle", "run": "", "done": 0, "total": 0, "log": [], "error": ""}
JOB_LOCK = threading.Lock()


# ---------- helpers ----------
def defaults(uid, user):
    d = {"name": user["name"], "service": "", "about": "", "tone": "friendly"}
    p = udir(uid) / "settings.json"
    if p.exists():
        try:
            d.update({k: v for k, v in json.loads(p.read_text(encoding="utf-8")).items() if k in d})
        except Exception:
            pass
    return d


def save_settings(uid, cfg):
    keep = {k: cfg[k] for k in ("name", "service", "about", "tone")}
    (udir(uid) / "settings.json").write_text(json.dumps(keep), encoding="utf-8")


def udir(uid):
    if not re.fullmatch(r"u[0-9a-f]{12}", uid or ""):
        raise ValueError("bad user")
    d = RUNS / "users" / uid
    (d / "uploads").mkdir(parents=True, exist_ok=True)
    return d


def list_runs(uid):
    runs = sorted(udir(uid).glob("run_*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [p.stem for p in runs if not p.stem.endswith("_approved")]


def run_path(uid, run_id):
    if not re.fullmatch(r"run_[0-9_]+", run_id or ""):
        raise ValueError("bad run id")
    p = udir(uid) / f"{run_id}.csv"
    if not p.exists():
        raise FileNotFoundError("run not found")
    return p


def describe_upload(path):
    try:
        records = both.load_records(path)
    except SystemExit as e:
        raise ValueError(str(e.code))
    raw = both._read_rows(path)
    cols = list(raw[0].keys()) if raw else []
    mapping = {}
    for field, label in (("notes", "Post"), ("company", "Business"), ("name", "Owner"), ("email", "Email")):
        for c in cols:
            if emails.norm_key(c) in emails.FIELD_MAP[field]:
                mapping[label] = c
                break
    return {
        "mapping": mapping,
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

    def __init__(self, uid):
        self.buf = ""
        self.uid = uid

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
            job = JOBS.setdefault(self.uid, new_job())
            job["log"].append(line)
            job["log"] = job["log"][-60:]
            m = re.search(r"(\d+) to process", line)
            if m:
                job["total"] = int(m.group(1))
            m = re.match(r"\[(\d+)/(\d+)\]", line)
            if m:
                job["done"], job["total"] = int(m.group(1)), int(m.group(2))


def worker(uid, cfg, out_path):
    started = time.time()
    try:
        with contextlib.redirect_stdout(Log(uid)):
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
                input=str(udir(uid) / "uploads" / cfg["file"]), output=str(out_path), limit=cfg["limit"],
                gap=0 if cfg["dry_run"] else 0.5, fetch_sites=False, template=template_path,
                dry_run=cfg["dry_run"],
            )
            llm = LLM(dry_run=cfg["dry_run"], model=cfg["model"])
            both.run(args, profile, llm)
            meta = {
                "source": re.sub(r"^\d+_", "", cfg["file"]), "tone": cfg["tone"], "dry_run": cfg["dry_run"],
                "model": "test run (no AI)" if cfg["dry_run"] else llm.summary(),  # admin-only, stripped for users
                "seconds": round(time.time() - started, 1), "finished": datetime.now().isoformat(timespec="seconds"),
            }
            out_path.with_suffix(".meta.json").write_text(json.dumps(meta), encoding="utf-8")
        with JOB_LOCK:
            JOBS[uid]["state"] = "done"
    except SystemExit as e:
        with JOB_LOCK:
            JOBS[uid].update(state="error", error=str(e.code))
    except Exception as e:  # keep the server alive whatever happens
        with JOB_LOCK:
            JOBS[uid].update(state="error", error=f"{type(e).__name__}: {e}")


def read_run(uid, run_id):
    _, rows = review.read_rows(run_path(uid, run_id))
    return rows


def public_meta(meta, user):
    """Only the admin may see which AI model wrote a run."""
    if user.get("admin"):
        return meta
    meta = {k: v for k, v in meta.items() if k != "model"}
    meta["model"] = "AI-written drafts"
    return meta


def visible_keys(user):
    keys = sorted(_find_keys())
    return keys if user and user.get("admin") else (["ready"] if keys else [])


def read_meta(uid, run_id):
    p = run_path(uid, run_id).with_suffix(".meta.json")
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except Exception:
        return {}


def approve_ready(uid, run_id):
    """Approve every row that has no warnings (status 'draft'). Rows needing a look stay untouched."""
    p = run_path(uid, run_id)
    with FILE_LOCK:
        fields, rows = review.read_rows(p)
        n = 0
        for r in rows:
            if r.get("status") == "draft":
                r["status"] = "approved"
                n += 1
        review.write_rows(p, fields, rows)
    return n


def update_row(uid, run_id, row_id, payload):
    p = run_path(uid, run_id)
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


def export_approved(uid, run_id):
    p = run_path(uid, run_id)
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

    # ----- auth helpers -----
    def token(self):
        c = SimpleCookie(self.headers.get("Cookie") or "")
        return c["nl_session"].value if "nl_session" in c else ""

    def user(self):
        return accounts.user_for(self.token())

    def need_user(self):
        u = self.user()
        if not u:
            raise PermissionError("Please sign in first.")
        return u

    def cookie(self, token, age):
        return {"Set-Cookie": f"nl_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={age}"}

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
            if url.path == "/api/me":
                load_env()
                u = self.user()
                return self.send(200, {"user": u, "plans": accounts.PLANS, "keys": visible_keys(u)})
            if url.path == "/api/demo":  # public: ready-made example results, nothing is written
                return self.send(200, {"rows": demo.DEMO_ROWS, "meta": demo.DEMO_META})
            u = self.need_user()
            uid = u["id"]
            if url.path == "/api/status":
                load_env()
                with JOB_LOCK:
                    job = dict(JOBS.get(uid) or new_job())
                    job["log"] = list(job["log"][-8:])
                return self.send(200, {"keys": visible_keys(u), "job": job, "runs": list_runs(uid),
                                       "defaults": defaults(uid, u), "tones": list(TONES),
                                       "admin_unread": router.unread_count() if u["admin"] else 0})
            if url.path.startswith("/api/admin/"):
                if not u["admin"]:
                    return self.fail(403, "Admin only.")
                if url.path == "/api/admin/dashboard":
                    load_env()
                    return self.send(200, router.dashboard())
                return self.fail(404, "Not found")
            if url.path == "/api/models":
                if not u["admin"]:
                    return self.send(200, {"models": []})
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
                return self.send(200, {"run": run, "rows": read_run(uid, run), "meta": public_meta(read_meta(uid, run), u)})
            if url.path == "/api/export":
                run = parse_qs(url.query).get("run", [""])[0]
                data, name = export_approved(uid, run)
                return self.send(200, data, "text/csv; charset=utf-8",
                                 {"Content-Disposition": f'attachment; filename="{name}"'})
            self.fail(404, "Not found")
        except PermissionError as e:
            self.fail(401, str(e))
        except (ValueError, FileNotFoundError) as e:
            self.fail(400, str(e))
        except Exception as e:
            self.fail(500, f"{type(e).__name__}: {e}")

    def do_POST(self):
        if self.headers.get("X-Nudgeline") != "1":  # blocks cross-site form posts
            return self.fail(403, "Forbidden")
        url = urlparse(self.path)
        try:
            if url.path in ("/api/signup", "/api/login"):
                d = self.json_body()
                if url.path == "/api/signup":
                    user = accounts.signup(d.get("email"), d.get("name"), d.get("password"))
                else:
                    user = accounts.login(d.get("email"), d.get("password"))
                tok = accounts.new_session(user["id"])
                return self.send(200, {"user": user}, extra=self.cookie(tok, 30 * 86400))
            if url.path == "/api/logout":
                accounts.end_session(self.token())
                return self.send(200, {"ok": True}, extra=self.cookie("", 0))
            u = self.need_user()
            uid = u["id"]
            up = udir(uid) / "uploads"
            if url.path.startswith("/api/admin/"):
                if not u["admin"]:
                    return self.fail(403, "Admin only.")
                load_env()
                d = self.json_body()
                if url.path == "/api/admin/reset":
                    router.reset(str(d.get("id", "")))
                    return self.send(200, router.dashboard())
                if url.path == "/api/admin/read":
                    router.mark_read()
                    return self.send(200, router.dashboard())
                if url.path == "/api/admin/test":
                    ok, msg = LLM().test(str(d.get("id", "")))
                    return self.send(200, {"ok": ok, "message": msg, "dashboard": router.dashboard()})
                return self.fail(404, "Not found")
            if url.path == "/api/plan":
                d = self.json_body()
                return self.send(200, {"user": accounts.set_plan(uid, str(d.get("plan", "")))})
            if url.path == "/api/upload":
                name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(self.headers.get("X-Filename", "data.csv")).name)
                if Path(name).suffix.lower() not in (".csv", ".xlsx", ".xlsm", ".json"):
                    raise ValueError("Use a .csv, .xlsx or .json file.")
                dest = up / f"{datetime.now():%H%M%S}_{name}"
                dest.write_bytes(self.body())
                try:
                    return self.send(200, describe_upload(dest))
                except Exception:
                    dest.unlink(missing_ok=True)
                    raise
            if url.path == "/api/sample":
                which = (self.json_body() or {}).get("which")
                src, name = (("more_samples.csv", "sample_20_leads.csv") if which == "more" else ("old_data.csv", "sample_old_data.csv"))
                dest = up / name
                shutil.copy(ROOT / "sample" / src, dest)
                return self.send(200, describe_upload(dest))
            if url.path == "/api/quick":  # paste one post, get one comment (nothing is saved or posted)
                d = self.json_body()
                post = str(d.get("post", "")).strip()[:2000]
                if len(post) < 5:
                    raise ValueError("Paste the post text first.")
                name = str(d.get("name", "")).strip()[:60] or u["name"]
                service = str(d.get("service", "")).strip()[:200]
                about = str(d.get("about", "")).strip()[:400]
                if not service or not about:
                    raise ValueError("Fill in 'Service you offer' and 'About you' first (step 2 below).")
                tone = d.get("tone") if d.get("tone") in TONES else "friendly"
                dry = bool(d.get("dry_run"))
                if not dry:
                    load_env()
                    if not _find_keys():
                        raise ValueError("AI is not set up yet. Ask the admin to add an API key, or tick 'Test run'.")
                profile = {"name": name, "service": service, "about": about, "tone": tone}
                user_msg = (f"Style for this comment: {random.choice(comments.STYLE_HINTS)}\n\n"
                            f"Post author: unknown\nPost text:\n{post}")
                fallback = {"relevant": True, "intent_score": 3, "language": "English", "reason": "test run, no AI used",
                            "comment": "Test run: the AI comment will appear here."}
                res = LLM(dry_run=dry).ask_json(comments.build_system_prompt(profile), user_msg, fallback, max_tokens=450)
                info = comments.interpret(res)
                if "error" in info:
                    raise ValueError(info["error"])
                return self.send(200, {"relevant": info["relevant"], "comment": info["comment"], "reason": info["reason"],
                                       "intent": info["intent"], "priority": info["priority"], "language": info["language"],
                                       "flags": info["flags"]})
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
                    "model": re.sub(r"[^A-Za-z0-9._:/-]", "", str(d.get("model", "")))[:80] if u["admin"] else "",
                    "dry_run": bool(d.get("dry_run")),
                }
                if not (up / cfg["file"]).is_file():
                    raise ValueError("Upload a file first.")
                if not cfg["service"] or not cfg["about"]:
                    raise ValueError("Fill in 'Service you offer' and 'About you'.")
                if cfg["limit"] > u["max_leads"]:
                    raise ValueError(f"The {u['plan_name']} plan allows up to {u['max_leads']} leads per run. "
                                     "Pick a smaller number or change your plan.")
                if not cfg["dry_run"]:
                    load_env()
                    if not _find_keys():
                        raise ValueError("AI is not set up yet. Ask the admin to add an API key, or tick 'Test run'.")
                with JOB_LOCK:
                    if (JOBS.get(uid) or {}).get("state") == "running":
                        raise ValueError("A run is already in progress.")
                    run_id = f"run_{datetime.now():%Y%m%d_%H%M%S}"
                    JOBS[uid] = dict(new_job(), state="running", run=run_id)
                save_settings(uid, cfg)
                threading.Thread(target=worker, args=(uid, cfg, udir(uid) / f"{run_id}.csv"), daemon=True).start()
                return self.send(200, {"run": run_id})
            if url.path == "/api/bulk":
                d = self.json_body()
                if d.get("action") != "approve_ready":
                    raise ValueError("Unknown action")
                return self.send(200, {"approved": approve_ready(uid, d.get("run", ""))})
            if url.path == "/api/update":
                d = self.json_body()
                return self.send(200, update_row(uid, d.get("run", ""), d.get("id", ""), d))
            self.fail(404, "Not found")
        except PermissionError as e:
            self.fail(401, str(e))
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
