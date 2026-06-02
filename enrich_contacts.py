"""Enrich a list of business emails with personal contact data via RocketReach.

For each `email,[Name,]phone(s)` row in the input file:
  1. Reverse-phone lookup (primary): ask RocketReach for the profile that owns
     the phone number from the file.
  2. Company fallback: if the phone lookup finds nothing, look up the company
     by the email domain, infer the likely person name (file name, else AI),
     search employees at that company, let the AI score which candidate is the
     right person, then pull full contact details for the best match.

Writes a new CSV with the person's name plus ALL emails and phone numbers
(each tagged with its type), the company, the match source, and an AI
confidence.

Everything is hard-coded below: no command-line arguments.
"""

import csv
import json
import os
import re
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

# --------------------------------------------------------------------------- #
# Configuration (edit these)                                                   #
# --------------------------------------------------------------------------- #
HERE = Path(__file__).resolve().parent

INPUT_PATH = HERE / "New Text Document.txt"
OUTPUT_CSV_PATH = HERE / "emails_enriched.csv"
# Resumable progress: successful rows are appended here as JSON lines and skipped
# on the next run. Delete this file to force a full re-enrichment.
CACHE_PATH = HERE / "enrich_cache.jsonl"
CSV_FLUSH_EVERY = 5  # rebuild the CSV after this many newly completed rows

# RocketReach API key (hard-coded as requested).
ROCKETREACH_API_KEY = "1eb88aakead563de46fb9c96ba3d4efbf28a4f95"
ROCKETREACH_BASE = "https://api.rocketreach.co/api/v2"

# Resolve companies via the free POST /searchCompany endpoint. Set this True
# only if your account has paid Company Export credits and you want to also try
# GET /company/lookup as a fallback (it returns richer firmographics).
USE_PAID_COMPANY_LOOKUP = False

# OpenAI is used to infer a likely name from an email and to score which
# RocketReach search candidate is the right person. Leave blank to disable the
# AI steps (the company-fallback branch then relies on simple heuristics).
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = "gpt-4o-mini"

REQUEST_TIMEOUT = 20      # seconds per HTTP request
MAX_WORKERS = 2           # keep low: person_lookup must serialize under ~9/min
POLL_INTERVAL = 3         # seconds between checkStatus polls
POLL_TIMEOUT = 90         # max seconds to wait for an async lookup to complete
MAX_RETRIES = 4           # retries on HTTP 429 / transient errors
CONFIDENCE_THRESHOLD = 0.5  # min AI confidence to accept a company-search match

DEFAULT_COUNTRY_CODE = "1"  # assume US numbers when normalizing to E.164

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
EMAIL_RE = re.compile(r"[^\s,]+@[^\s,]+\.[^\s,]+")
URL_RE = re.compile(r"^https?://", re.IGNORECASE)
PHONE_RE = re.compile(r"\+?\d[\d\-\.\s()]{6,}\d")


def clean_line(raw):
    """Strip markdown strikethrough and trailing inline notes from a line."""
    line = raw.strip()
    line = line.replace("~~", "")
    line = re.sub(r"\s*-\s*(call screen|calll screen|vm)\s*$", "", line, flags=re.IGNORECASE)
    line = re.sub(r"-\s*(call screen|calll screen|vm)\b", "", line, flags=re.IGNORECASE)
    return line.strip()


def normalize_phone(raw):
    """Return an E.164 string (+1XXXXXXXXXX) or None if it doesn't look valid."""
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return None
    if raw.strip().startswith("+"):
        return "+" + digits
    if len(digits) == 10:
        return "+" + DEFAULT_COUNTRY_CODE + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    if len(digits) >= 7:
        return "+" + digits
    return None


