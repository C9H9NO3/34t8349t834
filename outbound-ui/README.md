# Outbound Reach Helper

A tiny local dashboard for cold-calling through a list. Paste your
`gmail_contacts`-style data, write a call script with `[variables]`, and it
generates one filled script per phone number with status / call-time / notes
tracking. Everything is saved in your browser (localStorage).

## Run

```bash
cd outbound-ui
npm install
npm run dev
```

Then open the printed `http://localhost:5173` URL.

## How to use

1. **Contacts**: paste lines in the format produced by `format_contacts.py`:

   ```
   Full Name | gmail1, gmail2 | +1 209-968-5064 | +1 949-322-1244 | Stockton, CA
   ```

   The parser auto-detects emails (`@`), phone numbers, and the `City, State`.

2. **Script template**: write your pitch once using square-bracket variables.
   Supported tokens (case-insensitive):

   - `[first name]`, `[last name]`, `[full name]` / `[name]`
   - `[email]`
   - `[number]` / `[phone]` - the specific number for that card
   - `[city]`, `[state]`, `[location]`

   Detected variables show as chips; unknown ones are flagged red and left
   untouched in the output.

3. **Call cards**: one card is generated per phone number (so a contact with two
   numbers gets two scripts). Each card has:
   - a `tel:` link to dial and a `mailto:` link,
   - a Copy button for the filled script,
   - a status dropdown (Not called / Called / No answer / Callback / Do-not-call),
   - an automatic call-time stamp (set when you mark it Called; editable),
   - a notes box.

4. **Track progress** with the stats bar (called / remaining + per-status
   counts), the search box (by name), and the status filter chips.

All input and tracking persist locally, so you can close the tab and pick up
where you left off. Clearing browser storage resets it.
