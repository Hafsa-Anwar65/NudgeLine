"""Draft personalized outreach emails from a list of emails (txt or csv). Draft only, never sends."""

import csv
import html
import re
import sys
import time
from pathlib import Path

from . import quality
from .common import done_ids, open_writer, prepare_output, tone_line

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Accepted column names for each field. Headers are matched in lower case with spaces
# and symbols turned into "_", so "Business Name" matches "business_name".
FIELD_MAP = {
    "email": ("email", "e_mail", "email_address", "emails", "owner_email", "business_email"),
    "name": ("name", "owner", "owner_name", "business_owner", "contact", "contact_name",
             "full_name", "first_name", "author", "author_name", "client_name", "client"),
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
    "personalization", "angle", "qa_flags", "status",
]

TITLE_RE = re.compile(r"^(dr|mr|mrs|ms|miss|engr|prof|sir)\.?\s+", re.I)


def first_name(full):
    parts = TITLE_RE.sub("", (full or "").strip()).split()
    return parts[0] if parts else ""


def load_template(path):
    """Read your own email template (a text file). Placeholders: {first_name} {name} {company} {post_hook}."""
    if not path:
        return ""
    p = Path(path)
    if not p.exists():
        sys.exit(f"Template file not found: {path}")
    text = p.read_text(encoding="utf-8").strip()
    if not text:
        sys.exit(f"Template file is empty: {path}")
    return text


def build_template_prompt(profile, template):
    name, service = profile["name"], profile["service"]
    return f"""You personalize an email TEMPLATE for {name}, who offers: {service}.
The template below is the email. Keep its wording, tone, line breaks and structure EXACTLY.
Your only job is to fill the placeholders:
- {{first_name}} = the lead's first name (or "there" if unknown)
- {{name}} = the lead's full name (or "there" if unknown)
- {{company}} = the lead's business name (omit gracefully if unknown)
- {{post_hook}} = ONE natural sentence about what they asked or talked about in their public post (not a word-for-word quote, in the post's language, using only facts given)
Do not add, remove or rewrite anything else. Do not invent facts.
If the template's first line starts with "Subject:", put that line (without "Subject:") in "subject" and remove it from the body. Otherwise write a plain 3 to 7 word subject.
Do not add a sign-off or unsubscribe line; the template already has its own.

TEMPLATE:
\"\"\"
{template}
\"\"\"

Reply with ONLY a JSON object, nothing else:
{{"subject": "...", "body": "...", "personalization": "high" or "medium" or "low", "angle": "one short line: what the email is built around"}}"""


def make_system(profile, template=""):
    return build_template_prompt(profile, template) if template else build_system_prompt(profile)


def finish_email(res, profile, source_text, template=""):
    """Turn the model's JSON into (subject, full_body, flags). full_body includes sign-off/opt-out."""
    subject = (res.get("subject") or "").strip()
    body = res["body"].strip()
    flags = quality.email_flags(subject, body, source_text + " " + profile["service"] + " " + profile["about"], bool(template))
    tail = profile["opt_out_line"] if template else f"{profile['signoff']}\n\n{profile['opt_out_line']}"
    return subject, f"{body}\n\n{tail}", flags


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
- Use ONLY facts given in the lead details. Never invent facts, numbers, results, mutual connections, prices, or things you "noticed". If details are thin, write a shorter, honest, generic email and set personalization to "low".
- Open with something specific to them (their business, site, or situation), not with "I hope this finds you well" or an introduction of yourself.
- Say plainly what {name} can help with, in one sentence, and make exactly one small, low-pressure ask (a quick reply or a short call).
- Warm and human, no hype, no buzzwords, no exclamation marks, no emojis, no fake urgency.
- Write in the language of the lead's notes if they are not English; otherwise English.

Reply with ONLY a JSON object, nothing else:
{{"subject": "...", "body": "...", "personalization": "high" or "medium" or "low", "angle": "one short line: what the email is built around"}}"""


def build_user_message(lead, site_summary, notes_label="Notes"):
    lines = ["Lead details:"]
    if lead.get("name"):
        lines.append(f"- First name: {first_name(lead['name']) or 'there'}")
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
    template = load_template(getattr(args, "template", None))
    prepare_output(args.output, OUTPUT_FIELDS)
    done = done_ids(args.output, "email")
    todo = [l for l in leads if l["email"] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(leads)} emails loaded, {len(done)} already done, {len(todo)} to process.")

    system = make_system(profile, template)
    f, writer = open_writer(args.output, OUTPUT_FIELDS)
    with f:
        for i, lead in enumerate(todo, 1):
            row = {k: lead.get(k, "") for k in ("email", "name", "company", "website")}

            if not EMAIL_RE.match(lead["email"]):
                row.update(subject="", body="", personalization="", angle="", qa_flags="", status="invalid email")
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
                row.update(subject="", body="", personalization="", angle=res.get("_error", "empty response"), qa_flags="", status="error")
            else:
                source = " ".join(str(lead.get(k, "")) for k in ("name", "company", "notes", "website"))
                subject, full_body, flags = finish_email(res, profile, source, template)
                row.update(
                    subject=subject,
                    body=full_body,
                    personalization=res.get("personalization", ""),
                    angle=res.get("angle", ""),
                    qa_flags="; ".join(flags),
                    status="needs_edit" if flags else "draft",
                )
            writer.writerow(row)
            f.flush()
            print(f"[{i}/{len(todo)}] {row['status']}: {lead['email']}")
            if not llm.dry_run:
                time.sleep(args.gap)

    from . import review
    page = review.write_html(args.output)
    print(f"Done. Open {page} to review, edit {args.output} if needed, then run:")
    print(f'  python main.py approve --input "{args.output}"')
