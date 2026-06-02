"""Enrich a CSV of people with contact data via RocketReach, keyed on LinkedIn URL.

The input CSV has columns: Name, Title, Company, Email, LinkedIn URL. Every row
has a LinkedIn URL, which is RocketReach's highest-accuracy lookup key, so the
flow is simply:

  1. GET /person/lookup?linkedin_url=<url> and poll until complete.
  2. Collect ALL emails and ALL phone numbers from the profile (merging in any
     email already present in the CSV).
  3. Pull the person's city/state (falling back to the raw location string).

Writes a plain TXT file, one line per person:

    Name | email1; email2 | +1...; +1... | City, State

Rows with no RocketReach hit are still written using whatever the CSV provided
so nobody is dropped. Runs are resumable via a JSONL cache.

Everything is hard-coded below: no command-line arguments.
"""

import csv
import json
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import unquote

import requests

# --------------------------------------------------------------------------- #
# Configuration (edit these)                                                   #
# --------------------------------------------------------------------------- #
HERE = Path(__file__).resolve().parent

INPUT_CSV_PATH = Path(
    r"C:\Users\utgdu\Downloads"
    r"\Angel-Investor-Venture-Partner-General-Partner-Venture-Capital-Partner-Family-Of-2026-05-07T11-00-52 (1).csv"
)
OUTPUT_TXT_PATH = HERE / "linkedin_enriched.txt"
# Resumable progress: completed rows are appended here as JSON lines and skipped
# on the next run. Delete this file to force a full re-enrichment.
CACHE_PATH = HERE / "enrich_linkedin_cache.jsonl"
TXT_FLUSH_EVERY = 5  # rebuild the TXT after this many newly completed rows

# RocketReach API key (hard-coded as requested).
ROCKETREACH_API_KEY = "1eb88aakead563de46fb9c96ba3d4efbf28a4f95"
ROCKETREACH_BASE = "https://api.rocketreach.co/api/v2"

# Field/value separators for the output lines.
FIELD_SEP = " | "
MULTI_SEP = "; "

REQUEST_TIMEOUT = 20      # seconds per HTTP request
MAX_WORKERS = 2           # keep low: person_lookup must serialize under ~9/min
POLL_INTERVAL = 3         # seconds between checkStatus polls
POLL_TIMEOUT = 90         # max seconds to wait for an async lookup to complete
MAX_RETRIES = 4           # retries on HTTP 429 / transient errors

# Stop spending once lookup credits are gone (progress is saved either way).
STOP_WHEN_OUT_OF_CREDITS = True

# Fallback rate limits used only if GET /account/ can't be read. Each action
# maps to a list of (window_seconds, max_calls). The live account limits
# override these at startup. There is also a global 10 requests/second cap.
GLOBAL_RATE_LIMIT = (1, 10)  # (window_seconds, max_calls) across all endpoints
FALLBACK_RATE_LIMITS = {
    "person_lookup": [(60, 9), (3600, 60), (86400, 300)],
    "person_search": [(60, 10), (3600, 35), (86400, 350)],
    "company_search": [(60, 10), (3600, 35), (86400, 350)],
}


# --------------------------------------------------------------------------- #
# Input parsing                                                                #
# --------------------------------------------------------------------------- #
def _col(row, *names):
    """Return the first non-empty value among the given column names."""
    for name in names:
        value = (row.get(name) or "").strip()
        if value:
            return value
    return ""


def parse_csv(path):
    """Return a list of dicts: {name, company, email, linkedin_url, order}."""
    entries = []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for i, row in enumerate(reader):
            linkedin = _col(row, "LinkedIn URL", "Linkedin URL", "linkedin_url")
            name = _col(row, "Name", "name")
            company = _col(row, "Company", "company")
            email = _col(row, "Email", "email")
            if not (linkedin or name or email):
                continue
            entries.append(
                {
                    "order": i,
                    "name": name,
                    "company": company,
                    "email": email,
                    # URL-decode %xx escapes (e.g. accented chars, cfp%c2%ae).
                    "linkedin_url": unquote(linkedin) if linkedin else "",
                }
            )
    return entries


# --------------------------------------------------------------------------- #
# RocketReach client                                                           #
# --------------------------------------------------------------------------- #
class RocketReachError(Exception):
    pass


