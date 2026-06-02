// Parses gmail_contacts-style lines into structured contacts.
//
// Each line looks like:
//   Full Name | gmail1, gmail2 | number1 | number2 | City, State
// Fields are separated by " | ". After the name, each field is classified:
//   - contains "@"            -> email(s)
//   - looks like a phone      -> number
//   - otherwise               -> "City, State" location

const PHONE_CHARS = /^[+()\d][\d\s().+-]*$/;

function looksLikePhone(field) {
  if (!PHONE_CHARS.test(field.trim())) return false;
  const digits = field.replace(/\D/g, "");
  return digits.length >= 7;
}

function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function parseLocation(field) {
  const [city, state] = field.split(",").map((s) => s.trim());
  return { city: city || "", state: state || "", location: field.trim() };
}

export function parseContactLine(line) {
  const raw = line.trim();
  if (!raw) return null;

  const fields = raw.split("|").map((f) => f.trim());
  const fullName = fields[0] || "";
  if (!fullName) return null;

  const emails = [];
  const numbers = [];
  let location = { city: "", state: "", location: "" };

  fields.slice(1).forEach((field) => {
    if (!field) return;
    if (field.includes("@")) {
      field.split(",").forEach((addr) => {
        const a = addr.trim();
        if (a) emails.push(a);
      });
    } else if (looksLikePhone(field)) {
      numbers.push(field.trim());
    } else {
      location = parseLocation(field);
    }
  });

  const { firstName, lastName } = splitName(fullName);

  return {
    fullName,
    firstName,
    lastName,
    emails,
    numbers,
    city: location.city,
    state: location.state,
    location: location.location,
  };
}

export function parseContacts(text) {
  const contacts = [];
  (text || "").split(/\r?\n/).forEach((line) => {
    const contact = parseContactLine(line);
    if (contact) contacts.push(contact);
  });
  return contacts;
}
