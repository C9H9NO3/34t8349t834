"""Look up the legal corporate name behind each email's domain.

Reads a list of `email,[Name,]phone` lines, visits each email domain's
website, and uses OpenAI to extract the registered legal entity name
(e.g. "Symbolic London Ltd", not the brand / DBA). Writes a new TXT
where every original line gets the company name appended as a final
comma field (blank when nothing could be found).

Everything is hard-coded below: no command-line arguments.
"""

import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

# --------------------------------------------------------------------------- #
# Configuration (edit these)                                                   #
# --------------------------------------------------------------------------- #
HERE = Path(__file__).resolve().parent

INPUT_PATH = HERE / "New Text Document.txt"
OUTPUT_PATH = HERE / "emails_with_companies.txt"

# Paste your OpenAI API key here. If left blank, the script still runs but
# writes a blank company name for every entry.
OPENAI_API_KEY = ""
OPENAI_MODEL = "gpt-4o-mini"

REQUEST_TIMEOUT = 12  # seconds per HTTP request
MAX_WORKERS = 8       # parallel domain lookups
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# Pages most likely to mention the registered legal entity.
LEGAL_PATHS = [
    "",  # homepage
    "/about",
    "/about-us",
    "/legal",
    "/terms",
    "/terms-of-service",
    "/terms-and-conditions",
    "/privacy",
    "/privacy-policy",
]

# How much page text to hand to the model (characters).
MAX_TEXT_CHARS = 12000


# --------------------------------------------------------------------------- #
# Parsing the input file                                                       #
# --------------------------------------------------------------------------- #
EMAIL_RE = re.compile(r"[^\s,]+@[^\s,]+\.[^\s,]+")
URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def clean_line(raw):
    """Strip markdown strikethrough and trailing inline notes from a line."""
    line = raw.strip()
    # Drop markdown strikethrough markers (~~...~~) but keep the inner text.
    line = line.replace("~~", "")
    # Remove trailing notes such as "- call screen", "- vm", "-vm".
    line = re.sub(r"\s*-\s*(call screen|calll screen|vm)\s*$", "", line, flags=re.IGNORECASE)
    # A note may also be glued to the phone like "8186254635-vm".
    line = re.sub(r"-\s*(call screen|calll screen|vm)\b", "", line, flags=re.IGNORECASE)
    return line.strip()


def parse_entries(path):
    """Return a list of dicts: {email, domain, line} deduped by email."""
    entries = []
    seen = set()

    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = clean_line(raw)
        if not line:
            continue
        if URL_RE.match(line):
            continue

        match = EMAIL_RE.search(line)
        if not match:
            continue

        email = match.group(0).rstrip(".,;").strip()
        key = email.lower()
        if key in seen:
            continue
        seen.add(key)

        domain = email.split("@", 1)[1].lower()
        entries.append({"email": email, "domain": domain, "line": line})

    return entries


# --------------------------------------------------------------------------- #
# Fetching website content                                                     #
# --------------------------------------------------------------------------- #
def _get(session, url):
    try:
        resp = session.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        if resp.status_code == 200 and resp.text:
            return resp.text
    except requests.RequestException:
        return None
    return None


def fetch_base_html(session, domain):
    """Try a few URL variants and return (base_url, homepage_html)."""
    for candidate in (
        f"https://www.{domain}",
        f"https://{domain}",
        f"http://www.{domain}",
        f"http://{domain}",
    ):
        html = _get(session, candidate)
        if html:
            return candidate, html
    return None, None


def extract_signal_text(html):
    """Pull high-signal snippets that tend to hold the legal entity name."""
    soup = BeautifulSoup(html, "html.parser")
    snippets = []

    # JSON-LD blocks (schema.org Organization legalName is the best signal).
    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.string or script.get_text() or ""
        raw = raw.strip()
        if raw:
            snippets.append("JSON-LD: " + raw[:2000])

    # Meta tags that sometimes carry the org name.
    for meta in soup.find_all("meta"):
        prop = (meta.get("property") or meta.get("name") or "").lower()
        if prop in ("og:site_name", "application-name", "author", "publisher"):
            content = meta.get("content")
            if content:
                snippets.append(f"META {prop}: {content.strip()}")

    # Footer text, which usually contains the copyright / legal entity.
    for footer in soup.find_all("footer"):
        text = footer.get_text(" ", strip=True)
        if text:
            snippets.append("FOOTER: " + text[:1500])

    # Any line mentioning copyright anywhere in the document.
    full_text = soup.get_text("\n", strip=True)
    for raw_line in full_text.splitlines():
        if "©" in raw_line or re.search(r"\bcopyright\b", raw_line, re.IGNORECASE):
            snippets.append("COPYRIGHT: " + raw_line.strip()[:400])

    snippets.append("PAGE TEXT: " + full_text)
    return "\n".join(snippets)


