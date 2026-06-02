// Lead file importer. Supports two formats and converts both into the internal
// pipe-delimited text that `parseContacts` already understands:
//
//   Name | email | phone | City, State
//
// 1. Pipe TXT/CSV: lines already use "|" -> used as-is.
// 2. True CSV: comma-separated columns -> mapped (Name/Email/Phone/City/State)
//    and converted to the pipe format.

export function fileBaseName(name = "") {
  return name.replace(/\.[^.]+$/, "").trim() || "Imported";
}

// "pipe" if any non-empty line contains a "|", otherwise "csv".
export function detectFormat(text) {
  const lines = (text || "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.some((l) => l.includes("|"))) return "pipe";
  return "csv";
}

// Minimal RFC-4180-ish CSV parser (handles quotes, escaped quotes, CRLF).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = text || "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // ignore; handled by \n
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ""));
}

// Decides whether the first CSV row is a header (mostly non-numeric labels).
export function looksLikeHeader(cells = []) {
  if (cells.length === 0) return false;
  const hits = cells.filter((c) =>
    /name|email|mail|phone|number|mobile|cell|city|town|state|region|first|last/i.test(c)
  ).length;
  return hits >= 1;
}

const FIELD_PATTERNS = {
  name: /^(full\s*name|name|contact|customer)/i,
  firstName: /^(first\s*name|first|fname|given)/i,
  lastName: /^(last\s*name|last|lname|surname|family)/i,
  email: /(e-?mail|gmail)/i,
  phone: /(phone|number|mobile|cell|tel)/i,
  city: /(city|town)/i,
  state: /(state|region|province)/i,
};

// Auto-maps each field to a column index using the header labels (-1 = none).
export function guessMapping(headers = []) {
  const map = { name: -1, firstName: -1, lastName: -1, email: -1, phone: -1, city: -1, state: -1 };
  headers.forEach((h, i) => {
    for (const field of Object.keys(FIELD_PATTERNS)) {
      if (map[field] === -1 && FIELD_PATTERNS[field].test(h)) map[field] = i;
    }
  });
  return map;
}

const cell = (row, idx) => (idx >= 0 && idx < row.length ? (row[idx] || "").trim() : "");

// Converts CSV data rows + a column mapping into internal pipe-format lines.
export function csvToPipeText(rows, mapping) {
  return rows
    .map((row) => {
      let name = cell(row, mapping.name);
      if (!name) {
        name = [cell(row, mapping.firstName), cell(row, mapping.lastName)]
          .filter(Boolean)
          .join(" ");
      }
      if (!name) return null;
      const email = cell(row, mapping.email);
      const phone = cell(row, mapping.phone);
      const city = cell(row, mapping.city);
      const state = cell(row, mapping.state);
      const loc = [city, state].filter(Boolean).join(", ");
      return [name, email, phone, loc].filter(Boolean).join(" | ");
    })
    .filter(Boolean)
    .join("\n");
}

// Reads a File and returns its text content.
export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsText(file);
  });
}

// Produces a normalized import descriptor from raw file text.
//   { mode: "pipe", text }
//   { mode: "csv", headers, rows, mapping, hasHeader }
export function buildImport(text) {
  const mode = detectFormat(text);
  if (mode === "pipe") {
    return { mode: "pipe", text: (text || "").trim() };
  }
  const parsed = parseCsv(text);
  const hasHeader = parsed.length > 0 && looksLikeHeader(parsed[0]);
  const headers = hasHeader
    ? parsed[0]
    : (parsed[0] || []).map((_, i) => `Column ${i + 1}`);
  const rows = hasHeader ? parsed.slice(1) : parsed;
  const mapping = hasHeader
    ? guessMapping(headers)
    : { name: 0, firstName: -1, lastName: -1, email: 1, phone: 2, city: 3, state: 4 };
  return { mode: "csv", headers, rows, mapping, hasHeader };
}
