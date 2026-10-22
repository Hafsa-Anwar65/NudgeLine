"""Draft natural, human-sounding comments for already-fetched posts. Draft only, never posts."""

import csv
import hashlib
import json
import random
import re
import sys
import time
from pathlib import Path

from . import quality
from .common import done_ids, open_writer, prepare_output, tone_line

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
    "post_id", "priority", "intent_score", "language", "post_url", "author", "post_text",
    "relevant", "comment", "comment_long", "reason", "qa_flags", "status",
]

LENGTHS = ("short", "long", "both")  # short = 1-3 sentences, long = a fuller reply, both = one of each


def humanize(text):
    """Clean the little things that make a comment look machine-written."""
    t = (text or "").strip()
    t = re.sub(r"\s*[\u2013\u2014]\s*", ", ", t)          # no long dashes
    t = t.replace("\u2026", "...").replace("\u2018", "'").replace("\u2019", "'")
    t = t.replace("\u201c", '"').replace("\u201d", '"')
    t = re.sub(r"[*_`#]+", "", t)                            # no markdown
    t = re.sub(r"^[\-\u2022]\s+", "", t, flags=re.M)         # no bullet points
    t = re.sub(r"\s*;\s*(\w)", lambda m: ". " + m.group(1).upper(), t)                          # no semicolons
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\s+([,.!?])", r"\1", t)
    t = re.sub(r",\s*,", ",", t)
    t = t.strip(' "')
    if len(t) > 1 and t[0].islower() and t[0].isascii():
        t = t[0].upper() + t[1:]
    return t


FORCE_NOTE = ("\n\nIMPORTANT: Write the comment anyway. Any topic is fine, even if it has nothing to do with "
              "what the writer offers. Be a helpful, friendly reply and do not pitch. Set relevant to true.")


def ask_comment(llm, system, user_msg, fallback, length="short"):
    """Ask for a comment. If the model refuses a post as 'not relevant', ask once more, firmly."""
    budget = token_budget(length)
    res = llm.ask_json(system, user_msg, fallback, max_tokens=budget)
    info = interpret(res, length)
    if "error" not in info and not info["comment"] and not getattr(llm, "dry_run", False):
        info = interpret(llm.ask_json(system, user_msg + FORCE_NOTE, fallback, max_tokens=budget), length)
    return info


def interpret(res, length="short"):
    """Turn the model's JSON into clean fields. Returns a dict, or {"error": msg}.

    "comment" is the main draft (short, or long when length is "long").
    "comment_long" is only filled when length is "both" (the fuller alternative).
    """
    if "_error" in res:
        return {"error": res["_error"]}
    # Any post gets a comment: if the model wrote one, it counts, whatever it put in "relevant".
    comment = humanize(res.get("comment"))
    comment_long = humanize(res.get("comment_long")) if length == "both" else ""
    relevant = bool(comment) or bool(res.get("relevant"))
    intent = quality.clamp_intent(res.get("intent_score"))
    flags = quality.comment_flags(comment, long=(length == "long"))
    flags += ["longer version: " + f for f in quality.comment_flags(comment_long, long=True)]
    if length == "both" and comment and not comment_long:
        flags.append("longer version missing")
    return {
        "relevant": relevant, "comment": comment, "comment_long": comment_long, "reason": res.get("reason", ""),
        "intent": intent, "language": str(res.get("language") or ""),
        "priority": quality.priority(intent, bool(comment)), "flags": flags,
    }


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


LENGTH_RULES = {
    "short": "- 1 to 3 short sentences, ideally under 40 words.",
    "long": ("- A fuller reply: 4 to 7 sentences, roughly 70 to 130 words, in one or two short paragraphs. "
             "Say more about how you would approach their specific situation, but stay as casual and human as a short reply: no structure, no lists, no sign-off."),
    "both": ("- Write TWO versions of the same reply. \"comment\" is the SHORT one: 1 to 3 short sentences, "
             "ideally under 40 words. \"comment_long\" is the LONGER one: 4 to 7 sentences, roughly 70 to 130 words, "
             "in one or two short paragraphs, with more detail on how you would approach their specific situation. "
             "Both must take the same angle and the same tone."),
}


def examples_block(profile):
    """Comments the user has approved before. Shown to the AI so new ones sound like the same person."""
    items = [e for e in (profile.get("examples") or []) if e.get("comment")][:6]
    if not items:
        return ""
    lines = []
    for e in items:
        post = (e.get("post") or "").strip().replace("\n", " ")[:160]
        lines.append((f'Post: "{post}"\n' if post else "") + f'Comment: "{e["comment"].strip()[:500]}"')
    return (f"Here are real comments {profile['name']} approved and posts. Learn the voice from them: sentence length, "
            "word choice, how they open and end, punctuation, any emoji habit, and how they mix English with Roman Urdu. "
            "Write like this same person. Never copy an example and never reuse its specific details.\n\n"
            + "\n\n".join(lines) + "\n\n")


