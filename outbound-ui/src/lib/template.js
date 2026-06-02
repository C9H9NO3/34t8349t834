// Detects [square-bracket] variables in a script template and fills them from a
// contact + the specific number for a call card.

const BRACKET_RE = /\[([^\]]+)\]/g;

// Maps a normalized token (lowercased, trimmed) to a resolver.
function valueForToken(token, contact, number) {
  const t = token.trim().toLowerCase();
  switch (t) {
    case "first name":
    case "firstname":
    case "first":
      return contact.firstName;
    case "last name":
    case "lastname":
    case "last":
      return contact.lastName;
    case "full name":
    case "fullname":
    case "name":
      return contact.fullName;
    case "email":
    case "gmail":
      return contact.emails[0] || "";
    case "emails":
      return contact.emails.join(", ");
    case "number":
    case "phone":
    case "phone number":
    case "cell":
      return number || contact.numbers[0] || "";
    case "numbers":
      return contact.numbers.join(", ");
    case "city":
      return contact.city;
    case "state":
      return contact.state;
    case "location":
      return contact.location;
    default:
      return null; // unknown token
  }
}

export const KNOWN_TOKENS = [
  "first name",
  "last name",
  "full name",
  "email",
  "number",
  "city",
  "state",
  "location",
];

// Returns the unique set of tokens used in a template.
export function detectVariables(template) {
  const found = new Set();
  let match;
  BRACKET_RE.lastIndex = 0;
  while ((match = BRACKET_RE.exec(template || "")) !== null) {
    found.add(match[1].trim());
  }
  return [...found];
}

// Returns tokens in the template that we don't know how to fill.
export function unknownVariables(template) {
  return detectVariables(template).filter(
    (tok) => valueForToken(tok, EMPTY_CONTACT, "") === null
  );
}

const EMPTY_CONTACT = {
  firstName: "",
  lastName: "",
  fullName: "",
  emails: [],
  numbers: [],
  city: "",
  state: "",
  location: "",
};

// Fills a template for a given contact + number. Unknown tokens are left as-is.
export function fillTemplate(template, contact, number) {
  return (template || "").replace(BRACKET_RE, (whole, token) => {
    const value = valueForToken(token, contact, number);
    return value === null ? whole : value;
  });
}