class RateLimiter:
    """Thread-safe sliding-window limiter: a global window plus per-action windows.

    Each call to acquire() blocks until making a request would not exceed any of
    the configured windows, so we proactively stay under RocketReach's limits
    instead of relying solely on 429 retries.
    """

    def __init__(self, global_window, action_windows):
        self._lock = threading.Lock()
        self._global_window = global_window  # (seconds, limit)
        self._global_dq = deque()
        self._action_windows = action_windows  # {action: [(seconds, limit), ...]}
        self._action_dq = {a: deque() for a in action_windows}

    def _groups(self, action):
        groups = [([self._global_window], self._global_dq)]
        if action and action in self._action_windows:
            groups.append((self._action_windows[action], self._action_dq[action]))
        return groups

    def acquire(self, action):
        while True:
            with self._lock:
                now = time.time()
                wait = 0.0
                groups = self._groups(action)
                for windows, dq in groups:
                    max_win = max(w for w, _ in windows)
                    while dq and dq[0] <= now - max_win:
                        dq.popleft()
                    for win, limit in windows:
                        recent = [t for t in dq if t > now - win]
                        if len(recent) >= limit:
                            wait = max(wait, recent[0] + win - now)
                if wait <= 0:
                    for _, dq in groups:
                        dq.append(now)
                    return
            time.sleep(min(wait, 5.0) + 0.01)


class CreditTracker:
    """Tracks remaining lookup credits so we can stop before overspending."""

    def __init__(self, remaining=None):
        self._lock = threading.Lock()
        self.remaining = remaining  # None = unknown -> do not enforce

    def can_lookup(self):
        if self.remaining is None:
            return True
        return self.remaining > 0

    def consume(self):
        with self._lock:
            if self.remaining is not None and self.remaining > 0:
                self.remaining -= 1


# Module-level limiter/credits, (re)configured from the account at startup.
RATE_LIMITER = RateLimiter(GLOBAL_RATE_LIMIT, dict(FALLBACK_RATE_LIMITS))
CREDITS = CreditTracker(None)

_DURATION_SECONDS = {
    "one_second": 1,
    "one_minute": 60,
    "one_hour": 3600,
    "one_day": 86400,
    "one_month": 2592000,
}
# Map URL path prefixes to the rate-limit action that governs them.
_PATH_ACTION = [
    ("person/lookup", "person_lookup"),
    ("person/search", "person_search"),
    ("searchCompany", "company_search"),
    ("company/lookup", "company_search"),
]


def _action_for_path(path):
    clean = path.lstrip("/")
    for prefix, action in _PATH_ACTION:
        if clean.startswith(prefix):
            return action
    return None  # only the global limit applies (e.g. checkStatus, account)


def configure_from_account(account):
    """Seed the rate limiter and credit tracker from a GET /account/ payload."""
    global RATE_LIMITER, CREDITS

    action_windows = {a: list(w) for a, w in FALLBACK_RATE_LIMITS.items()}
    global_window = GLOBAL_RATE_LIMIT
    parsed = {}
    for entry in account.get("rate_limits") or []:
        action = entry.get("action")
        seconds = _DURATION_SECONDS.get(entry.get("duration"))
        limit = entry.get("limit")
        if not action or not seconds or not limit:
            continue
        if action == "api_request" and seconds == 1:
            global_window = (1, limit)
            continue
        parsed.setdefault(action, []).append((seconds, limit))
    for action, windows in parsed.items():
        action_windows[action] = windows
    RATE_LIMITER = RateLimiter(global_window, action_windows)

    budget = 0
    known = False
    for cu in account.get("credit_usage") or []:
        if cu.get("credit_type") in ("premium_lookup", "standard_lookup"):
            remaining = cu.get("remaining")
            if isinstance(remaining, int):
                budget += remaining
                known = True
    CREDITS = CreditTracker(budget if known else None)
    return action_windows, global_window, (budget if known else None)


def fetch_account(session):
    resp = _request(session, "GET", "account/")
    if resp.status_code >= 400:
        return None
    return _parse_json(resp)