def build_system_prompt(profile, length="short"):
    length = length if length in LENGTHS else "short"
    name, service, about = profile["name"], profile["service"], profile["about"]
    one = "TWO versions of the comment" if length == "both" else "ONE comment"
    json_comment = '"comment": "the short comment text or empty string", "comment_long": "the longer comment or empty string"' if length == "both" else '"comment": "the comment text or empty string"'
    offer = f" {name} offers: {service}. {about}".rstrip() if (service or about) else ""
    ex_block = examples_block(profile)
    return f"""You help {name} write replies to Facebook posts.{offer}

Write {one} per post that sounds like a real, helpful person, not a marketer.

Rules:
{LENGTH_RULES[length]}
- Mention a specific detail from the post so it is clearly a reply to THIS post.
- Match the language of the post (English, Urdu written in Roman script, or a mix). Your own tone: {tone_line(profile)}.
- It must read like a real person typed it quickly on their phone, never like an AI or a template. Use plain everyday words and contractions (I'd, it's, you'll). Sentences can be uneven, and a short fragment is fine. Sound relaxed, not polished.
- Never use long dashes (— or –), semicolons, bullet points, headings, bold text, or quotation marks around phrases. Use commas and full stops only.
- Avoid AI-sounding words and phrases: delve, envision, leverage, seamless, robust, elevate, streamline, unlock, crucial, navigate, tailor, game-changer, "feel free to", "reach out", "I'd be happy to", "hope this helps", "Absolutely", "Certainly", "Great question".
- Do not repeat the post back, do not wrap up with a neat summary line, and do not list three things in a row. Say one or two real things and stop.
- Be helpful first: a tip, a useful question, or encouragement. Only invite a DM if the post clearly asks for someone to provide the service.
- No links, phone numbers, hashtags, or sales slogans. At most one emoji, and only if it fits naturally.
- Be honest. Do not claim experiences you cannot know, do not pretend to be a customer, and do not invent results or prices.
- Do not start with "Great post!" or similar generic openers.
- Write a comment for ANY post, whatever the topic. Do not limit yourself to {service or "one subject"}. If the post has nothing to do with what {name} offers, just be a genuinely helpful, friendly reply (advice, a useful question, encouragement or congratulations) and do not pitch anything.
- Only mention what {name} offers when the post is clearly asking for it. Never force a sales pitch.
- Mark a post not relevant only if it is empty, nonsense, spam, or abusive. Otherwise always write a comment.

{ex_block}Reply with ONLY a JSON object, nothing else:
{{"relevant": true (always true unless the post is empty, spam or abusive), "intent_score": 1 to 5 (5 = the author is clearly asking for what {name} offers right now, 1 = the post is unrelated to what {name} offers), "language": "English|Urdu|Roman Urdu|Mixed|Other", {json_comment}, "reason": "one short line on why"}}"""


def token_budget(length):
    return {"short": 450, "long": 650, "both": 900}.get(length, 450)


def run(args, profile, llm):
    posts = load_posts(args.input)
    prepare_output(args.output, OUTPUT_FIELDS)
    done = done_ids(args.output, "post_id")
    todo = [p for p in posts if p["post_id"] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(posts)} posts loaded, {len(done)} already done, {len(todo)} to process.")

    length = profile.get("comment_length", "short")
    system = build_system_prompt(profile, length)
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
            info = ask_comment(llm, system, user_msg, fallback, length)
            if "error" in info:
                info = {"relevant": False, "comment": "", "comment_long": "", "reason": f"error: {info['error']}", "intent": 0,
                        "language": "", "priority": "", "flags": []}
                status = "error"
            elif not info["comment"]:
                status = "skipped"
            else:
                status = "needs_edit" if info["flags"] else "draft"
            relevant, comment, reason = info["relevant"], info["comment"], info["reason"]

            writer.writerow({
                "post_id": post["post_id"],
                "priority": info["priority"],
                "intent_score": info["intent"] or "",
                "language": info["language"],
                "qa_flags": "; ".join(info["flags"]),
                "post_url": post["post_url"],
                "author": post["author"],
                "post_text": post["post_text"][:500].replace("\n", " "),
                "relevant": relevant,
                "comment": comment,
                "comment_long": info.get("comment_long", ""),
                "reason": reason,
                "status": status,
            })
            f.flush()
            print(f"[{i}/{len(todo)}] {status}: {post['post_id']}")
            if not llm.dry_run:
                time.sleep(args.gap)

    from . import review
    review.sort_by_priority(args.output)
    page = review.write_html(args.output)
    print(f"Done. Open {page} to review, edit {args.output} if needed, then run:")
    print(f'  python main.py approve --input "{args.output}"')
