"""Format successful enrichments into a simple gmail-only contact list.

Reads the enrichment results (prefers the success-only cache `enrich_cache.jsonl`,
falls back to `emails_enriched.csv`) and writes one line per person:

    Full Name | gmail1, gmail2 | number1 | number2

Rules:
  - Only successful enrichments are included.
  - Only @gmail.com addresses are shown; if a person has no gmail, the line is
    skipped entirely.
  - Phone numbers are each separated by " | ".

Everything is hard-coded: no command-line arguments.
"""

import csv
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent

CACHE_PATH = HERE / "enrich_cache.jsonl"
CSV_PATH = HERE / "emails_enriched.csv"
OUTPUT_PATH = HERE / "gmail_contacts.txt"

# Only keep personal phone types. Everything else (landline, professional/work,
# fax, voip, and unverified "unknown") is treated as business/non-personal and
# dropped. Add "unknown" here if you want broader (but less certain) coverage.
ALLOWED_PHONE_TYPES = {"mobile", "home"}

# Area code (first 3 digits of a North American number) -> "City, State".
# Used to append an approximate location to each contact line.
AREA_CODES = {
    "201": "Jersey City, NJ", "202": "Washington, DC", "203": "New Haven, CT",
    "205": "Birmingham, AL", "206": "Seattle, WA", "207": "Portland, ME",
    "208": "Boise, ID", "209": "Stockton, CA", "210": "San Antonio, TX",
    "212": "New York, NY", "213": "Los Angeles, CA", "214": "Dallas, TX",
    "215": "Philadelphia, PA", "216": "Cleveland, OH", "217": "Springfield, IL",
    "218": "Duluth, MN", "219": "Gary, IN", "220": "Newark, OH",
    "223": "Harrisburg, PA", "224": "Evanston, IL", "225": "Baton Rouge, LA",
    "228": "Biloxi, MS", "229": "Albany, GA", "231": "Muskegon, MI",
    "234": "Akron, OH", "239": "Cape Coral, FL", "240": "Rockville, MD",
    "248": "Troy, MI", "251": "Mobile, AL", "252": "Greenville, NC",
    "253": "Tacoma, WA", "254": "Killeen, TX", "256": "Huntsville, AL",
    "260": "Fort Wayne, IN", "262": "Kenosha, WI", "267": "Philadelphia, PA",
    "269": "Kalamazoo, MI", "270": "Bowling Green, KY", "272": "Scranton, PA",
    "276": "Bristol, VA", "281": "Houston, TX", "301": "Rockville, MD",
    "302": "Wilmington, DE", "303": "Denver, CO", "304": "Charleston, WV",
    "305": "Miami, FL", "307": "Cheyenne, WY", "308": "Grand Island, NE",
    "309": "Peoria, IL", "310": "Los Angeles, CA", "312": "Chicago, IL",
    "313": "Detroit, MI", "314": "St. Louis, MO", "315": "Syracuse, NY",
    "316": "Wichita, KS", "317": "Indianapolis, IN", "318": "Shreveport, LA",
    "319": "Cedar Rapids, IA", "320": "St. Cloud, MN", "321": "Orlando, FL",
    "323": "Los Angeles, CA", "325": "Abilene, TX", "330": "Akron, OH",
    "331": "Aurora, IL", "334": "Montgomery, AL", "336": "Greensboro, NC",
    "337": "Lafayette, LA", "339": "Boston, MA", "340": "Charlotte Amalie, VI",
    "346": "Houston, TX", "347": "New York, NY", "351": "Lowell, MA",
    "352": "Gainesville, FL", "360": "Vancouver, WA", "361": "Corpus Christi, TX",
    "364": "Bowling Green, KY", "380": "Columbus, OH", "385": "Salt Lake City, UT",
    "386": "Daytona Beach, FL", "401": "Providence, RI", "402": "Omaha, NE",
    "404": "Atlanta, GA", "405": "Oklahoma City, OK", "406": "Billings, MT",
    "407": "Orlando, FL", "408": "San Jose, CA", "409": "Beaumont, TX",
    "410": "Baltimore, MD", "412": "Pittsburgh, PA", "413": "Springfield, MA",
    "414": "Milwaukee, WI", "415": "San Francisco, CA", "417": "Springfield, MO",
    "419": "Toledo, OH", "423": "Chattanooga, TN", "424": "Los Angeles, CA",
    "425": "Bellevue, WA", "430": "Tyler, TX", "432": "Midland, TX",
    "434": "Lynchburg, VA", "435": "St. George, UT", "440": "Parma, OH",
    "442": "Oceanside, CA", "443": "Baltimore, MD", "458": "Eugene, OR",
    "463": "Indianapolis, IN", "469": "Dallas, TX", "470": "Atlanta, GA",
    "475": "New Haven, CT", "478": "Macon, GA", "479": "Fort Smith, AR",
    "480": "Mesa, AZ", "484": "Allentown, PA", "501": "Little Rock, AR",
    "502": "Louisville, KY", "503": "Portland, OR", "504": "New Orleans, LA",
    "505": "Albuquerque, NM", "507": "Rochester, MN", "508": "Worcester, MA",
    "509": "Spokane, WA", "510": "Oakland, CA", "512": "Austin, TX",
    "513": "Cincinnati, OH", "515": "Des Moines, IA", "516": "Hempstead, NY",
    "517": "Lansing, MI", "518": "Albany, NY", "520": "Tucson, AZ",
    "530": "Redding, CA", "531": "Omaha, NE", "539": "Tulsa, OK",
    "540": "Roanoke, VA", "541": "Eugene, OR", "551": "Jersey City, NJ",
    "559": "Fresno, CA", "561": "West Palm Beach, FL", "562": "Long Beach, CA",
    "563": "Davenport, IA", "567": "Toledo, OH", "570": "Scranton, PA",
    "571": "Arlington, VA", "573": "Columbia, MO", "574": "South Bend, IN",
    "575": "Las Cruces, NM", "580": "Lawton, OK", "585": "Rochester, NY",
    "586": "Warren, MI", "601": "Jackson, MS", "602": "Phoenix, AZ",
    "603": "Manchester, NH", "605": "Sioux Falls, SD", "606": "Ashland, KY",
    "607": "Binghamton, NY", "608": "Madison, WI", "609": "Trenton, NJ",
    "610": "Allentown, PA", "612": "Minneapolis, MN", "614": "Columbus, OH",
    "615": "Nashville, TN", "616": "Grand Rapids, MI", "617": "Boston, MA",
    "618": "Belleville, IL", "619": "San Diego, CA", "620": "Dodge City, KS",
    "623": "Glendale, AZ", "626": "Pasadena, CA", "628": "San Francisco, CA",
    "629": "Nashville, TN", "630": "Aurora, IL", "631": "Long Island, NY",
    "636": "O'Fallon, MO", "641": "Mason City, IA", "646": "New York, NY",
    "650": "San Mateo, CA", "651": "St. Paul, MN", "657": "Anaheim, CA",
    "660": "Sedalia, MO", "661": "Bakersfield, CA", "662": "Tupelo, MS",
    "667": "Baltimore, MD", "669": "San Jose, CA", "678": "Atlanta, GA",
    "681": "Charleston, WV", "682": "Fort Worth, TX", "701": "Fargo, ND",
    "702": "Las Vegas, NV", "703": "Arlington, VA", "704": "Charlotte, NC",
    "706": "Augusta, GA", "707": "Santa Rosa, CA", "708": "Cicero, IL",
    "712": "Sioux City, IA", "713": "Houston, TX", "714": "Anaheim, CA",
    "715": "Eau Claire, WI", "716": "Buffalo, NY", "717": "Harrisburg, PA",
    "718": "New York, NY", "719": "Colorado Springs, CO", "720": "Denver, CO",
    "724": "New Castle, PA", "725": "Las Vegas, NV", "727": "St. Petersburg, FL",
    "731": "Jackson, TN", "732": "New Brunswick, NJ", "734": "Ann Arbor, MI",
    "737": "Austin, TX", "740": "Newark, OH", "743": "Greensboro, NC",
    "747": "Burbank, CA", "754": "Fort Lauderdale, FL", "757": "Norfolk, VA",
    "760": "Oceanside, CA", "762": "Augusta, GA", "763": "Brooklyn Park, MN",
    "765": "Muncie, IN", "769": "Jackson, MS", "770": "Atlanta, GA",
    "772": "Port St. Lucie, FL", "773": "Chicago, IL", "774": "Worcester, MA",
    "775": "Reno, NV", "779": "Rockford, IL", "781": "Boston, MA",
    "785": "Topeka, KS", "786": "Miami, FL", "801": "Salt Lake City, UT",
    "802": "Burlington, VT", "803": "Columbia, SC", "804": "Richmond, VA",
    "805": "Santa Barbara, CA", "806": "Lubbock, TX", "808": "Honolulu, HI",
    "810": "Flint, MI", "812": "Evansville, IN", "813": "Tampa, FL",
    "814": "Erie, PA", "815": "Rockford, IL", "816": "Kansas City, MO",
    "817": "Fort Worth, TX", "818": "Burbank, CA", "828": "Asheville, NC",
    "830": "New Braunfels, TX", "831": "Salinas, CA", "832": "Houston, TX",
    "843": "Charleston, SC", "845": "Poughkeepsie, NY", "847": "Schaumburg, IL",
    "848": "New Brunswick, NJ", "850": "Tallahassee, FL", "856": "Camden, NJ",
    "857": "Boston, MA", "858": "San Diego, CA", "859": "Lexington, KY",
    "860": "Hartford, CT", "862": "Newark, NJ", "863": "Lakeland, FL",
    "864": "Greenville, SC", "865": "Knoxville, TN", "870": "Jonesboro, AR",
    "872": "Chicago, IL", "878": "Pittsburgh, PA", "901": "Memphis, TN",
    "903": "Tyler, TX", "904": "Jacksonville, FL", "906": "Marquette, MI",
    "907": "Anchorage, AK", "908": "Elizabeth, NJ", "909": "San Bernardino, CA",
    "910": "Fayetteville, NC", "912": "Savannah, GA", "913": "Overland Park, KS",
    "914": "Yonkers, NY", "915": "El Paso, TX", "916": "Sacramento, CA",
    "917": "New York, NY", "918": "Tulsa, OK", "919": "Raleigh, NC",
    "920": "Green Bay, WI", "925": "Concord, CA", "928": "Yuma, AZ",
    "929": "New York, NY", "930": "Evansville, IN", "931": "Clarksville, TN",
    "934": "Long Island, NY", "936": "Conroe, TX", "937": "Dayton, OH",
    "938": "Huntsville, AL", "940": "Denton, TX", "941": "Sarasota, FL",
    "947": "Troy, MI", "949": "Irvine, CA", "951": "Riverside, CA",
    "952": "Bloomington, MN", "954": "Fort Lauderdale, FL", "956": "Laredo, TX",
    "959": "Hartford, CT", "970": "Fort Collins, CO", "971": "Portland, OR",
    "972": "Dallas, TX", "973": "Newark, NJ", "978": "Lowell, MA",
    "979": "College Station, TX", "980": "Charlotte, NC", "984": "Raleigh, NC",
    "985": "Houma, LA", "989": "Saginaw, MI",
    # Common Canadian codes (data is US-centric, included for completeness).
    "204": "Winnipeg, MB", "226": "London, ON", "236": "Vancouver, BC",
    "250": "Victoria, BC", "289": "Mississauga, ON", "306": "Regina, SK",
    "343": "Ottawa, ON", "365": "Mississauga, ON", "403": "Calgary, AB",
    "416": "Toronto, ON", "418": "Quebec City, QC", "431": "Winnipeg, MB",
    "437": "Toronto, ON", "438": "Montreal, QC", "450": "Laval, QC",
    "506": "Moncton, NB", "514": "Montreal, QC", "519": "London, ON",
    "579": "Gatineau, QC", "581": "Quebec City, QC", "587": "Calgary, AB",
    "604": "Vancouver, BC", "613": "Ottawa, ON", "647": "Toronto, ON",
    "705": "Sudbury, ON", "709": "St. John's, NL", "778": "Vancouver, BC",
    "807": "Thunder Bay, ON", "819": "Gatineau, QC", "825": "Calgary, AB",
    "902": "Halifax, NS", "905": "Mississauga, ON",
}


