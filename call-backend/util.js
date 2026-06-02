// Small shared helpers for the backend.

// Strips a phone number down to digits for stable comparison/keys.
export function digits(s) {
  return String(s || "").replace(/\D/g, "");
}
