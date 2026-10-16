"""Human review: an HTML overview of the drafts and the `approve` command.

Nothing here posts or sends anything. `approve` only copies the rows you OK into a
separate *_approved.csv file.
"""

import csv
import html
import sys
from datetime import datetime
from pathlib import Path

COLORS = {"draft": "#1a9d5c", "needs_edit": "#d9a300", "error": "#d33", "skipped": "#888", "approved": "#2563eb"}
PRIORITY_RANK = {"high": 0, "medium": 1, "low": 2, "": 3}


def read_rows(path):
    p = Path(path)
    if not p.exists():
        sys.exit(f"File not found: {path}")
    with p.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return list(reader.fieldnames or []), list(reader)


def write_rows(path, fields, rows):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def sort_by_priority(path):
    """Rewrite the CSV with the strongest leads first."""
    fields, rows = read_rows(path)
    if "priority" not in fields:
        return
    def key(r):
        try:
            score = int(r.get("intent_score") or 0)
        except ValueError:
            score = 0
        return (PRIORITY_RANK.get(r.get("priority", ""), 3), -score)
    rows.sort(key=key)
    write_rows(path, fields, rows)


def write_html(csv_path):
    """Write a readable review page next to the CSV and return its path."""
    _, rows = read_rows(csv_path)
    e = lambda s: html.escape(str(s or ""))
    count = lambda s: sum(1 for r in rows if r.get("status") == s)
    chip = lambda t, c: f'<span class="chip" style="background:{c}">{e(t)}</span>'
    cards = []
    for n, r in enumerate(rows, 1):
        st = r.get("status", "")
        title = r.get("company") or r.get("name") or r.get("author") or r.get("email") or r.get("post_id", "")
        comment = r.get("comment") or ""
        subject = r.get("subject") or ""
        body = r.get("body") or ""
        cards.append(f"""<section class="card" style="border-left-color:{COLORS.get(st, '#888')}">
<h3>#{n} {e(title)} {chip(st, COLORS.get(st, '#888'))}{chip('priority: ' + r['priority'], '#555') if r.get('priority') else ''}{chip(r['language'], '#777') if r.get('language') else ''}</h3>
{f'<p class="warn">&#9888; {e(r["qa_flags"])}</p>' if r.get('qa_flags') else ''}
<p><b>Post:</b> {e(r.get('post_text') or r.get('post'))}</p>
<p><b>Comment:</b> {e(comment) or '<i>' + e(r.get('comment_note') or r.get('reason')) + '</i>'}</p>
{f'<p><b>Subject:</b> {e(subject)}</p><pre>{e(body)}</pre>' if subject or body else ''}
</section>""")
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nudgeline review</title><style>
:root{{--bg:#fff;--fg:#1b1b1f;--card:#f6f6f8;--line:#d8d8de}}
@media (prefers-color-scheme:dark){{:root{{--bg:#121214;--fg:#ececf0;--card:#1b1b1f;--line:#34343c}}}}
body{{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);max-width:820px;margin:0 auto;padding:24px 16px}}
.card{{background:var(--card);border:1px solid var(--line);border-left:5px solid;border-radius:10px;padding:10px 16px;margin:14px 0}}
.chip{{color:#fff;border-radius:99px;padding:2px 10px;font-size:12px;margin-right:6px;font-weight:600}}
h1{{margin:0 0 6px}} h3{{margin:.4em 0}} .warn{{color:#b57d00}} pre{{white-space:pre-wrap;font:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px}}
</style></head><body><h1>Nudgeline review</h1>
<p>{chip(str(count('draft')) + ' ready', COLORS['draft'])}{chip(str(count('needs_edit')) + ' need edit', COLORS['needs_edit'])}{chip(str(count('error')) + ' errors', COLORS['error'])}{chip(str(count('skipped')) + ' skipped', COLORS['skipped'])}</p>
<p>Edit the CSV if you want changes. Only rows with status <code>draft</code> are exported by <code>python main.py approve</code>. Nothing has been posted or sent.</p>
{''.join(cards)}</body></html>"""
    out = Path(csv_path).with_suffix(".html")
    out.write_text(page, encoding="utf-8")
    return out


def approve(args):
    fields, rows = read_rows(args.input)
    if "status" not in fields:
        sys.exit("This file has no 'status' column. Use a CSV made by Nudgeline.")

    count = lambda s: sum(1 for r in rows if r.get("status") == s)
    print(f"{len(rows)} rows: {count('draft')} draft, {count('needs_edit')} needs_edit, "
          f"{count('error')} error, {count('skipped')} skipped.")

    if args.interactive:
        reviewable = [r for r in rows if r.get("status") in ("draft", "needs_edit")]
        for i, r in enumerate(reviewable, 1):
            print("\n" + "-" * 60)
            print(f"[{i}/{len(reviewable)}] {r.get('company') or r.get('name') or r.get('author') or r.get('email')}"
                  f"   status={r['status']}  priority={r.get('priority', '')}")
            if r.get("qa_flags"):
                print(f"  WARNINGS: {r['qa_flags']}")
            if r.get("post_text") or r.get("post"):
                print(f"  POST: {(r.get('post_text') or r.get('post'))[:300]}")
            if r.get("comment"):
                print(f"  COMMENT: {r['comment']}")
            if r.get("subject") or r.get("body"):
                print(f"  SUBJECT: {r.get('subject', '')}\n  EMAIL:\n{r.get('body', '')}")
            while True:
                ans = input("Approve? [y]es / [n]o / [q]uit: ").strip().lower()[:1]
                if ans in ("y", "n", "q"):
                    break
            if ans == "q":
                break
            r["status"] = "draft" if ans == "y" else "rejected"
        write_rows(args.input, fields, rows)  # keep your decisions in the CSV

    ready = [r for r in rows if r.get("status") == "draft"]
    if not ready:
        sys.exit("No rows with status 'draft' to export. Edit status in the CSV or use --interactive.")
    ans = input(f"Export {len(ready)} approved draft(s)? Type 'yes' to confirm: ").strip().lower()
    if ans != "yes":
        sys.exit("Nothing exported.")

    out = Path(args.output) if args.output else Path(args.input).with_name(Path(args.input).stem + "_approved.csv")
    stamp = datetime.now().isoformat(timespec="seconds")
    export = [{**r, "status": "approved", "reviewed_at": stamp} for r in ready]
    write_rows(out, fields + ["reviewed_at"], export)
    print(f"Saved {len(export)} row(s) to {out}. Post and send them yourself.")
