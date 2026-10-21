"""Shared helpers: .env loading, profile, CSV resume, and the LLM call wrapper (Groq, Grok or Claude)."""

import csv
import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Supported providers. Groq and xAI both speak the OpenAI API format.
# Model names change over time: if you get "model not found", copy an exact name from your
# provider's console into LLM_MODEL in .env.
PROVIDERS = {
    "groq": {
        "env": "GROQ_API_KEY",
        "prefix": "gsk_",
        "model": "llama-3.3-70b-versatile",
        "base_url": "https://api.groq.com/openai/v1",
    },
    "gemini": {
        "env": "GEMINI_API_KEY",
        "prefix": "AIza",
        "model": "gemini-2.5-flash",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
    },
    "cerebras": {
        "env": "CEREBRAS_API_KEY",
        "prefix": "csk-",
        "model": "gpt-oss-120b",
        "base_url": "https://api.cerebras.ai/v1",
    },
    "openrouter": {
        "env": "OPENROUTER_API_KEY",
        "prefix": "sk-or-",
        "model": "openai/gpt-oss-20b:free",
        "base_url": "https://openrouter.ai/api/v1",
    },
    "xai": {
        "env": "XAI_API_KEY",
        "prefix": "xai-",
        "model": "grok-4",
        "base_url": "https://api.x.ai/v1",
    },
    "anthropic": {
        "env": "ANTHROPIC_API_KEY",
        "prefix": "sk-ant-",
        "model": "claude-sonnet-5-5",
        "base_url": None,
    },
}


TONES = {
    "friendly": "warm and friendly",
    "professional": "polished and professional, but still human",
    "casual": "relaxed and conversational",
}


def tone_line(profile):
    return TONES.get(str(profile.get("tone", "friendly")).lower(), TONES["friendly"])


# Models that are not chat/writing models (speech, safety classifiers, embeddings...).
NON_CHAT = ("whisper", "guard", "tts", "orpheus", "safeguard", "embed", "moderation", "playai")
# Preferred writing models per provider, best first. Used when your account can't use the default.
PREFERRED = {
    "groq": ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"],
    "xai": ["grok-4.3", "grok-4", "grok-3-mini"],
    "gemini": ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
    "cerebras": ["gpt-oss-120b", "qwen-3-32b"],
    "openrouter": ["openai/gpt-oss-20b:free", "meta-llama/llama-3.3-70b-instruct:free", "google/gemma-3-27b-it:free"],
}
# Reasoning models spend tokens thinking before they answer, so they need extra room.
REASONING_HINTS = ("gpt-oss", "qwen3", "qwen-3", "minimax", "deepseek-r1", "grok-4", "grok-3-mini", "gemini-2.5", "gemini-3")


def load_env():
    """Tiny .env loader so you don't need python-dotenv."""
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_profile(path):
    p = Path(path)
    if not p.exists():
        sys.exit(f"Profile file not found: {path}")
    profile = json.loads(p.read_text(encoding="utf-8"))
    for key in ("name", "service", "about"):
        if not profile.get(key):
            sys.exit(f"profile.json is missing '{key}'")
    profile.setdefault("signoff", profile["name"])
    profile.setdefault("tone", "friendly")
    profile.setdefault(
        "opt_out_line",
        "If this isn't relevant, just reply 'no' and I won't email again.",
    )
    return profile


def parse_json(text):
    m = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not m:
        raise ValueError("no JSON object in model response")
    return json.loads(m.group(0))


