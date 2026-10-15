"""Draft natural, human-sounding comments for already-fetched posts. Draft only, never posts."""

import csv
import hashlib
import json
import random
import sys
import time
from pathlib import Path

from .common import done_ids, open_writer

# Field names looked up in your fetched posts. Add your own key names if they differ.
TEXT_KEYS = ("text", "post_text", "content", "message", "body", "post")
URL_KEYS = ("url", "post_url", "link", "permalink")
AUTHOR_KEYS = ("author", "author_name", "name", "user", "profile_name")

STYLE_HINTS = [
    "friendly and brief",
    "ask one genuinely useful clarifying question",
    "share one quick practical tip",
    "empathetic and encouraging, then a light offer to help",
    "casual and direct, like a helpful freelancer replying",
]

OUTPUT_FIELDS = [
    "post_id", "post_url", "author", "post_text", "relevant",
    "comment", "reason", "status",
]


def pick(d, keys):
    for k in keys:
        v = d.get(k)
        if v:
            return str(v).strip()
    return ""


def load_posts(path):
    p = Path(path)
    if not p.exists():
        sys.exit(f"Input file not found: {path}")
    if p.suffix.lower() == ".csv":
        with p.open(newline="", encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
    else:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            for key in ("posts", "results", "data", "items"):
                if isinstance(data.get(key), list):
                    data = data[key]
                    break
            else:
                data = [data]
        rows = data

    posts, seen = [], set()
    for r in rows:
        if not isinstance(r, dict):
            continue
        text = pick(r, TEXT_KEYS)
        if not text:
            continue
        url = pick(r, URL_KEYS)
        pid = hashlib.md5((url or text).encode("utf-8")).hexdigest()[:12]
        if pid in seen:
            continue
        seen.add(pid)
        posts.append({
            "post_id": pid,
            "post_url": url,
            "author": pick(r, AUTHOR_KEYS),
            "post_text": text,
        })
    return posts


def build_system_prompt(profile):
    name, service, about = profile["name"], profile["service"], profile["about"]
    return f"""You help {name} write replies to Facebook posts. {name} offers: {service}. {about}

Write ONE comment per post that sounds like a real, helpful person, not a marketer.

Rules:
- 1 to 3 short sentences, ideally under 40 words.
- Mention a specific detail from the post so it is clearly a reply to THIS post.
- Match the language and tone of the post (English, Urdu written in Roman script, or a mix).
- Be helpful first: a tip, a useful question, or encouragement. Only invite a DM if the post clearly asks for someone to provide the service.
- No links, phone numbers, hashtags, or sales slogans. At most one emoji, and only if it fits naturally.
- Be honest. Do not claim experiences you cannot know, do not pretend to be a customer, and do not invent results or prices.
- Do not start with "Great post!" or similar generic openers.
- If the post is not a genuine need or not related to {service}, mark it not relevant and write no comment.

Reply with ONLY a JSON object, nothing else:
{{"relevant": true or false, "comment": "the comment text or empty string", "reason": "one short line on why"}}"""


def run(args, profile, llm):
    posts = load_posts(args.input)
    done = done_ids(args.output, "post_id")
    todo = [p for p in posts if p["post_id"] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(posts)} posts loaded, {len(done)} already done, {len(todo)} to process.")

    system = build_system_prompt(profile)
    f, writer = open_writer(args.output, OUTPUT_FIELDS)
    with f:
        for i, post in enumerate(todo, 1):
            style = random.choice(STYLE_HINTS)
            user_msg = (
                f"Style for this comment: {style}\n\n"
                f"Post author: {post['author'] or 'unknown'}\n"
                f"Post text:\n{post['post_text'][:2000]}"
            )
            fallback = {
                "relevant": True,
                "comment": "[dry-run] a drafted comment would appear here",
                "reason": "dry run, no API call made",
            }
            res = llm.ask_json(system, user_msg, fallback, max_tokens=400)

            if "_error" in res:
                relevant, comment, reason, status = False, "", f"error: {res['_error']}", "error"
            else:
                relevant = bool(res.get("relevant"))
                comment = (res.get("comment") or "").strip() if relevant else ""
                reason = res.get("reason", "")
                status = "draft" if comment else "skipped"

            writer.writerow({
                "post_id": post["post_id"],
                "post_url": post["post_url"],
                "author": post["author"],
                "post_text": post["post_text"][:500].replace("\n", " "),
                "relevant": relevant,
                "comment": comment,
                "reason": reason,
                "status": status,
            })
            f.flush()
            print(f"[{i}/{len(todo)}] {status}: {post['post_id']}")
            if not llm.dry_run:
                time.sleep(args.gap)

    print(f"Done. Review {args.output}, edit anything you like, then post manually.")
