"""Shared helpers: .env loading, profile, CSV resume, and the Claude call wrapper."""

import csv
import json
import os
import re
import sys
import time
from pathlib import Path

MODEL = "claude-sonnet-5-5"
ROOT = Path(__file__).resolve().parent.parent


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
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError("no JSON object in model response")
    return json.loads(m.group(0))


def done_ids(path, key):
    """IDs already written to the output CSV, so a re-run resumes instead of repeating."""
    p = Path(path)
    if not p.exists():
        return set()
    with p.open(newline="", encoding="utf-8-sig") as f:
        return {row.get(key, "") for row in csv.DictReader(f)}


def open_writer(path, fields):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    is_new = not p.exists()
    f = open(p, "a", newline="", encoding="utf-8-sig")
    writer = csv.DictWriter(f, fieldnames=fields)
    if is_new:
        writer.writeheader()
    return f, writer


class LLM:
    """Thin wrapper around the Anthropic client. dry_run skips the API entirely."""

    def __init__(self, dry_run=False):
        self.dry_run = dry_run
        self.client = None
        if dry_run:
            return
        if not os.environ.get("ANTHROPIC_API_KEY"):
            sys.exit("ANTHROPIC_API_KEY is not set. Put it in .env (see .env.example).")
        try:
            import anthropic
        except ImportError:
            sys.exit("Missing package. Run: pip install -r requirements.txt")
        self.client = anthropic.Anthropic()

    def ask_json(self, system, user, fallback, max_tokens=500):
        """Return a parsed JSON dict, or {"_error": "..."} after 3 failed tries."""
        if self.dry_run:
            return fallback
        last = None
        for attempt in range(3):
            try:
                resp = self.client.messages.create(
                    model=MODEL,
                    max_tokens=max_tokens,
                    system=system,
                    messages=[{"role": "user", "content": user}],
                )
                return parse_json(resp.content[0].text)
            except Exception as e:  # network, rate limit, bad JSON
                last = e
                time.sleep(2 * (attempt + 1))
        return {"_error": str(last)}
