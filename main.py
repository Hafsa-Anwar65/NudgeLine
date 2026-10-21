#!/usr/bin/env python3
"""Nudgeline: draft human-sounding comments and personalized emails. Draft only."""

import argparse

from drafter import both, comments, emails, review
from drafter.common import ROOT, TONES, load_env, load_profile
from drafter.router import Router


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--input", required=True, help="input file")
    common.add_argument("--output", help="output CSV (default: output/<command>.csv)")
    common.add_argument("--profile", default=str(ROOT / "profile.json"), help="your profile.json")
    common.add_argument("--limit", type=int, default=0, help="max items to process (0 = all)")
    common.add_argument("--gap", type=float, default=1.0, help="seconds between API calls")
    common.add_argument("--tone", choices=sorted(TONES), help="writing tone (default: from profile.json, else friendly)")
    common.add_argument("--dry-run", action="store_true", help="test the pipeline without calling the API")

    ap = argparse.ArgumentParser(description="Nudgeline: draft comments and personalized emails.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser(
        "comments", parents=[common],
        help="draft comments for fetched posts (JSON or CSV)",
    )
    e = sub.add_parser(
        "emails", parents=[common],
        help="draft personalized emails from a list of emails (TXT or CSV)",
    )
    e.add_argument("--template", help="text file with your own email template ({first_name} {name} {company} {post_hook})")
    e.add_argument(
        "--fetch-sites", action="store_true",
        help="fetch each lead's homepage (plain HTTP, one request) for extra personalization",
    )
    b = sub.add_parser(
        "both", parents=[common],
        help="one run, two drafts per row: a comment on the post AND an email (CSV, XLSX or JSON)",
    )
    b.add_argument("--template", help="text file with your own email template ({first_name} {name} {company} {post_hook})")
    b.add_argument(
        "--fetch-sites", action="store_true",
        help="also read each business website (needs a website column)",
    )
    a = sub.add_parser(
        "approve", help="human review step: export only the drafts you approve to *_approved.csv",
    )
    a.add_argument("--input", required=True, help="the CSV made by comments / emails / both")
    a.add_argument("--output", help="approved CSV (default: <input>_approved.csv)")
    a.add_argument("--interactive", action="store_true", help="go through the drafts one by one (y/n)")
    return ap


def main():
    args = build_parser().parse_args()
    if args.cmd == "approve":
        review.approve(args)
        return
    load_env()
    if not args.output:
        name = "outreach" if args.cmd == "both" else args.cmd
        if args.dry_run:
            name += "_dryrun"
        args.output = str(ROOT / "output" / f"{name}.csv")
    profile = load_profile(args.profile)
    if args.tone:
        profile["tone"] = args.tone
    llm = Router(dry_run=args.dry_run)

    if args.cmd == "comments":
        comments.run(args, profile, llm)
    elif args.cmd == "both":
        both.run(args, profile, llm)
    else:
        emails.run(args, profile, llm)


if __name__ == "__main__":
    main()