def _new_session():
    session = requests.Session()
    session.headers.update(
        {
            "Api-Key": ROCKETREACH_API_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
    )
    return session


def _request(session, method, path, *, params=None, json_body=None):
    """Make a request with proactive rate limiting + retry/backoff on 429/5xx."""
    url = f"{ROCKETREACH_BASE}/{path.lstrip('/')}"
    action = _action_for_path(path)
    delay = 2.0
    for attempt in range(1, MAX_RETRIES + 1):
        RATE_LIMITER.acquire(action)
        try:
            resp = session.request(
                method,
                url,
                params=params,
                json=json_body,
                timeout=REQUEST_TIMEOUT,
            )
        except requests.RequestException as exc:
            if attempt == MAX_RETRIES:
                raise RocketReachError(f"network error: {exc}") from exc
            time.sleep(delay)
            delay *= 2
            continue

        if resp.status_code == 429:
            retry_after = resp.headers.get("Retry-After")
            wait = float(retry_after) if retry_after else delay
            time.sleep(wait)
            delay *= 2
            continue

        if resp.status_code in (500, 502, 503, 504) and attempt < MAX_RETRIES:
            time.sleep(delay)
            delay *= 2
            continue

        return resp

    raise RocketReachError("exhausted retries")


def _parse_json(resp):
    try:
        return resp.json()
    except ValueError:
        return None


def rr_person_lookup(session, *, linkedin_url=None, profile_id=None, name=None,
                     employer=None, email=None):
    """Start a person lookup and wait for it to complete. Returns the profile or None."""
    if STOP_WHEN_OUT_OF_CREDITS and not CREDITS.can_lookup():
        raise RocketReachError("stopped: out of lookup credits")

    params = {}
    if linkedin_url:
        params["linkedin_url"] = linkedin_url
    if profile_id:
        params["id"] = profile_id
    if name:
        params["name"] = name
    if employer:
        params["current_employer"] = employer
    if email:
        params["email"] = email
    if not params:
        return None

    resp = _request(session, "GET", "person/lookup", params=params)
    if resp.status_code == 404:
        return None
    if resp.status_code == 403:
        raise RocketReachError("403 - API key lacks Person Lookup access/credits")
    if resp.status_code >= 400:
        return None

    data = _parse_json(resp)
    if not data:
        return None

    profile = _wait_for_complete(session, data)
    # A credit is spent only when verified contact data is returned.
    if profile and _has_contact_data(profile):
        CREDITS.consume()
    return profile


def _wait_for_complete(session, data):
    """Poll checkStatus until the lookup status is complete (or timeout)."""
    status = (data.get("status") or "").lower()
    profile_id = data.get("id")

    if status in ("complete", "failed", "") or not profile_id:
        return data if _has_contact_data(data) or status == "complete" else data

    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        if status == "complete":
            return data
        if status == "failed":
            return None
        time.sleep(POLL_INTERVAL)
        resp = _request(session, "GET", "person/checkStatus", params={"id": profile_id})
        if resp.status_code >= 400:
            break
        polled = _parse_json(resp)
        if not polled:
            break
        # checkStatus may return a list or a single object.
        if isinstance(polled, list):
            polled = next((p for p in polled if p.get("id") == profile_id), polled[0] if polled else {})
        data = polled
        status = (data.get("status") or "").lower()

    return data


def _has_contact_data(profile):
    return bool(profile.get("emails")) or bool(profile.get("phones"))


# --------------------------------------------------------------------------- #
# Extracting fields from a RocketReach profile                                 #
# --------------------------------------------------------------------------- #
def extract_emails(profile, seed_email=""):
    """Return a deduped, order-preserving list of email addresses."""
    out = []
    seen = set()

    def add(addr):
        addr = (addr or "").strip()
        if addr and addr.lower() not in seen:
            seen.add(addr.lower())
            out.append(addr)

    add(seed_email)
    for item in profile.get("emails") or []:
        if isinstance(item, dict):
            add(item.get("email", ""))
        elif isinstance(item, str):
            add(item)
    return out


def extract_phones(profile):
    """Return personal numbers only (mobile/home), recommended first, deduped.

    RocketReach tags each phone with a `type` (mobile/home/work/landline/fax/
    unknown) and a `recommended` flag. We keep only personal lines (mobile/home),
    dropping work/landline/fax/unknown and any legacy plain-string phones, then
    surface the recommended number(s) first.
    """
    kept = []  # (recommended, number)
    for item in profile.get("phones") or []:
        if not isinstance(item, dict):
            continue  # plain strings have no type -> dropped under personal-only
        ptype = (item.get("type") or "").strip().lower()
        if ptype not in ("mobile", "home"):
            continue
        number = (item.get("number") or "").strip()
        if number:
            kept.append((bool(item.get("recommended")), number))
    ordered = [n for rec, n in kept if rec] + [n for rec, n in kept if not rec]
    out, seen = [], set()
    for n in ordered:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def extract_location(profile):
    """Return 'City, State' from the profile, falling back to its location string."""
    city = (profile.get("city") or "").strip()
    region = (profile.get("region") or "").strip()
    if city and region:
        return f"{city}, {region}"
    if city or region:
        return city or region
    return (profile.get("location") or "").strip()


# --------------------------------------------------------------------------- #
# Per-row enrichment                                                           #
# --------------------------------------------------------------------------- #
def enrich_entry(entry):
    """Run the lookup for one entry. Returns a result dict (cacheable)."""
    session = _new_session()
    result = {
        "order": entry["order"],
        "linkedin_url": entry["linkedin_url"],
        "name": entry["name"],
        "emails": [entry["email"]] if entry["email"] else [],
        "phones": [],
        "phones_all": [],
        "location": "",
        "matched": False,
        "notes": "",
    }

    try:
        profile = None
        if entry["linkedin_url"]:
            try:
                profile = rr_person_lookup(session, linkedin_url=entry["linkedin_url"])
            except RocketReachError as exc:
                result["notes"] = str(exc)
                profile = None

        if profile and _has_contact_data(profile):
            result["name"] = profile.get("name") or entry["name"]
            result["emails"] = extract_emails(profile, seed_email=entry["email"])
            result["phones"] = extract_phones(profile)
            result["phones_all"] = profile.get("phones") or []
            result["location"] = extract_location(profile)
            result["matched"] = True
            print(f"  [{entry['name']}] matched ({len(result['emails'])} emails, "
                  f"{len(result['phones'])} phones)")
        else:
            if not result["notes"]:
                result["notes"] = "no contact data"
            print(f"  [{entry['name']}] no match")
        return result

    except Exception as exc:  # noqa: BLE001
        result["notes"] = (result["notes"] + "; " if result["notes"] else "") + f"error: {exc}"
        print(f"  [{entry['name']}] error: {exc}", file=sys.stderr)
        return result
    finally:
        session.close()


def format_line(result):
    """Render a result as 'Name | emails | numbers | City, State'."""
    name = result.get("name", "")
    emails = MULTI_SEP.join(result.get("emails") or [])
    phones = MULTI_SEP.join(result.get("phones") or [])
    location = result.get("location", "")
    return FIELD_SEP.join([name, emails, phones, location])


# --------------------------------------------------------------------------- #
# Resumable cache + output                                                     #
# --------------------------------------------------------------------------- #
class ProgressStore:
    """Persists completed rows to a JSONL cache so runs are resumable.

    Only the main thread (the as_completed consumer) writes here, so no lock is
    needed for appends. Keyed on LinkedIn URL.
    """

    def __init__(self, cache_path):
        self.cache_path = cache_path
        self.cache = {}  # key -> result dict

    @staticmethod
    def _key(entry_or_result):
        url = (entry_or_result.get("linkedin_url") or "").strip().lower()
        if url:
            return url
        return f"name:{(entry_or_result.get('name') or '').strip().lower()}"

    def load(self):
        if not self.cache_path.exists():
            return
        for line in self.cache_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            self.cache[self._key(rec)] = rec

    def has(self, entry):
        return self._key(entry) in self.cache

    def get(self, entry):
        return self.cache.get(self._key(entry))

    def save(self, result):
        self.cache[self._key(result)] = result
        with self.cache_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(result, ensure_ascii=False) + "\n")