def area_code(number):
    """Return the 3-digit North American area code for a phone number, or ''."""
    digits = re.sub(r"\D", "", number or "")
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits[:3] if len(digits) >= 10 else ""


def location_for(numbers):
    """First known "City, State" among the numbers (by area code), or ''."""
    for number in numbers:
        loc = AREA_CODES.get(area_code(number))
        if loc:
            return loc
    return ""


def load_rows():
    """Return a list of result-row dicts (successes only)."""
    rows = []
    if CACHE_PATH.exists():
        for line in CACHE_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
        if rows:
            return rows

    if CSV_PATH.exists():
        with CSV_PATH.open(encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                if (row.get("match_source") or "none") != "none":
                    rows.append(row)
    return rows


def extract_gmails(row):
    """All unique @gmail.com addresses for a row, in first-seen order."""
    found = []
    seen = set()

    def add(addr):
        addr = (addr or "").strip().lower()
        if addr.endswith("@gmail.com") and addr not in seen:
            seen.add(addr)
            found.append(addr)

    add(row.get("recommended_personal_email"))
    add(row.get("current_personal_email"))
    for chunk in (row.get("emails") or "").split(";"):
        addr = chunk.split("|", 1)[0].strip()
        add(addr)
    return found


def extract_numbers(row):
    """Personal-only phone numbers for a row, deduped by their last 10 digits.

    Only numbers whose RocketReach type is in ALLOWED_PHONE_TYPES (mobile/home)
    are kept; landline, professional, fax, and unverified "unknown" are dropped.
    """
    numbers = []
    seen = set()

    for chunk in (row.get("phones") or "").split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = [p.strip() for p in chunk.split("|")]
        number = parts[0]
        ptype = parts[1].lower() if len(parts) > 1 else ""
        if ptype not in ALLOWED_PHONE_TYPES:
            continue
        digits = re.sub(r"\D", "", number)
        if not digits:
            continue
        key = digits[-10:]
        if key in seen:
            continue
        seen.add(key)
        numbers.append(number)
    return numbers


def person_name(row):
    return (row.get("person_name") or row.get("input_name") or "").strip()


def main():
    rows = load_rows()
    lines = []
    for row in rows:
        gmails = extract_gmails(row)
        if not gmails:
            continue  # no gmail -> skip the line entirely
        name = person_name(row)
        numbers = extract_numbers(row)
        fields = [name, ", ".join(gmails)] + numbers
        location = location_for(numbers)
        if location:
            fields.append(location)
        lines.append(" | ".join(fields))

    OUTPUT_PATH.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    print(f"Read {len(rows)} successful rows; wrote {len(lines)} gmail contacts to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