def done_ids(path, key):
    """IDs already written to the output CSV, so a re-run resumes instead of repeating.

    Rows that failed earlier (status == "error") are removed from the file first,
    so they get retried instead of being skipped as "already done".
    """
    p = Path(path)
    if not p.exists():
        return set()
    with p.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames or []
        rows = list(reader)
    good = [r for r in rows if r.get("status") != "error"]
    if len(good) != len(rows):
        with p.open("w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(good)
        print(f"Removed {len(rows) - len(good)} failed row(s) from {p.name}; they will be retried.")
    return {row.get(key, "") for row in good}


def prepare_output(path, fields):
    """If an old output file has different columns, keep it as <name>.old.csv instead of mixing formats."""
    p = Path(path)
    if not p.exists():
        return
    with p.open(newline="", encoding="utf-8-sig") as f:
        header = next(csv.reader(f), [])
    if header and header != list(fields):
        backup = p.with_name(p.stem + ".old.csv")
        n = 1
        while backup.exists():
            n += 1
            backup = p.with_name(f"{p.stem}.old{n}.csv")
        p.rename(backup)
        print(f"{p.name} was made by an older version (different columns); moved to {backup.name}. Starting a fresh file.")


def open_writer(path, fields):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    is_new = not p.exists()
    f = open(p, "a", newline="", encoding="utf-8-sig")
    writer = csv.DictWriter(f, fieldnames=fields)
    if is_new:
        writer.writeheader()
    return f, writer


def _find_keys():
    """Return {provider: key} for every API key set in the environment.

    A key's own prefix wins over the variable it was pasted into, so a Groq key
    (gsk_...) put in ANTHROPIC_API_KEY is still recognised as a Groq key.
    """
    found = {}
    for name, cfg in PROVIDERS.items():
        value = os.environ.get(cfg["env"], "").strip()
        if not value:
            continue
        owner = next((n for n, c in PROVIDERS.items() if value.startswith(c["prefix"])), name)
        found.setdefault(owner, value)
    return found


def _pick_provider():
    """Returns (provider, api_key)."""
    found = _find_keys()
    wanted = os.environ.get("LLM_PROVIDER", "").strip().lower()

    if wanted:
        if wanted not in PROVIDERS:
            sys.exit(f"LLM_PROVIDER must be one of: {', '.join(PROVIDERS)} (not '{wanted}').")
        if wanted not in found:
            sys.exit(f"LLM_PROVIDER={wanted} but {PROVIDERS[wanted]['env']} is not set in .env.")
        return wanted, found[wanted]

    if not found:
        sys.exit(
            "No API key found. Put GROQ_API_KEY, XAI_API_KEY or ANTHROPIC_API_KEY in .env "
            "(see .env.example)."
        )
    if len(found) > 1:
        sys.exit(
            f"More than one API key is set ({', '.join(found)}). Add a line like "
            f"LLM_PROVIDER={next(iter(found))} to .env to say which one to use."
        )
    provider, key = next(iter(found.items()))
    return provider, key


class LLM:
    """Thin wrapper around the provider client. dry_run skips the API entirely."""

    def __init__(self, dry_run=False, model=None):
        self.dry_run = dry_run
        self.client = None
        self.provider = None
        self.model = None
        self.explicit_model = False
        if dry_run:
            return

        self.provider, key = _pick_provider()
        cfg = PROVIDERS[self.provider]
        chosen = (model or "").strip() or os.environ.get("LLM_MODEL", "").strip()
        self.explicit_model = bool(chosen)
        self.model = chosen or cfg["model"]

        if self.provider == "anthropic":
            try:
                import anthropic
            except ImportError:
                sys.exit("Missing package. Run: pip install -r requirements.txt")
            self.client = anthropic.Anthropic(api_key=key)
        else:
            try:
                from openai import OpenAI  # Groq and xAI use the OpenAI-compatible API
            except ImportError:
                sys.exit("Missing package. Run: pip install -r requirements.txt")
            self.client = OpenAI(api_key=key, base_url=cfg["base_url"])

        print(f"Using {self.provider} model: {self.model}")

    def available_models(self):
        """Chat-capable model IDs this account can use (OpenAI-compatible providers only)."""
        if self.dry_run or self.provider == "anthropic":
            return []
        ids = [m.id for m in self.client.models.list().data]
        return sorted(i for i in ids if not any(w in i.lower() for w in NON_CHAT))

    def _switch_model(self):
        """The chosen model is not available on this account: pick one that is. True if switched."""
        try:
            chat = self.available_models()
        except Exception:
            return False
        order = [m for m in PREFERRED.get(self.provider, []) if m in chat] + [m for m in chat if m != self.model]
        order = [m for m in order if m != self.model]
        if not order:
            return False
        print(f"Model '{self.model}' is not available on your {self.provider} account. Using '{order[0]}' instead "
              f"(set LLM_MODEL in .env to choose another).")
        self.model = order[0]
        return True

    def _complete(self, system, user, max_tokens):
        if self.provider == "anthropic":
            resp = self.client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            return resp.content[0].text
        # Grok reasoning models spend some tokens thinking, so leave headroom for them.
        thinking = self.provider == "xai" or any(h in self.model.lower() for h in REASONING_HINTS)
        limit = max(max_tokens, 2000) if thinking else max_tokens
        resp = self.client.chat.completions.create(
            model=self.model,
            max_tokens=limit,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return resp.choices[0].message.content or ""

    def ask_json(self, system, user, fallback, max_tokens=500):
        """Return a parsed JSON dict, or {"_error": "..."} after 3 failed tries."""
        if self.dry_run:
            return fallback
        last = None
        for attempt in range(3):
            try:
                return parse_json(self._complete(system, user, max_tokens))
            except Exception as e:  # network, rate limit, bad JSON
                kind = type(e).__name__
                if kind in ("AuthenticationError", "PermissionDeniedError"):
                    sys.exit(
                        "The API key was rejected (401/403). Check the key in .env: it must match "
                        "the provider (Groq keys start with gsk_, Grok with xai-, Claude with "
                        "sk-ant-), have no quotes or spaces, and the account must be active."
                    )
                if kind == "NotFoundError" or (kind == "BadRequestError" and "model" in str(e).lower()):
                    if not self.explicit_model and self._switch_model():
                        continue
                    sys.exit(
                        f"Problem with model '{self.model}' on {self.provider}: {e}\n"
                        "Set LLM_MODEL in .env to a model name listed in your provider's console."
                    )
                last = e
                time.sleep(2 * (attempt + 1))
        return {"_error": str(last)}