def write_txt(entries, results_by_key, store):
    with OUTPUT_TXT_PATH.open("w", encoding="utf-8") as fh:
        for entry in entries:
            result = results_by_key.get(store._key(entry))
            if not result:
                # Not yet processed: fall back to whatever the CSV had.
                result = {
                    "name": entry["name"],
                    "emails": [entry["email"]] if entry["email"] else [],
                    "phones": [],
                    "location": "",
                }
            fh.write(format_line(result) + "\n")


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #
def main():
    if not INPUT_CSV_PATH.exists():
        sys.exit(f"Input file not found: {INPUT_CSV_PATH}")
    if not ROCKETREACH_API_KEY:
        sys.exit("ROCKETREACH_API_KEY is empty. Paste your key into the constant.")

    entries = parse_csv(INPUT_CSV_PATH)
    print(f"Parsed {len(entries)} rows from {INPUT_CSV_PATH.name}")

    # Seed rate limits + credit budget from the live account.
    session = _new_session()
    account = fetch_account(session)
    session.close()
    if account:
        action_windows, global_window, budget = configure_from_account(account)
        print(f"Account: rate global={global_window[1]}/s; "
              f"person_lookup={action_windows.get('person_lookup')}; "
              f"lookup credit budget={budget if budget is not None else 'unknown'}")
    else:
        print("WARNING: could not read /account/; using fallback rate limits.", file=sys.stderr)

    # Resume: load prior results and skip them.
    store = ProgressStore(CACHE_PATH)
    store.load()
    results_by_key = {store._key(e): store.get(e) for e in entries if store.has(e)}
    pending = [e for e in entries if not store.has(e)]
    if results_by_key:
        print(f"Resuming: {len(results_by_key)} already in cache, {len(pending)} to process.")

    completed = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(enrich_entry, e): e for e in pending}
        for future in as_completed(futures):
            result = future.result()
            results_by_key[store._key(result)] = result
            store.save(result)
            completed += 1
            if completed % TXT_FLUSH_EVERY == 0:
                write_txt(entries, results_by_key, store)

    write_txt(entries, results_by_key, store)

    elapsed = time.time() - started
    matched = sum(1 for r in results_by_key.values() if r and r.get("matched"))
    print(f"Done in {elapsed:.0f}s. Enriched {matched}/{len(entries)} rows "
          f"({len(pending)} processed this run). Output: {OUTPUT_TXT_PATH}")


if __name__ == "__main__":
    main()
