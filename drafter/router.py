"""Multi-model router: tries your AI models in order and moves on by itself when one runs out.

Only the admin ever sees which model is running. Usage, limits and notifications are kept in
output/admin/ and shown on the admin dashboard. Regular users and the run log never mention models.

Configure the order in .env (optional, otherwise it is built from the keys you have):

    LLM_CHAIN=groq:llama-3.3-70b-versatile,groq:openai/gpt-oss-120b@500000,xai:grok-4

`@N` after a model is an optional daily token budget that the dashboard uses to show what is left.
"""

import json
import os
import re
import sys
import threading
import time
from datetime import datetime

from .common import NON_CHAT, PREFERRED, PROVIDERS, REASONING_HINTS, ROOT, _find_keys, parse_json

ADMIN_DIR = ROOT / "output" / "admin"
USAGE_FILE = ADMIN_DIR / "usage.json"
EVENTS_FILE = ADMIN_DIR / "events.json"
MAX_EVENTS = 200
MAX_WAIT = 60  # if every model is cooling down for less than this, wait instead of failing the row
LOCK = threading.RLock()


# ---------- persisted state (shared by every run and the dashboard) ----------
def _read(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default
    except Exception:
        return default


def _write(path, data):
    ADMIN_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    tmp.replace(path)


def _today():
    return datetime.now().strftime("%Y-%m-%d")


def _blank():
    return {"day": _today(), "req": 0, "tok_in": 0, "tok_out": 0, "errors": 0, "last_used": "", "last_error": "",
            "until": 0, "disabled": "", "rl": {}, "low_day": ""}


def stat(entry_id):
    """Usage record for one model, reset automatically each new day."""
    with LOCK:
        data = _read(USAGE_FILE, {"entries": {}, "active": ""})
        rec = data["entries"].get(entry_id) or _blank()
        if rec.get("day") != _today():
            rec.update(day=_today(), req=0, tok_in=0, tok_out=0, errors=0, low_day="")
        return data, rec


def save_stat(data, entry_id, rec):
    with LOCK:
        data["entries"][entry_id] = rec
        _write(USAGE_FILE, data)


def add_event(level, kind, msg):
    with LOCK:
        events = _read(EVENTS_FILE, [])
        events.append({"ts": datetime.now().isoformat(timespec="seconds"), "level": level, "kind": kind,
                       "msg": msg, "read": False})
        _write(EVENTS_FILE, events[-MAX_EVENTS:])


def events(limit=40):
    return list(reversed(_read(EVENTS_FILE, [])[-limit:]))


def unread_count():
    return sum(1 for e in _read(EVENTS_FILE, []) if not e.get("read"))


def mark_read():
    with LOCK:
        ev = _read(EVENTS_FILE, [])
        for e in ev:
            e["read"] = True
        _write(EVENTS_FILE, ev)


# ---------- chain ----------
class Entry:
    def __init__(self, provider, model, budget=0):
        self.provider, self.model, self.budget = provider, model, budget
        self.id = f"{provider}:{model}"


def _parse_chain(text, keys):
    out, seen = [], set()
    for part in [p.strip() for p in text.split(",") if p.strip()]:
        budget = 0
        if "@" in part:
            part, b = part.rsplit("@", 1)
            budget = int(b) if b.strip().isdigit() else 0
        if ":" not in part:
            continue
        prov, model = part.split(":", 1)
        prov = prov.strip().lower()
        if prov in keys and model.strip() and f"{prov}:{model.strip()}" not in seen:
            seen.add(f"{prov}:{model.strip()}")
            out.append(Entry(prov, model.strip(), budget))
    return out


_DISCOVER = {}  # provider -> (time, [model ids]); refreshed hourly


def discover(prov, key):
    """Ask the provider which models are really free/available, so stale names don't break the chain."""
    now = time.time()
    if prov in _DISCOVER and now - _DISCOVER[prov][0] < 3600:
        return _DISCOVER[prov][1]
    found = []
    try:
        import httpx
        if prov == "openrouter":  # free variants only: price 0 for both prompt and completion
            data = httpx.get("https://openrouter.ai/api/v1/models", timeout=8).json().get("data", [])
            free = [m["id"] for m in data if m["id"].endswith(":free")
                    and str(m.get("pricing", {}).get("prompt")) in ("0", "0.0")
                    and str(m.get("pricing", {}).get("completion")) in ("0", "0.0")]
            rank = ("gpt-oss", "llama-3.3", "gemma", "qwen", "mistral", "deepseek")
            free.sort(key=lambda i: next((n for n, w in enumerate(rank) if w in i), len(rank)))
            found = free[:3]
        elif prov == "gemini":  # newest Flash models (the free tier is Flash only)
            data = httpx.get("https://generativelanguage.googleapis.com/v1beta/openai/models",
                             headers={"Authorization": f"Bearer {key}"}, timeout=8).json().get("data", [])
            ids = [m["id"].replace("models/", "") for m in data]
            flash = [i for i in ids if "flash" in i and not any(w in i for w in ("image", "tts", "live", "audio", "embed", "thinking", "exp"))]
            found = sorted(flash, reverse=True)[:2]
    except Exception:
        found = []
    _DISCOVER[prov] = (now, found)
    return found


def build_chain(preferred=""):
    """Models to try, best first. LLM_CHAIN wins; otherwise built from the keys that are set."""
    keys = _find_keys()
    chain = _parse_chain(os.environ.get("LLM_CHAIN", ""), keys)
    if not chain:
        legacy = os.environ.get("LLM_MODEL", "").strip()
        order = [p for p in os.environ.get("LLM_PROVIDER", "").lower().split(",") if p in keys] or list(keys)
        for prov in order:
            models = [legacy] if legacy and prov == order[0] else []
            if prov in PREFERRED:  # separate limits per model: up to three models from the same provider
                pool = discover(prov, keys[prov]) if prov in ("openrouter", "gemini") else []
                models += list(dict.fromkeys(m for m in pool + PREFERRED[prov] if m not in models))[:max(0, (4 if prov == "groq" else 3) - len(models))]
            else:
                models += [PROVIDERS[prov]["model"]]
            chain += [Entry(prov, m) for m in models]
    if preferred:  # the admin picked a model by hand: try it first, keep the rest as backup
        prov = chain[0].provider if chain else next(iter(keys), "")
        chain = [Entry(prov, preferred)] + [e for e in chain if e.id != f"{prov}:{preferred}"] if prov else chain
    return chain


# ---------- error handling ----------
def _seconds_from_message(msg):
    g = re.search(r"retrydelay\W+(\d+)s", msg)
    if g:
        return int(g.group(1)) + 1
    m = re.search(r"try again in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?", msg)
    if m and any(m.groups()):
        h, mi, s = (float(x) if x else 0 for x in m.groups())
        return int(h * 3600 + mi * 60 + s) + 1
    return 0


def classify(e):
    """('disable'|'cool'|None, seconds, reason). None means: try the same model again."""
    name, msg = type(e).__name__, str(e).lower()
    code = getattr(e, "status_code", None)
    if name in ("AuthenticationError", "PermissionDeniedError") or code in (401, 403):
        return "disable", 0, "API key rejected"
    if code == 404 or name == "NotFoundError" or (name == "BadRequestError" and "model" in msg):
        return "disable", 0, "model not available on this account"
    if code == 429 or name == "RateLimitError" or "rate limit" in msg or "quota" in msg:
        retry = 0
        try:
            retry = int(float(e.response.headers.get("retry-after", 0)))
        except Exception:
            pass
        retry = retry or _seconds_from_message(msg)
        daily = any(w in msg for w in ("per day", "perday", "tokens per day", "(tpd)", "(rpd)", "daily"))
        return "cool", max(retry, 900) if daily else (retry or 60), "daily limit reached" if daily or retry > 900 else "rate limited"
    if any(w in msg for w in ("credit balance", "insufficient funds", "insufficient credit", "payment required")) or code == 402:
        return "cool", 6 * 3600, "out of credit"
    if (code and code >= 500) or name in ("APIConnectionError", "APITimeoutError", "InternalServerError"):
        return "cool", 60, "provider error"
    return None, 0, ""


# ---------- the router ----------
class Router:
    """Same interface as common.LLM (dry_run, provider, model, ask_json, available_models)."""

    def __init__(self, dry_run=False, model=None):
        self.dry_run = dry_run
        self.provider = self.model = None
        self.explicit_model = False
        self.used = {}  # model id -> number of calls in this run (shown to the admin only)
        self.clients = {}
        self.entries = []
        if dry_run:
            return
        self.entries = build_chain((model or "").strip())
        if not self.entries:
            sys.exit("No API key found. Put GROQ_API_KEY, XAI_API_KEY or ANTHROPIC_API_KEY in .env (see .env.example).")
        self.provider, self.model = self.entries[0].provider, self.entries[0].model

    # -- clients
    def _client(self, prov):
        if prov not in self.clients:
            key = _find_keys()[prov]
            if prov == "anthropic":
                try:
                    import anthropic
                except ImportError:
                    sys.exit("Missing package. Run: pip install -r requirements.txt")
                self.clients[prov] = anthropic.Anthropic(api_key=key, max_retries=0)
            else:
                try:
                    from openai import OpenAI
                except ImportError:
                    sys.exit("Missing package. Run: pip install -r requirements.txt")
                self.clients[prov] = OpenAI(api_key=key, base_url=PROVIDERS[prov]["base_url"], max_retries=0)
        return self.clients[prov]

    def available_models(self):
        """Chat models the first provider offers (for the admin's model picker)."""
        if self.dry_run or not self.entries or self.entries[0].provider == "anthropic":
            return []
        ids = [m.id for m in self._client(self.entries[0].provider).models.list().data]
        return sorted(i for i in ids if not any(w in i.lower() for w in NON_CHAT))

    # -- one call to one model
    def _call(self, entry, system, user, max_tokens):
        client = self._client(entry.provider)
        if entry.provider == "anthropic":
            raw = client.messages.with_raw_response.create(
                model=entry.model, max_tokens=max_tokens, system=system, messages=[{"role": "user", "content": user}])
            resp = raw.parse()
            usage = (getattr(resp.usage, "input_tokens", 0), getattr(resp.usage, "output_tokens", 0))
            return resp.content[0].text, usage, dict(raw.headers)
        thinking = entry.provider == "xai" or any(h in entry.model.lower() for h in REASONING_HINTS)
        raw = client.chat.completions.with_raw_response.create(
            model=entry.model, max_tokens=max(max_tokens, 2000) if thinking else max_tokens,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
        resp = raw.parse()
        u = getattr(resp, "usage", None)
        usage = (getattr(u, "prompt_tokens", 0) or 0, getattr(u, "completion_tokens", 0) or 0)
        return resp.choices[0].message.content or "", usage, dict(raw.headers)

    # -- bookkeeping
    @staticmethod
    def _limits(headers):
        h = {k.lower(): v for k, v in headers.items()}
        def num(*names):
            for n in names:
                if n in h:
                    try:
                        return int(float(h[n]))
                    except ValueError:
                        pass
            return None
        rl = {"rem_req": num("x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining"),
              "lim_req": num("x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"),
              "rem_tok": num("x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"),
              "lim_tok": num("x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"),
              "at": datetime.now().isoformat(timespec="seconds")}
        return {k: v for k, v in rl.items() if v is not None}

    def _record_ok(self, entry, usage, headers):
        with LOCK:
            data, rec = stat(entry.id)
            rec["req"] += 1
            rec["tok_in"] += usage[0]
            rec["tok_out"] += usage[1]
            rec["last_used"] = datetime.now().isoformat(timespec="seconds")
            rl = self._limits(headers)
            if rl:
                rec["rl"] = rl
            prev = data.get("active", "")
            if prev != entry.id:
                if prev:
                    add_event("warn" if entry.id != self.entries[0].id else "info", "switch",
                              (f"Now using {entry.id}." if entry.id != self.entries[0].id else f"Back on the main model {entry.id}.")
                              + f" Before that: {prev}.")
                data["active"] = entry.id
            if rec.get("until"):
                rec["until"] = 0
            low = (entry.budget and entry.budget - rec["tok_in"] - rec["tok_out"] < entry.budget * 0.1) or \
                  (rl.get("rem_req") is not None and rl["rem_req"] <= 20)
            if low and rec.get("low_day") != _today():
                rec["low_day"] = _today()
                add_event("warn", "low", f"{entry.id} is running low on usage for today.")
            save_stat(data, entry.id, rec)
        self.used[entry.id] = self.used.get(entry.id, 0) + 1

    def _record_fail(self, entry, kind, secs, reason, err):
        with LOCK:
            data, rec = stat(entry.id)
            rec["errors"] += 1
            rec["last_error"] = f"{reason}: {str(err)[:160]}"
            if kind == "disable":
                rec["disabled"] = reason
            else:
                rec["until"] = time.time() + secs
            save_stat(data, entry.id, rec)
            until = "" if kind == "disable" else f" Retrying it in about {max(1, round(secs / 60))} min."
            nxt = next((e.id for e in self.entries if e.id != entry.id and self._available(e)), None)
            add_event("bad" if kind == "disable" else "warn", "disabled" if kind == "disable" else "cooldown",
                      f"{entry.id}: {reason}.{until} " + (f"Switching to {nxt}." if nxt else "No other model is available."))

    @staticmethod
    def _available(entry):
        _, rec = stat(entry.id)
        return not rec.get("disabled") and rec.get("until", 0) <= time.time()

    def _pick(self, skip):
        """First usable model in order. If all are only cooling down briefly, wait for the earliest one."""
        while True:
            for e in self.entries:
                if e.id not in skip and self._available(e):
                    return e
            waits = []
            for e in self.entries:
                if e.id in skip:
                    continue
                _, rec = stat(e.id)
                if not rec.get("disabled"):
                    waits.append(rec.get("until", 0) - time.time())
            if waits and min(waits) <= MAX_WAIT:
                time.sleep(max(1, min(waits)))
                continue
            return None

    # -- public
    def ask_json(self, system, user, fallback, max_tokens=500):
        if self.dry_run:
            return fallback
        skip, last = set(), None
        while True:
            entry = self._pick(skip)
            if entry is None:
                with LOCK:
                    ev = events(1)
                    if not ev or ev[0]["kind"] != "all_down":
                        add_event("bad", "all_down", "Every AI model is unavailable right now. Rows are marked failed and can be retried.")
                return {"_error": "The AI service is busy right now. Please try again in a few minutes."}
            for attempt in range(3):
                try:
                    text, usage, headers = self._call(entry, system, user, max_tokens)
                    result = parse_json(text)
                    self._record_ok(entry, usage, headers)
                    return result
                except (ValueError, json.JSONDecodeError) as e:  # bad JSON: ask again
                    last = e
                except Exception as e:
                    kind, secs, reason = classify(e)
                    if kind:
                        self._record_fail(entry, kind, secs, reason, e)
                        skip.add(entry.id)
                        break
                    last = e
                    time.sleep(2 * (attempt + 1))
            else:
                skip.add(entry.id)  # three plain failures on this model: try the next one, no cooldown
                with LOCK:
                    data, rec = stat(entry.id)
                    rec["errors"] += 1
                    rec["last_error"] = f"no valid answer: {str(last)[:160]}"
                    save_stat(data, entry.id, rec)

    def summary(self):
        """Admin-only text for the run record."""
        return ", ".join(f"{k} x{v}" for k, v in self.used.items()) or "no AI calls"

    def test(self, entry_id):
        """Admin button: send one tiny request to a model and report the result."""
        entry = next((e for e in self.entries if e.id == entry_id), None)
        if not entry:
            raise ValueError("Unknown model")
        try:
            self._call(entry, "Reply with the single word OK.", "ping", 60)
            with LOCK:
                data, rec = stat(entry.id)
                rec.update(disabled="", until=0)
                save_stat(data, entry.id, rec)
            return True, "Working"
        except Exception as e:
            kind, secs, reason = classify(e)
            return False, f"{reason or type(e).__name__}: {str(e)[:160]}"


def reset(entry_id=None):
    """Admin button: clear cooldowns and disabled flags (one model, or all)."""
    with LOCK:
        data = _read(USAGE_FILE, {"entries": {}, "active": ""})
        for eid, rec in data["entries"].items():
            if entry_id in (None, "", eid):
                rec.update(until=0, disabled="")
        _write(USAGE_FILE, data)
        add_event("info", "reset", f"Admin reset {entry_id or 'all models'}.")


def dashboard():
    """Everything the admin dashboard shows."""
    chain = build_chain()
    data = _read(USAGE_FILE, {"entries": {}, "active": ""})
    now = time.time()
    rows = []
    for i, e in enumerate(chain):
        _, rec = stat(e.id)
        if rec.get("disabled"):
            status = "disabled"
        elif rec.get("until", 0) > now:
            status = "cooling"
        else:
            status = "ready"
        used = rec["tok_in"] + rec["tok_out"]
        rows.append({
            "id": e.id, "provider": e.provider, "model": e.model, "order": i + 1, "status": status,
            "active": data.get("active") == e.id, "reason": rec.get("disabled", ""),
            "retry_in": max(0, int(rec.get("until", 0) - now)), "requests": rec["req"], "tokens": used,
            "errors": rec["errors"], "last_used": rec.get("last_used", ""), "last_error": rec.get("last_error", ""),
            "budget": e.budget, "budget_left": max(0, e.budget - used) if e.budget else None, "limits": rec.get("rl", {}),
        })
    return {"chain": rows, "active": data.get("active", ""), "events": events(), "unread": unread_count(),
            "keys": sorted(_find_keys()), "has_chain_env": bool(os.environ.get("LLM_CHAIN", "").strip())}
