"""Local user accounts for the Nudgeline web app.

Everything is stored in output/users.json and output/sessions.json on your own computer.
Passwords are hashed with scrypt (never stored as plain text). No payment is ever taken:
plans are a local switch that only changes how many leads one run may contain.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from datetime import datetime

from drafter.common import ROOT

DIR = ROOT / "output"
USERS = DIR / "users.json"
SESSIONS = DIR / "sessions.json"
LOCK = threading.Lock()
SESSION_DAYS = 30
FAILS = {}  # email -> (count, locked_until)

PLANS = {
    "free": {"name": "Free", "price": 0, "max_leads": 10,
             "points": ["Up to 10 leads per run", "Comments and emails", "Review, edit and export"]},
    "pro": {"name": "Pro", "price": 12, "max_leads": 100,
            "points": ["Up to 100 leads per run", "Everything in Free", "Best for regular outreach"]},
    "team": {"name": "Team", "price": 29, "max_leads": 200,
             "points": ["Up to 200 leads per run", "Everything in Pro", "Built for bigger lists"]},
}


class AuthError(ValueError):
    pass


def _read(path):
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        return {}


def _write(path, data):
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    tmp.replace(path)


def _hash(pw, salt=None):
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return salt.hex() + "$" + h.hex()


def _check(pw, stored):
    salt_hex, _ = stored.split("$", 1)
    return hmac.compare_digest(_hash(pw, bytes.fromhex(salt_hex)), stored)


def is_admin(u, users=None):
    """Admin = listed in ADMIN_EMAILS (.env), or the first account ever created."""
    listed = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
    if listed:
        return u["email"] in listed
    users = users if users is not None else _read(USERS)
    first = min(users.values(), key=lambda x: x.get("created", ""), default=None)
    return bool(first) and first["id"] == u["id"]


def public(u, users=None):
    plan = PLANS.get(u.get("plan"), PLANS["free"])
    return {"admin": is_admin(u, users), "id": u["id"], "email": u["email"], "name": u["name"], "plan": u.get("plan", "free"),
            "plan_name": plan["name"], "max_leads": plan["max_leads"], "created": u.get("created", "")}


def signup(email, name, pw):
    email = (email or "").strip().lower()
    name = (name or "").strip()[:60]
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise AuthError("Enter a valid email address.")
    if len(pw or "") < 8:
        raise AuthError("Password must be at least 8 characters.")
    with LOCK:
        users = _read(USERS)
        if any(u["email"] == email for u in users.values()):
            raise AuthError("An account with this email already exists. Try signing in.")
        uid = "u" + secrets.token_hex(6)
        users[uid] = {"id": uid, "email": email, "name": name or email.split("@")[0], "pw": _hash(pw),
                      "plan": "free", "created": datetime.now().isoformat(timespec="seconds")}
        _write(USERS, users)
        return public(users[uid])


def login(email, pw):
    email = (email or "").strip().lower()
    count, until = FAILS.get(email, (0, 0))
    if until > time.time():
        raise AuthError("Too many tries. Wait a minute and try again.")
    with LOCK:
        users = _read(USERS)
    user = next((u for u in users.values() if u["email"] == email), None)
    ok = bool(user) and _check(pw or "", user["pw"])
    if not ok:
        count += 1
        FAILS[email] = (count, time.time() + 60 if count >= 5 else 0)
        raise AuthError("Wrong email or password.")
    FAILS.pop(email, None)
    return public(user)


def new_session(uid):
    token = secrets.token_urlsafe(32)
    with LOCK:
        sessions = _read(SESSIONS)
        now = time.time()
        sessions = {k: v for k, v in sessions.items() if v["exp"] > now}
        sessions[hashlib.sha256(token.encode()).hexdigest()] = {"uid": uid, "exp": now + SESSION_DAYS * 86400}
        _write(SESSIONS, sessions)
    return token


def user_for(token):
    if not token:
        return None
    key = hashlib.sha256(token.encode()).hexdigest()
    with LOCK:
        s = _read(SESSIONS).get(key)
        if not s or s["exp"] < time.time():
            return None
        u = _read(USERS).get(s["uid"])
    return public(u) if u else None


def end_session(token):
    if not token:
        return
    with LOCK:
        sessions = _read(SESSIONS)
        sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None)
        _write(SESSIONS, sessions)


def set_plan(uid, plan):
    if plan not in PLANS:
        raise AuthError("Unknown plan.")
    with LOCK:
        users = _read(USERS)
        if uid not in users:
            raise AuthError("Account not found.")
        users[uid]["plan"] = plan
        users[uid]["plan_since"] = datetime.now().isoformat(timespec="seconds")
        _write(USERS, users)
        return public(users[uid])