def collect_domain_text(session, domain):
    """Fetch homepage + a few legal pages and return combined signal text."""
    base_url, home_html = fetch_base_html(session, domain)
    if not home_html:
        return None

    chunks = [extract_signal_text(home_html)]

    for path in LEGAL_PATHS[1:]:
        page_url = urljoin(base_url + "/", path.lstrip("/"))
        html = _get(session, page_url)
        if html:
            chunks.append(extract_signal_text(html))
        # Stop early once we have plenty of text to keep token cost sane.
        if sum(len(c) for c in chunks) > MAX_TEXT_CHARS * 2:
            break

    combined = "\n\n".join(chunks)
    return combined[:MAX_TEXT_CHARS]


# --------------------------------------------------------------------------- #
# OpenAI extraction                                                            #
# --------------------------------------------------------------------------- #
_openai_client = None


def get_openai_client():
    global _openai_client
    if _openai_client is None:
        from openai import OpenAI

        _openai_client = OpenAI(api_key=OPENAI_API_KEY)
    return _openai_client


SYSTEM_PROMPT = (
    "You extract the official registered legal entity name of the company that "
    "owns a website, given scraped text from that site. The legal entity name "
    "is the corporation/LLC name as legally registered, typically ending in a "
    "suffix such as Inc, Inc., LLC, L.L.C., Ltd, Ltd., Limited, Corp, Corp., "
    "Corporation, Co., Company, LP, LLP, PLLC, PC, GmbH, AG, S.A., Pty Ltd, etc. "
    "Prefer the full legal entity over the brand / 'doing business as' (DBA) "
    "name. Look especially at copyright lines, footers, terms of service, "
    "privacy policies, and schema.org legalName fields. "
    "Respond with ONLY the legal entity name and nothing else. "
    "If the text does not clearly contain a registered legal entity name, "
    "respond with exactly: NONE"
)


def extract_company_name(domain, text):
    """Ask OpenAI for the legal entity name. Returns a string or ''."""
    if not OPENAI_API_KEY:
        return ""
    if not text:
        return ""

    user_prompt = (
        f"Website domain: {domain}\n\n"
        f"Scraped site text:\n{text}\n\n"
        "What is the official registered legal entity name? "
        "Reply with only the name, or NONE."
    )

    try:
        client = get_openai_client()
        resp = client.chat.completions.create(
            model=OPENAI_MODEL,
            temperature=0,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        )
        answer = (resp.choices[0].message.content or "").strip()
    except Exception as exc:  # noqa: BLE001 - never let one call kill the run
        print(f"  [openai error for {domain}] {exc}", file=sys.stderr)
        return ""

    return clean_company_answer(answer)


def clean_company_answer(answer):
    answer = answer.strip().strip('"').strip("'").strip()
    if not answer:
        return ""
    if answer.upper() == "NONE":
        return ""
    # Guard against a model that wraps the answer in a sentence.
    if "\n" in answer:
        answer = answer.splitlines()[0].strip()
    return answer


# --------------------------------------------------------------------------- #
# Per-domain worker                                                            #
# --------------------------------------------------------------------------- #
def resolve_company(domain):
    """Full pipeline for one domain. Returns the company name or ''."""
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    try:
        text = collect_domain_text(session, domain)
        if not text:
            print(f"  [{domain}] site unreachable")
            return ""
        company = extract_company_name(domain, text)
        print(f"  [{domain}] -> {company or '(none)'}")
        return company
    except Exception as exc:  # noqa: BLE001
        print(f"  [{domain}] error: {exc}", file=sys.stderr)
        return ""
    finally:
        session.close()


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #
def main():
    if not INPUT_PATH.exists():
        sys.exit(f"Input file not found: {INPUT_PATH}")

    entries = parse_entries(INPUT_PATH)
    print(f"Parsed {len(entries)} unique entries.")

    if not OPENAI_API_KEY:
        print(
            "WARNING: OPENAI_API_KEY is empty. Company names will be blank. "
            "Paste your key into the OPENAI_API_KEY constant to enable lookups.",
            file=sys.stderr,
        )

    unique_domains = sorted({e["domain"] for e in entries})
    print(f"Looking up {len(unique_domains)} unique domains...")

    domain_to_company = {}
    started = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(resolve_company, d): d for d in unique_domains}
        for future in as_completed(futures):
            domain = futures[future]
            domain_to_company[domain] = future.result()

    elapsed = time.time() - started
    found = sum(1 for v in domain_to_company.values() if v)
    print(f"Done in {elapsed:.0f}s. Found {found}/{len(unique_domains)} legal names.")

    lines_out = []
    for entry in entries:
        company = domain_to_company.get(entry["domain"], "")
        lines_out.append(f"{entry['line']},{company}")

    OUTPUT_PATH.write_text("\n".join(lines_out) + "\n", encoding="utf-8")
    print(f"Wrote {len(lines_out)} lines to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
