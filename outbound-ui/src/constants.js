export const STATUSES = [
  "Not called",
  "Called",
  "No answer",
  "Callback",
  "Do-not-call",
];

export const STATUS_CLASS = {
  "Not called": "status-notcalled",
  Called: "status-called",
  "No answer": "status-noanswer",
  Callback: "status-callback",
  "Do-not-call": "status-dnc",
};

export const DEFAULT_TEMPLATE = `Hi [first name], this is ___ calling from ___.

I work with folks around [city], [state] and wanted to reach out personally.
Did I catch you at an okay time?

(Calling [number] -- follow-up email: [email])`;

export const SAMPLE_CONTACTS = `Dustin Callahan | dustin.r.callahan@gmail.com | +1 209-968-5064 | +1 949-322-1244 | Stockton, CA
Bernie Chase | berniechase@gmail.com | +1 858-349-9108 | San Diego, CA
Dana Shaw | danashaw@gmail.com | +1 973-464-8335 | Newark, NJ`;
