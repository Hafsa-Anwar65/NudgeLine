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

Open `.env` and fill in **one** key: `XAI_API_KEY` for Grok (key starts with `xai-`) or
`ANTHROPIC_API_KEY` for Claude (key starts with `sk-ant-`). The provider is picked from whichever
key is set. If the default model name is rejected as "not found", copy an exact model name from
your provider's console into `LLM_MODEL` in `.env`.

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
