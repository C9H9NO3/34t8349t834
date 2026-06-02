// Curated US states -> high-availability cities for NodeMaven residential
// geo-targeting. NodeMaven expects region/city lowercased with spaces as
// underscores; randomLocation() returns values already in that form plus a
// human-readable label for the dashboard.

const US_STATES = {
  alabama: ["birmingham", "montgomery", "huntsville"],
  arizona: ["phoenix", "tucson", "mesa"],
  california: ["los_angeles", "san_francisco", "san_diego", "sacramento"],
  colorado: ["denver", "colorado_springs", "aurora"],
  connecticut: ["bridgeport", "new_haven", "hartford"],
  florida: ["miami", "orlando", "tampa", "jacksonville"],
  georgia: ["atlanta", "augusta", "savannah"],
  illinois: ["chicago", "aurora", "naperville"],
  indiana: ["indianapolis", "fort_wayne", "evansville"],
  kentucky: ["louisville", "lexington", "bowling_green"],
  louisiana: ["new_orleans", "baton_rouge", "shreveport"],
  maryland: ["baltimore", "columbia", "germantown"],
  massachusetts: ["boston", "worcester", "springfield"],
  michigan: ["detroit", "grand_rapids", "ann_arbor"],
  minnesota: ["minneapolis", "saint_paul", "rochester"],
  missouri: ["kansas_city", "saint_louis", "springfield"],
  nevada: ["las_vegas", "henderson", "reno"],
  new_jersey: ["newark", "jersey_city", "trenton"],
  new_york: ["new_york", "brooklyn", "buffalo", "rochester"],
  north_carolina: ["charlotte", "raleigh", "greensboro"],
  ohio: ["columbus", "cleveland", "cincinnati"],
  oregon: ["portland", "salem", "eugene"],
  pennsylvania: ["philadelphia", "pittsburgh", "allentown"],
  tennessee: ["nashville", "memphis", "knoxville"],
  texas: ["houston", "dallas", "austin", "san_antonio"],
  virginia: ["virginia_beach", "richmond", "norfolk"],
  washington: ["seattle", "spokane", "tacoma"],
  wisconsin: ["milwaukee", "madison", "green_bay"],
};

const STATE_KEYS = Object.keys(US_STATES);

function pretty(s) {
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Returns { region, city, label } where region/city are NodeMaven-formatted
// and label is human-readable (e.g. "Brooklyn, New York").
export function randomLocation() {
  const region = STATE_KEYS[Math.floor(Math.random() * STATE_KEYS.length)];
  const cities = US_STATES[region];
  const city = cities[Math.floor(Math.random() * cities.length)];
  return { region, city, label: `${pretty(city)}, ${pretty(region)}` };
}

export function locationLabel(region, city) {
  if (!region) return "";
  return city ? `${pretty(city)}, ${pretty(region)}` : pretty(region);
}

// Full list of selectable locations for the dashboard dropdowns:
// [{ region, label, cities: [{ city, label }] }] sorted by state name.
export function listLocations() {
  return STATE_KEYS.map((region) => ({
    region,
    label: pretty(region),
    cities: US_STATES[region].map((city) => ({ city, label: pretty(city) })),
  })).sort((a, b) => a.label.localeCompare(b.label));
}

// Validates a region (and optional city) against the curated list.
export function isValidLocation(region, city) {
  if (!region || !US_STATES[region]) return false;
  if (city && !US_STATES[region].includes(city)) return false;
  return true;
}
