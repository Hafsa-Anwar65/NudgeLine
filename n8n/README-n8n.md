# Nudgeline on n8n (Docker)

Per row of your data (post content, business name, owner name, email) it drafts ONE comment and ONE email.
**Draft only. A human review step is mandatory before the final file exists. Nothing is posted or sent.**

## Setup (only your API key is needed)
1. Install and start Docker Desktop.
2. In this folder: copy `.env.example` to `.env`, paste your Groq key after `GROQ_API_KEY=`.
3. `docker compose up -d`, open http://localhost:5678, create the local owner account.
4. Workflows -> menu -> Import from File -> `nudgeline-workflow.json`.
5. Put your rows in `data/old_data.csv` (headers: Post Content, Business Name, Owner Name, Email).

## Run
1. **Execute workflow**. A form opens; every field is optional (Submit = defaults):
   name, service, about, **tone** (Friendly / Professional / Casual), **email template (optional)**, rows to process.
   Template placeholders: `{first_name}` `{name}` `{company}` `{post_hook}`. With a template the AI only fills placeholders and keeps your wording.
   Start the template with `Subject: ...` for a fixed subject, and include your own sign-off.
2. Drafts are saved to `data/outreach_drafts.csv` and a **review page** opens: status chips, priority, language, warnings, token usage.
3. Optional: edit `outreach_drafts.csv` (close it after). Set `status` to `draft` for rows you approve.
4. Choose **Approve** or **Reject**. Approve re-reads your edited CSV and writes only `status = draft` rows to `data/outreach_approved.csv`.
5. Post and send yourself from the approved file.

## What makes it more than a basic prompt
| Feature | What it does |
|---|---|
| Intent score + priority | AI rates how clearly the person is asking for your service (1-5); rows sorted high -> low |
| Language detection | English / Urdu / Roman Urdu / Mixed shown per row; replies match the post |
| Auto quality checks | Flags: too long, links, hashtags, many emojis, salesy/spam words, ALL CAPS subject, leftover `{placeholders}`, numbers not found in the source (anti-hallucination) |
| Status | `draft` = clean, `needs_edit` = has warnings (not exported until you set it to draft), `skipped` = not relevant, `error` = API failed |
| Resilience | 3 retries per call; one failure never stops the rest |
| Clean data | Duplicates removed, titles (Dr./Mr.) stripped from first names, bad emails skipped (comment still made) |
| Opt-out line | Added by code, not AI |
| Optional Gmail drafts | Two disabled nodes at the end: enable them and attach your Gmail OAuth credential to create **drafts** (never sends) |

## Notes
- `.env` is read inside Docker; never commit it (`.gitignore` excludes it).
- Groq rate limit? Raise `batchInterval` in the two HTTP nodes.
- Different column names? Edit the lists in the **Normalize** node.
- Urdu text looks garbled in Excel? Use Data -> From Text/CSV (UTF-8) or open in Google Sheets.
