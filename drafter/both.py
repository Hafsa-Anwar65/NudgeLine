"""One run, two drafts per row: a comment for the lead's post AND a personalized email.

Input: a CSV, Excel (.xlsx) or JSON file where each row has the post content, the business
name, the owner's name and an email. Column names are matched loosely (see FIELD_MAP in
emails.py). Draft only: nothing is posted or sent.
"""

import csv
import hashlib
import json
import random
import sys
import time
from pathlib import Path

from . import comments, emails
from .common import done_ids, open_writer

OUTPUT_FIELDS = [
    "id", "name", "company", "email", "post_url", "post_text",
    "comment", "comment_note", "subject", "body", "personalization", "angle", "status",
]

EMAIL_EXTRA_RULE = (
    "\n\nExtra rule for this run: if the lead details include their public post, mention what "
    "they asked for or talked about in it, in a natural way, as the reason you are writing. "
    "Do not quote it word for word."
)


def _read_rows(path):
    """Return a list of dicts (raw column names) from csv, xlsx or json."""
    p = Path(path)
    if not p.exists():
        sys.exit(f"Input file not found: {path}")
    suffix = p.suffix.lower()

    if suffix == ".csv":
        with p.open(newline="", encoding="utf-8-sig") as f:
            return list(csv.DictReader(f))

    if suffix in (".xlsx", ".xlsm"):
        try:
            from openpyxl import load_workbook
        except ImportError:
            sys.exit("To read Excel files run: pip install openpyxl  (or save the sheet as CSV)")
        ws = load_workbook(p, read_only=True, data_only=True).active
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            return []
        header = [str(h) if h is not None else "" for h in rows[0]]
        return [
            {header[i]: ("" if v is None else str(v)) for i, v in enumerate(r) if i < len(header)}
            for r in rows[1:]
        ]

    if suffix == ".json":
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            for key in ("posts", "results", "data", "items", "leads"):
                if isinstance(data.get(key), list):
                    data = data[key]
                    break
            else:
                data = [data]
        return [r for r in data if isinstance(r, dict)]

    sys.exit("Use a .csv, .xlsx or .json file for this command.")


def load_records(path):
    records, seen = [], set()
    for raw in _read_rows(path):
        row = {emails.norm_key(k): ("" if v is None else str(v).strip()) for k, v in raw.items()}
        rec = {}
        for field, aliases in emails.FIELD_MAP.items():
            rec[field] = next((row[a] for a in aliases if row.get(a)), "")
        rec["email"] = rec["email"].lower()
        if not rec["notes"] and not rec["email"]:
            continue  # nothing to work with
        key = rec["email"] + "|" + rec["notes"][:200] + "|" + rec["company"]
        rec["id"] = hashlib.md5(key.encode("utf-8")).hexdigest()[:12]
        if rec["id"] in seen:
            continue
        seen.add(rec["id"])
        records.append(rec)
    return records


def run(args, profile, llm):
    records = load_records(args.input)
    done = done_ids(args.output, "id")
    todo = [r for r in records if r["id"] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(records)} rows loaded, {len(done)} already done, {len(todo)} to process.")

    comment_system = comments.build_system_prompt(profile)
    email_system = emails.build_system_prompt(profile) + EMAIL_EXTRA_RULE

    f, writer = open_writer(args.output, OUTPUT_FIELDS)
    with f:
        for i, rec in enumerate(todo, 1):
            row = {
                "id": rec["id"], "name": rec["name"], "company": rec["company"],
                "email": rec["email"], "post_url": rec["post_url"],
                "post_text": rec["notes"][:500].replace("\n", " "),
                "comment": "", "comment_note": "", "subject": "", "body": "",
                "personalization": "", "angle": "", "status": "",
            }
            failed = False

            # 1) Comment on the post
            if rec["notes"]:
                style = random.choice(comments.STYLE_HINTS)
                user_msg = (
                    f"Style for this comment: {style}\n\n"
                    f"Post author: {rec['name'] or 'unknown'}\n"
                    f"Post text:\n{rec['notes'][:2000]}"
                )
                fallback = {
                    "relevant": True,
                    "comment": "[dry-run] a drafted comment would appear here",
                    "reason": "dry run, no API call made",
                }
                res = llm.ask_json(comment_system, user_msg, fallback, max_tokens=400)
                if "_error" in res:
                    failed = True
                    row["comment_note"] = f"error: {res['_error']}"
                elif res.get("relevant"):
                    row["comment"] = (res.get("comment") or "").strip()
                    row["comment_note"] = res.get("reason", "")
                else:
                    row["comment_note"] = "skipped: " + (res.get("reason") or "not relevant")
            else:
                row["comment_note"] = "no post text"

            # 2) Email to the owner
            if rec["email"] and emails.EMAIL_RE.match(rec["email"]):
                site = ""
                if args.fetch_sites and rec["website"] and not llm.dry_run:
                    site = emails.fetch_site_summary(rec["website"])
                fallback = {
                    "subject": "[dry-run] subject line",
                    "body": "[dry-run] a personalized email body would appear here.",
                    "personalization": "low",
                    "angle": "dry run, no API call made",
                }
                message = emails.build_user_message(rec, site, notes_label="Their public post")
                res = llm.ask_json(email_system, message, fallback, max_tokens=600)
                if "_error" in res or not res.get("body"):
                    failed = True
                    row["angle"] = f"error: {res.get('_error', 'empty response')}"
                else:
                    row["subject"] = (res.get("subject") or "").strip()
                    row["body"] = f"{res['body'].strip()}\n\n{profile['signoff']}\n\n{profile['opt_out_line']}"
                    row["personalization"] = res.get("personalization", "")
                    row["angle"] = res.get("angle", "")
            else:
                row["angle"] = "no valid email, email draft skipped"

            row["status"] = "error" if failed else ("draft" if (row["comment"] or row["body"]) else "skipped")
            writer.writerow(row)
            f.flush()
            label = rec["company"] or rec["name"] or rec["email"] or rec["id"]
            print(f"[{i}/{len(todo)}] {row['status']}: {label}")
            if not llm.dry_run:
                time.sleep(args.gap)

    print(f"Done. Open {args.output}: edit the drafts, then post and send them yourself.")
