# Nudgeline

Two small tools in one project. Both **draft only**: nothing is posted or sent for you.

1. **comments**: reads already-fetched Facebook posts and drafts short, natural comments.
2. **emails**: reads a list of emails and drafts a personalized email for each one.

Results go to a CSV in `output/`. You review, edit, and send or post them yourself.

## Setup

```
pip install -r requirements.txt
copy .env.example .env        (Windows)   |   cp .env.example .env   (Mac/Linux)
```

Open `.env` and fill in **one** key: `GROQ_API_KEY` (Groq, key starts with `gsk_`),
`XAI_API_KEY` (Grok, `xai-`) or `ANTHROPIC_API_KEY` (Claude, `sk-ant-`). The provider is picked
from the key. If you set more than one key, add `LLM_PROVIDER=groq` (or `xai` / `anthropic`).
If the default model name is rejected, copy an exact model name from your provider's console
into `LLM_MODEL` in `.env`.

Then edit `profile.json` with your name, what you offer, and your sign-off.

## Comments

```
python main.py comments --input sample/posts.json
```

Input: JSON or CSV with fields like `text`, `url`, `author` (other common names such as
`post_text`, `link`, `author_name` also work; add more in `TEXT_KEYS` inside
`drafter/comments.py`). Output: `output/comments.csv`.

Posts that are not a real need for your service are marked `skipped`.

## Emails

```
python main.py emails --input sample/leads.csv
python main.py emails --input sample/leads.csv --fetch-sites
python main.py emails --input sample/emails.txt
```

Input can be:
- a **CSV** with an `email` column, and optionally `name`, `company`, `website`, `notes`
  (the more you give, the more personal the email)
- a **TXT** file with one email per line

`--fetch-sites` fetches each lead's homepage once (plain HTTP, no browser) and gives the
writer a few real facts, such as the site's headline, and simple signals like "not on HTTPS".

Output: `output/emails.csv` with `subject`, `body`, `personalization` (high/medium/low) and
`angle`. Your sign-off and opt-out line from `profile.json` are added to every email.

## Comment + email in one run (`both`)

For a list where every row has a post, a business name, the owner's name and an email:

```
python main.py both --input sample/old_data.csv --limit 5
```

Input can be CSV, Excel (`.xlsx`) or JSON. Column names are matched loosely, for example
`Post Content`, `Business Name`, `Owner Name` and `Email` all work (also `post_text`,
`company`, `name`, `owner`, `website`, `post_url`...).

Output: `output/outreach.csv`, one row per lead, with `comment` (for their post),
`subject` and `body` (the email), plus notes on why. Rows with no valid email still get a
comment; posts that are not a real need get no comment (the reason is in `comment_note`).

## Useful options

- `--limit 5` try a few first
- `--dry-run` test the whole pipeline without calling the API
- `--output path.csv` choose the output file
- Re-running the same command resumes and skips items already in the output file

## Sending responsibly

- Read every draft. Fix anything that sounds off before it goes out.
- The writer is told to use only facts you provide, but always double-check names and details.
- Send from your own address in small batches, to people with a real reason to hear from you.
- Keep the opt-out line, honour replies that say no, and follow the email and anti-spam rules
  that apply where you and your recipients are.
- For Facebook, post comments manually. Automated commenting gets accounts restricted.

## New: quality checks, priority, tone, templates and a review step

Every draft now goes through automatic checks and a mandatory human review before anything is exported.

- **Priority**: the AI scores how clearly the person is asking for your service (1-5). Rows are sorted high to low (`priority`, `intent_score` columns).
- **Language**: detected per row (English / Urdu / Roman Urdu / Mixed); replies match the post.
- **Tone**: `--tone friendly|professional|casual`, or set `"tone"` in `profile.json`.
- **Your own email template**: `--template sample\email_template.txt`. Placeholders: `{first_name}` `{name}` `{company}` `{post_hook}`. The AI only fills the placeholders and keeps your wording. A first line starting with `Subject:` sets the subject. Put your own sign-off in the template; the opt-out line is added automatically.
- **Quality checks** (column `qa_flags`): too long, links, hashtags, many emojis, salesy/spam words, ALL CAPS subject, leftover `{placeholders}`, numbers that are not in the source (invented facts), email length. Rows with warnings get status `needs_edit`.
- **Review page**: each run writes an HTML page next to the CSV (for example `output\outreach.html`). Open it in your browser.
- **Approve step**: only rows with status `draft` are exported.

```powershell
python main.py both --input "my_data.csv" --limit 5 --tone professional --template sample\email_template.txt
# open output\outreach.html, edit output\outreach.csv if you want (set status to draft for rows you approve)
python main.py approve --input output\outreach.csv
# or go through them one by one:
python main.py approve --input output\outreach.csv --interactive
```

The approved rows are saved to `output\outreach_approved.csv`. Nothing is ever posted or sent by the tool; you do that yourself.

If an older output file has different columns, it is kept as `*.old.csv` and a fresh file is started.

## Web app (frontend)

```powershell
cd "E:\Nudge Line\nudgeline"
python app.py
```
Your browser opens `http://127.0.0.1:8000`. Upload your CSV/XLSX/JSON (or use the 5 sample rows), fill in "About you", pick a tone, optionally paste your own email template, then press **Generate drafts**.
Review each draft in the page, edit the text, **Approve** or **Reject**, and **Export approved CSV**. Tick "Test run" to try the whole flow without an API key.
The app runs only on your computer (127.0.0.1) and uses the key from `.env`. Nothing is posted or sent. Stop it with Ctrl+C. Port busy? `python app.py --port 8001`.