def parse_entries(path):
    """Return a list of dicts: {email, domain, name, phones, line} deduped by email."""
    entries = []
    seen = set()

    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = clean_line(raw)
        if not line:
            continue
        if URL_RE.match(line):
            continue

        email_match = EMAIL_RE.search(line)
        if not email_match:
            continue

        email = email_match.group(0).rstrip(".,;").strip()
        key = email.lower()
        if key in seen:
            continue
        seen.add(key)

        fields = [f.strip() for f in line.split(",") if f.strip()]

        # Name = a field that is not the email and is mostly alphabetic.
        name = ""
        for field in fields:
            if "@" in field:
                continue
            if re.search(r"[A-Za-z]", field) and not re.search(r"\d", field):
                name = field
                break

        # Phones: anything that looks like a number (may be "; " separated).
        phones = []
        for field in fields:
            if "@" in field:
                continue
            for candidate in re.split(r"[;]", field):
                normalized = normalize_phone(candidate)
                if normalized and normalized not in phones:
                    phones.append(normalized)

        domain = email.split("@", 1)[1].lower()
        entries.append(
            {
                "email": email,
                "domain": domain,
                "name": name,
                "phones": phones,
                "line": line,
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


def rr_person_lookup(session, *, phone=None, profile_id=None, name=None, employer=None):
    """Start a person lookup and wait for it to complete. Returns the profile dict or None."""
    if STOP_WHEN_OUT_OF_CREDITS and not CREDITS.can_lookup():
        raise RocketReachError("stopped: out of lookup credits")

    params = {}
    if phone:
        params["phone"] = phone
        params["lookup_type"] = "phone"
    if profile_id:
        params["id"] = profile_id
    if name:
        params["name"] = name
    if employer:
        params["current_employer"] = employer
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


def rr_company_lookup(session, domain):
    """Resolve a company by domain. Returns the company dict (with 'name') or None.

    Uses the free POST /searchCompany endpoint, which does NOT consume Company
    Export credits. When USE_PAID_COMPANY_LOOKUP is True it ALSO queries the paid
    GET /company/lookup endpoint and merges the two for accuracy (paid fields win
    when present); /company/lookup 403s on accounts without Company Export credits.
    """
    company = None
    resp = _request(session, "POST", "searchCompany", json_body={"query": {"domain": [domain]}})
    if resp.status_code < 400:
        data = _parse_json(resp) or {}
        companies = data.get("companies") or []
        if companies:
            # Prefer the company whose email_domain matches the requested domain.
            company = next(
                (c for c in companies if (c.get("email_domain") or "").lower() == domain.lower()),
                companies[0],
            )

    if not USE_PAID_COMPANY_LOOKUP:
        return company

    resp = _request(session, "GET", "company/lookup", params={"domain": domain})
    if resp.status_code == 403:
        raise RocketReachError("403 - API key lacks Company Export access/credits")
    if resp.status_code < 400:
        paid = _parse_json(resp) or {}
        if paid:
            merged = dict(company or {})
            merged.update({k: v for k, v in paid.items() if v})
            return merged
    return company


def rr_person_search(session, *, name=None, employer=None):
    """Search for candidate profiles (free, no contact data). Returns a list."""
    query = {}
    if name:
        query["name"] = [name]
    if employer:
        query["current_employer"] = [employer]
    if not query:
        return []

    resp = _request(session, "POST", "person/search", json_body={"query": query})
    if resp.status_code >= 400:
        return []
    data = _parse_json(resp) or {}
    profiles = data.get("profiles")
    if isinstance(profiles, list):
        return profiles
    return []


# --------------------------------------------------------------------------- #
# OpenAI helpers                                                               #
# --------------------------------------------------------------------------- #
_openai_client = None


def _get_openai_client():
    global _openai_client
    if _openai_client is None:
        from openai import OpenAI

        _openai_client = OpenAI(api_key=OPENAI_API_KEY)
    return _openai_client


def ai_infer_name(email, domain):
    """Infer the most likely full name of the person behind an email."""
    local = email.split("@", 1)[0]
    if not OPENAI_API_KEY:
        return _heuristic_name(local)

    prompt = (
        "Given a business email address, infer the most likely full personal "
        "name of the human who owns it. If the local part is a role mailbox "
        "(e.g. info, sales, hello, contact, accounts, admin, support) and gives "
        "no personal-name signal, respond with exactly NONE.\n\n"
        f"Email: {email}\nDomain: {domain}\n\n"
        "Reply with ONLY the full name (e.g. 'Jane Doe') or NONE."
    )
    try:
        client = _get_openai_client()
        resp = client.chat.completions.create(
            model=OPENAI_MODEL,
            temperature=0,
            messages=[{"role": "user", "content": prompt}],
        )
        answer = (resp.choices[0].message.content or "").strip().strip('"').strip()
    except Exception as exc:  # noqa: BLE001
        print(f"  [openai name infer error] {exc}", file=sys.stderr)
        return _heuristic_name(local)

    if not answer or answer.upper() == "NONE":
        return ""
    return answer


ROLE_LOCALS = {
    "info", "sales", "hello", "contact", "accounts", "account", "admin",
    "support", "mail", "hi", "team", "office", "billing", "help", "mysubs",
}


def _heuristic_name(local):
    base = re.split(r"[._\-+]", local.lower())
    base = [p for p in base if p and not p.isdigit()]
    if not base or base[0] in ROLE_LOCALS:
        return ""
    return " ".join(part.capitalize() for part in base)


def ai_score_candidate(email, file_name, domain, company, candidates):
    """Pick the best matching candidate. Returns (candidate, confidence) or (None, 0)."""
    if not candidates:
        return None, 0.0

    if not OPENAI_API_KEY:
        # Heuristic: prefer the candidate whose name best matches the email/file name.
        target = (file_name or _heuristic_name(email.split("@", 1)[0])).lower()
        best, best_score = None, 0.0
        for cand in candidates:
            cname = (cand.get("name") or "").lower()
            score = _name_overlap(target, cname)
            if score > best_score:
                best, best_score = cand, score
        return (best, best_score) if best_score >= CONFIDENCE_THRESHOLD else (None, best_score)

    slim = [
        {
            "index": i,
            "name": c.get("name"),
            "current_title": c.get("current_title"),
            "current_employer": c.get("current_employer"),
            "linkedin_url": c.get("linkedin_url"),
        }
        for i, c in enumerate(candidates)
    ]
    prompt = (
        "We are trying to identify which candidate profile corresponds to the "
        "owner of a business email. Use the email local-part, any provided name, "
        "the domain, and the company to judge.\n\n"
        f"Email: {email}\nProvided name (may be blank): {file_name}\n"
        f"Domain: {domain}\nCompany: {company}\n\n"
        f"Candidates (JSON): {json.dumps(slim)}\n\n"
        "Respond with ONLY a JSON object: "
        '{\"index\": <best candidate index or -1 if none match>, '
        '\"confidence\": <0.0-1.0>}. '
        "Use -1 and low confidence if no candidate is a plausible match."
    )
    try:
        client = _get_openai_client()
        resp = client.chat.completions.create(
            model=OPENAI_MODEL,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[{"role": "user", "content": prompt}],
        )
        raw = (resp.choices[0].message.content or "").strip()
        parsed = json.loads(raw)
        idx = int(parsed.get("index", -1))
        confidence = float(parsed.get("confidence", 0.0))
    except Exception as exc:  # noqa: BLE001
        print(f"  [openai scoring error] {exc}", file=sys.stderr)
        return None, 0.0

    if idx < 0 or idx >= len(candidates) or confidence < CONFIDENCE_THRESHOLD:
        return None, confidence
    return candidates[idx], confidence


def _name_overlap(a, b):
    if not a or not b:
        return 0.0
    ta, tb = set(a.split()), set(b.split())
    if not ta:
        return 0.0
    return len(ta & tb) / len(ta)


# --------------------------------------------------------------------------- #
# Formatting RocketReach profiles                                              #
# --------------------------------------------------------------------------- #
def format_emails(profile):
    out = []
    for item in profile.get("emails") or []:
        if isinstance(item, dict):
            addr = item.get("email", "")
            etype = item.get("type", "")
            grade = item.get("grade", "")
            out.append("|".join(p for p in (addr, etype, grade) if p))
        elif isinstance(item, str):
            out.append(item)
    return "; ".join(out)


def format_phones(profile):
    out = []
    for item in profile.get("phones") or []:
        if isinstance(item, dict):
            number = item.get("number", "")
            ptype = item.get("type", "")
            out.append("|".join(p for p in (number, ptype) if p))
        elif isinstance(item, str):
            out.append(item)
    return "; ".join(out)


def profile_company_name(profile):
    return profile.get("current_employer") or ""


# --------------------------------------------------------------------------- #
# Per-row enrichment                                                           #
# --------------------------------------------------------------------------- #
def enrich_entry(entry):
    """Run the full flow for one entry. Returns an output row dict."""
    session = _new_session()
    row = {
        "input_email": entry["email"],
        "input_name": entry["name"],
        "input_phones": "; ".join(entry["phones"]),
        "match_source": "none",
        "match_confidence": "",
        "person_name": "",
        "person_title": "",
        "company_name": "",
        "linkedin_url": "",
        "recommended_personal_email": "",
        "current_personal_email": "",
        "emails": "",
        "phones": "",
        "notes": "",
    }

    try:
        # 1. Reverse phone lookup (primary).
        for phone in entry["phones"]:
            try:
                profile = rr_person_lookup(session, phone=phone)
            except RocketReachError as exc:
                row["notes"] = str(exc)
                profile = None
            if profile and _has_contact_data(profile):
                _fill_from_profile(row, profile, source="phone", confidence="direct")
                print(f"  [{entry['email']}] matched by phone {phone}")
                return row

        # 2. Company fallback.
        try:
            company = rr_company_lookup(session, entry["domain"])
        except RocketReachError as exc:
            row["notes"] = str(exc)
            company = None

        company_name = (company or {}).get("name", "")
        if company_name:
            row["company_name"] = company_name

        target_name = entry["name"] or ai_infer_name(entry["email"], entry["domain"])
        if not target_name:
            row["notes"] = (row["notes"] + "; " if row["notes"] else "") + "no person name to search"
            print(f"  [{entry['email']}] no match (role inbox / no name)")
            return row

        candidates = rr_person_search(
            session,
            name=target_name,
            employer=company_name or entry["domain"],
        )
        best, confidence = ai_score_candidate(
            entry["email"], entry["name"], entry["domain"], company_name, candidates
        )
        if not best:
            row["notes"] = (row["notes"] + "; " if row["notes"] else "") + "no confident employee match"
            print(f"  [{entry['email']}] no confident match (conf={confidence:.2f})")
            return row

        profile_id = best.get("id")
        detailed = None
        if profile_id:
            try:
                detailed = rr_person_lookup(session, profile_id=profile_id)
            except RocketReachError as exc:
                row["notes"] = (row["notes"] + "; " if row["notes"] else "") + str(exc)
        profile = detailed or best
        _fill_from_profile(row, profile, source="company_search", confidence=f"{confidence:.2f}")
        if not row["company_name"]:
            row["company_name"] = company_name
        print(f"  [{entry['email']}] matched via company (conf={confidence:.2f})")
        return row

    except Exception as exc:  # noqa: BLE001
        row["notes"] = (row["notes"] + "; " if row["notes"] else "") + f"error: {exc}"
        print(f"  [{entry['email']}] error: {exc}", file=sys.stderr)
        return row
    finally:
        session.close()


def _fill_from_profile(row, profile, *, source, confidence):
    row["match_source"] = source
    row["match_confidence"] = confidence
    row["person_name"] = profile.get("name") or row["person_name"]
    row["person_title"] = profile.get("current_title") or ""
    row["linkedin_url"] = profile.get("linkedin_url") or ""
    row["recommended_personal_email"] = profile.get("recommended_personal_email") or ""
    row["current_personal_email"] = profile.get("current_personal_email") or ""
    row["emails"] = format_emails(profile)
    row["phones"] = format_phones(profile)
    company = profile_company_name(profile)
    if company:
        row["company_name"] = company


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #
CSV_COLUMNS = [
    "input_email",
    "input_name",
    "input_phones",
    "match_source",
    "match_confidence",
    "person_name",
    "person_title",
    "company_name",
    "linkedin_url",
    "recommended_personal_email",
    "current_personal_email",
    "emails",
    "phones",
    "notes",
]


class ProgressStore:
    """Persists successful rows to a JSONL cache so runs are resumable.

    Only the main thread (the as_completed consumer) writes here, so no lock is
    needed for appends.
    """

    def __init__(self, cache_path):
        self.cache_path = cache_path
        self.cache = {}  # email_lower -> row dict

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
            email = (rec.get("input_email") or "").lower()
            if email:
                self.cache[email] = rec

    def has(self, email):
        return email.lower() in self.cache

    def get(self, email):
        return self.cache.get(email.lower())

    def save_success(self, row):
        self.cache[row["input_email"].lower()] = row
        with self.cache_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def _normalize_row(row):
    return {col: row.get(col, "") for col in CSV_COLUMNS}


def write_csv(entries, results_by_email):
    with OUTPUT_CSV_PATH.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for entry in entries:
            row = results_by_email.get(entry["email"].lower())
            if row:
                writer.writerow(_normalize_row(row))


def main():
    if not INPUT_PATH.exists():
        sys.exit(f"Input file not found: {INPUT_PATH}")
    if not ROCKETREACH_API_KEY:
        sys.exit("ROCKETREACH_API_KEY is empty. Paste your key into the constant.")

    entries = parse_entries(INPUT_PATH)
    print(f"Parsed {len(entries)} unique entries.")
    if not OPENAI_API_KEY:
        print(
            "NOTE: OPENAI_API_KEY is empty; name inference and candidate scoring "
            "will use simple heuristics instead of AI.",
            file=sys.stderr,
        )

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

    # Resume: load prior successes and skip them.
    store = ProgressStore(CACHE_PATH)
    store.load()
    results_by_email = {e["email"].lower(): store.get(e["email"]) for e in entries if store.has(e["email"])}
    pending = [e for e in entries if not store.has(e["email"])]
    if results_by_email:
        print(f"Resuming: {len(results_by_email)} already in cache, {len(pending)} to process.")

    completed = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(enrich_entry, e): e for e in pending}
        for future in as_completed(futures):
            row = future.result()
            results_by_email[row["input_email"].lower()] = row
            if row["match_source"] != "none":
                store.save_success(row)
            completed += 1
            if completed % CSV_FLUSH_EVERY == 0:
                write_csv(entries, results_by_email)

    write_csv(entries, results_by_email)

    elapsed = time.time() - started
    matched = sum(1 for r in results_by_email.values() if r and r.get("match_source") != "none")
    print(f"Done in {elapsed:.0f}s. Enriched {matched}/{len(entries)} rows "
          f"({len(pending)} processed this run). Output: {OUTPUT_CSV_PATH}")


if __name__ == "__main__":
    main()
