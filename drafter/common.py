"""Shared helpers: .env loading, profile, CSV resume, and the LLM call wrapper (Grok or Claude)."""

import csv
import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Default model per provider. Override with LLM_MODEL in .env.
# Model names change over time: if you get "model not found", check the model list
# in your provider's console and put the exact name in LLM_MODEL.
DEFAULT_MODELS = {"anthropic": "claude-sonnet-5-5", "xai": "grok-4"}
XAI_BASE_URL = "https://api.x.ai/v1"


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


def open_writer(path, fields):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    is_new = not p.exists()
    f = open(p, "a", newline="", encoding="utf-8-sig")
    writer = csv.DictWriter(f, fieldnames=fields)
    if is_new:
        writer.writeheader()
    return f, writer


def _pick_provider():
    """Returns (provider, api_key). Grok (xAI) or Claude (Anthropic)."""
    xai_key = os.environ.get("XAI_API_KEY", "").strip()
    anth_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()

    # Forgiving: a Grok key pasted into ANTHROPIC_API_KEY is still recognised by its prefix.
    if not xai_key and anth_key.startswith("xai-"):
        xai_key, anth_key = anth_key, ""

    wanted = os.environ.get("LLM_PROVIDER", "").strip().lower()
    if wanted and wanted not in DEFAULT_MODELS:
        sys.exit(f"LLM_PROVIDER must be 'xai' or 'anthropic', not '{wanted}'.")

    provider = wanted or ("xai" if xai_key else "anthropic" if anth_key else "")
    if not provider:
        sys.exit(
            "No API key found. Put XAI_API_KEY (Grok) or ANTHROPIC_API_KEY (Claude) in .env "
            "(see .env.example)."
        )
    key = xai_key if provider == "xai" else anth_key
    if not key:
        name = "XAI_API_KEY" if provider == "xai" else "ANTHROPIC_API_KEY"
        sys.exit(f"LLM_PROVIDER={provider} but {name} is not set in .env.")
    return provider, key


class LLM:
    """Thin wrapper around the provider client. dry_run skips the API entirely."""

    def __init__(self, dry_run=False):
        self.dry_run = dry_run
        self.client = None
        self.provider = None
        self.model = None
        if dry_run:
            return

        self.provider, key = _pick_provider()
        self.model = os.environ.get("LLM_MODEL", "").strip() or DEFAULT_MODELS[self.provider]

        if self.provider == "xai":
            try:
                from openai import OpenAI  # xAI's API is OpenAI-compatible
            except ImportError:
                sys.exit("Missing package. Run: pip install -r requirements.txt")
            self.client = OpenAI(api_key=key, base_url=XAI_BASE_URL)
        else:
            try:
                import anthropic
            except ImportError:
                sys.exit("Missing package. Run: pip install -r requirements.txt")
            self.client = anthropic.Anthropic(api_key=key)

        print(f"Using {self.provider} model: {self.model}")

    def _complete(self, system, user, max_tokens):
        if self.provider == "xai":
            resp = self.client.chat.completions.create(
                model=self.model,
                # Grok reasoning models spend some tokens thinking, so leave headroom.
                max_tokens=max(max_tokens, 1500),
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
            return resp.choices[0].message.content or ""
        resp = self.client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return resp.content[0].text

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
                        "the provider (Grok keys start with xai-, Claude keys with sk-ant-), have no "
                        "quotes or spaces, and the account needs API credit."
                    )
                if kind == "NotFoundError":
                    sys.exit(
                        f"Model '{self.model}' was not found for {self.provider}. Set LLM_MODEL in "
                        "'.env' to a model name that is listed in your provider's console."
                    )
                last = e
                time.sleep(2 * (attempt + 1))
        return {"_error": str(last)}
