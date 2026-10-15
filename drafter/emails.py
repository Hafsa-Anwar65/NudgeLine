"""Draft personalized outreach emails from a list of emails (txt or csv). Draft only, never sends."""

import csv
import html
import re
import sys
import time
from pathlib import Path

from .common import done_ids, open_writer

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Accepted column names for each field. Headers are matched in lower case with spaces
# and symbols turned into "_", so "Business Name" matches "business_name".
FIELD_MAP = {
    "email": ("email", "e_mail", "email_address", "emails", "owner_email", "business_email"),
    "name": ("name", "owner", "owner_name", "business_owner", "contact", "contact_name",
             "full_name", "first_name", "author", "author_name"),
    "company": ("company", "company_name", "business", "business_name", "page_name",
                "organization", "organisation"),
    "website": ("website", "business_website", "website_url", "site", "web"),
    "notes": ("notes", "context", "details", "post_text", "post", "post_content", "content",
              "text", "message", "body", "description", "about"),
    "post_url": ("post_url", "url", "link", "permalink"),
}


def norm_key(key):
    """'Business Name' -> 'business_name'."""
    return re.sub(r"[^a-z0-9]+", "_", str(key or "").strip().lower()).strip("_")

OUTPUT_FIELDS = [
    "email", "name", "company", "website", "subject", "body",
    "personalization", "angle", "status",
]


def load_leads(path):
    p = Path(path)
    if not p.exists():
        sys.exit(f"Input file not found: {path}")

    leads, seen = [], set()

    def add(lead):
        email = lead.get("email", "").strip().lower()
        if not email or email in seen:
            return
        seen.add(email)
        lead["email"] = email
        leads.append(lead)

    if p.suffix.lower() == ".csv":
        with p.open(newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                row = {norm_key(k): (v or "").strip() for k, v in row.items()}
                lead = {}
                for field, aliases in FIELD_MAP.items():
                    lead[field] = next((row[a] for a in aliases if row.get(a)), "")
                add(lead)
    else:  # plain text: one email per line (commas/semicolons also work)
        for line in p.read_text(encoding="utf-8").splitlines():
            for token in re.split(r"[,;\s]+", line):
                if "@" in token:
                    add({"email": token, "name": "", "company": "", "website": "", "notes": ""})
    return leads


def fetch_site_summary(url, timeout=8):
    """One plain HTTP request to the homepage. Returns a short factual summary, or ''."""
    try:
        import httpx
    except ImportError:
        return ""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    try:
        r = httpx.get(
            url, timeout=timeout, follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible; OutreachDrafter/1.0)"},
        )
        if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
            return ""
        page = r.text[:200000]
        final_url = str(r.url)
    except Exception:
        return ""

    def clean(s):
        return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()

    parts = []
    title = re.search(r"<title[^>]*>(.*?)</title>", page, re.I | re.S)
    if title and clean(title.group(1)):
        parts.append("title: " + clean(title.group(1))[:120])
    desc = re.search(
        r'<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']', page, re.I | re.S
    )
    if desc and clean(desc.group(1)):
        parts.append("description: " + clean(desc.group(1))[:200])
    h1s = [clean(h) for h in re.findall(r"<h1[^>]*>(.*?)</h1>", page, re.I | re.S)[:2] if clean(h)]
    if h1s:
        parts.append("headline: " + " / ".join(h1s)[:150])

    # Cheap, factual signals the email may mention if relevant.
    if final_url.startswith("http://"):
        parts.append("signal: site is not served over HTTPS")
    if not re.search(r'<meta[^>]+name=["\']viewport["\']', page, re.I):
        parts.append("signal: no mobile viewport tag (may not be mobile-friendly)")
    return " | ".join(parts)[:800]


def build_system_prompt(profile):
    name, service, about = profile["name"], profile["service"], profile["about"]
    return f"""You write short, personalized outreach emails for {name}, who offers: {service}. {about}

Write ONE email per lead.

Rules:
- Subject: 3 to 7 words, specific and plain. No clickbait, no ALL CAPS, no "Re:" or "Fwd:" tricks.
- Body: 60 to 110 words, 2 short paragraphs at most.
- Start with "Hi <first name>," if a name is given, otherwise "Hi there,". Do not write a signature or an unsubscribe line; those are added separately.
- Use ONLY facts given in the lead details. Never invent facts, results, mutual connections, prices, or things you "noticed". If details are thin, write a shorter, honest, generic email and set personalization to "low".
- Open with something specific to them (their business, site, or situation), not with "I hope this finds you well" or an introduction of yourself.
- Say plainly what {name} can help with, in one sentence, and make exactly one small, low-pressure ask (a quick reply or a short call).
- Warm and human, no hype, no buzzwords, no exclamation marks, no emojis, no fake urgency.
- Write in the language of the lead's notes if they are not English; otherwise English.

Reply with ONLY a JSON object, nothing else:
{{"subject": "...", "body": "...", "personalization": "high" or "medium" or "low", "angle": "one short line: what the email is built around"}}"""


def build_user_message(lead, site_summary, notes_label="Notes"):
    lines = ["Lead details:"]
    for label, key in (("Name", "name"), ("Company", "company"), ("Website", "website"), ("Notes", "notes")):
        if key == "notes":
            label = notes_label
        if lead.get(key):
            lines.append(f"- {label}: {lead[key][:1200]}")
    if site_summary:
        lines.append(f"- From their website: {site_summary}")
    if len(lines) == 1:
        lines.append(f"- Only the email address is known: {lead['email']}")
    return "\n".join(lines)


def run(args, profile, llm):
    leads = load_leads(args.input)
    done = done_ids(args.output, "email")
    todo = [l for l in leads if l["email"] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(leads)} emails loaded, {len(done)} already done, {len(todo)} to process.")

    system = build_system_prompt(profile)
    f, writer = open_writer(args.output, OUTPUT_FIELDS)
    with f:
        for i, lead in enumerate(todo, 1):
            row = {k: lead.get(k, "") for k in ("email", "name", "company", "website")}

            if not EMAIL_RE.match(lead["email"]):
                row.update(subject="", body="", personalization="", angle="", status="invalid email")
                writer.writerow(row)
                f.flush()
                print(f"[{i}/{len(todo)}] invalid email: {lead['email']}")
                continue

            site = ""
            if args.fetch_sites and lead.get("website") and not llm.dry_run:
                site = fetch_site_summary(lead["website"])

            fallback = {
                "subject": "[dry-run] subject line",
                "body": "[dry-run] a personalized email body would appear here.",
                "personalization": "low",
                "angle": "dry run, no API call made",
            }
            res = llm.ask_json(system, build_user_message(lead, site), fallback, max_tokens=600)

            if "_error" in res or not res.get("body"):
                row.update(subject="", body="", personalization="", angle=res.get("_error", "empty response"), status="error")
            else:
                body = res["body"].strip()
                signoff = profile["signoff"]
                full_body = f"{body}\n\n{signoff}\n\n{profile['opt_out_line']}"
                row.update(
                    subject=(res.get("subject") or "").strip(),
                    body=full_body,
                    personalization=res.get("personalization", ""),
                    angle=res.get("angle", ""),
                    status="draft",
                )
            writer.writerow(row)
            f.flush()
            print(f"[{i}/{len(todo)}] {row['status']}: {lead['email']}")
            if not llm.dry_run:
                time.sleep(args.gap)

    print(f"Done. Review {args.output}, edit anything you like, then send yourself in small batches.")
