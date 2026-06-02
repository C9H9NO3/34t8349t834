# Email Contact Enrichment

Two scripts in this folder:

- **`enrich_contacts.py`** (current) - enriches each email/phone row with the
  person's name and all of their emails/phones via the **RocketReach** API.
- **`find_company_names.py`** (legacy) - scrapes each domain's website and uses
  OpenAI to find the legal corporate name. Superseded by the script above.

## Setup

```bash
pip install -r requirements.txt
```

## enrich_contacts.py

### What it does

For each `email,[Name,]phone(s)` row in `New Text Document.txt`:

1. **Reverse phone lookup (primary)** - asks RocketReach for the profile that
   owns the phone number from the file (`/person/lookup` with `lookup_type=phone`).
   On a hit, it records the data and moves on.
2. **Company fallback** - if the phone lookup finds nothing, it resolves the
   company by the email domain via the **free** `POST /searchCompany` endpoint
   (no Company Export credits needed), infers the likely person name (the name
   in the file if present, otherwise via OpenAI), searches employees at that
   company (`/person/search`), lets OpenAI score which candidate is the right
   person, and pulls full contact details for the best match
   (`/person/lookup?id=`).

   Note: the paid `GET /company/lookup` endpoint returns richer firmographics
   but requires Company Export credits (it 403s without them). Set
   `USE_PAID_COMPANY_LOOKUP = True` to also try it as a fallback.

Async lookups are polled via `/person/checkStatus` until complete, and HTTP 429
responses are retried with backoff.

### Resumable progress

Successful rows are appended to `enrich_cache.jsonl` as they complete. On the
next run, any email already in that cache is **skipped** (no API call, no
credit), so you can stop and restart freely - useful because the run is paced by
rate limits and can span hours. Only successes are cached; failed/blank rows are
retried on the next run. Delete `enrich_cache.jsonl` to force a full re-run. The
`emails_enriched.csv` is rebuilt every `CSV_FLUSH_EVERY` rows and at the end.

### Rate limiting and credits

At startup the script reads `GET /account/` for your live rate limits and
remaining lookup credits, then proactively throttles every call with a
sliding-window limiter (per-action windows plus a global 10 requests/second cap)
so it stays under the limits instead of relying only on 429 retries. The binding
limit is usually `person_lookup` (e.g. ~60/hour on this key), so a large run
self-paces over a couple of hours. When the lookup credit budget reaches 0 the
script stops spending (`STOP_WHEN_OUT_OF_CREDITS`) and saves progress; just
re-run after topping up.

### Configure

Edit the constants near the top of `enrich_contacts.py`:

- `ROCKETREACH_API_KEY` - already hard-coded.
- `OPENAI_API_KEY` - optional. If blank, name inference and candidate scoring
  fall back to simple heuristics instead of AI.
- `INPUT_PATH` / `OUTPUT_CSV_PATH` / `CACHE_PATH` - default to this folder.
- `USE_PAID_COMPANY_LOOKUP` - when True, also queries the paid
  `GET /company/lookup` and merges it with the free `searchCompany` result.
- Tuning: `OPENAI_MODEL`, `MAX_WORKERS`, `CSV_FLUSH_EVERY`,
  `STOP_WHEN_OUT_OF_CREDITS`, `CONFIDENCE_THRESHOLD`, `POLL_INTERVAL`,
  `POLL_TIMEOUT`, `MAX_RETRIES`, `REQUEST_TIMEOUT`, `DEFAULT_COUNTRY_CODE`,
  and the `FALLBACK_RATE_LIMITS` used if `/account/` can't be read.

No command-line arguments; everything is hard-coded.

### Run

```bash
python enrich_contacts.py
```

### Output

`emails_enriched.csv` with columns:

`input_email, input_name, input_phones, match_source, match_confidence,
person_name, person_title, company_name, linkedin_url, recommended_personal_email,
current_personal_email, emails, phones, notes`

- `emails` = `address|type|grade` entries joined by `; ` (ALL returned).
- `phones` = `number|type` entries joined by `; ` (ALL returned).
- `recommended_personal_email` / `current_personal_email` = RocketReach's
  dedicated personal-email fields when present.
- `match_source` = `phone`, `company_search`, or `none`.
- `notes` explains why a row was not enriched (no match, missing credits, etc.).

### How the company-fallback flow works

`searchCompany` (free) resolves the domain to a company. `person/search` (free)
then returns the company's employees as profile metadata only - names, titles,
LinkedIn, **no emails**. OpenAI scores which employee matches the email's owner,
and a single `person/lookup` (1 credit) retrieves that person's personal email
and number. So the AI matches on identity, and exactly one paid lookup is spent
per matched person.

### Requirements / caveats

- Person lookups consume `premium`/`standard` lookup credits; the free endpoints
  (`searchCompany`, `person/search`, `checkStatus`, `account`) do not.
- The paid `GET /company/lookup` needs Company Export credits and 403s without
  them; the script defaults to the free `searchCompany` and degrades gracefully.
- The API key is stored in plaintext in the script, as requested.
