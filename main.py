#!/usr/bin/env python3
"""Nudgeline: draft human-sounding comments and personalized emails. Draft only."""

import argparse

from drafter import both, comments, emails
from drafter.common import ROOT, LLM, load_env, load_profile


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--input", required=True, help="input file")
    common.add_argument("--output", help="output CSV (default: output/<command>.csv)")
    common.add_argument("--profile", default=str(ROOT / "profile.json"), help="your profile.json")
    common.add_argument("--limit", type=int, default=0, help="max items to process (0 = all)")
    common.add_argument("--gap", type=float, default=1.0, help="seconds between API calls")
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
    e.add_argument(
        "--fetch-sites", action="store_true",
        help="fetch each lead's homepage (plain HTTP, one request) for extra personalization",
    )
    b = sub.add_parser(
        "both", parents=[common],
        help="one run, two drafts per row: a comment on the post AND an email (CSV, XLSX or JSON)",
    )
    b.add_argument(
        "--fetch-sites", action="store_true",
        help="also read each business website (needs a website column)",
    )
    return ap


def main():
    args = build_parser().parse_args()
    load_env()
    if not args.output:
        name = "outreach" if args.cmd == "both" else args.cmd
        if args.dry_run:
            name += "_dryrun"
        args.output = str(ROOT / "output" / f"{name}.csv")
    profile = load_profile(args.profile)
    llm = LLM(dry_run=args.dry_run)

    if args.cmd == "comments":
        comments.run(args, profile, llm)
    elif args.cmd == "both":
        both.run(args, profile, llm)
    else:
        emails.run(args, profile, llm)


if __name__ == "__main__":
    main()
