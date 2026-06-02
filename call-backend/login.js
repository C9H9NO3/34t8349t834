// Optional CLI login helper. Normally you add/log in accounts from the
// dashboard's Call Automation tab, but this opens a browser for the active
// account (creating a default one if none exist) so you can log in manually.
// Leave running until logged in, then press Ctrl+C.

import * as gv from "./playwrightController.js";
import * as accounts from "./accounts.js";

let id = accounts.getActiveId();
if (!id) {
  const created = accounts.add({ label: "Default", phoneNumber: "", note: "" });
  id = created.id;
  console.log(`Created default account ${id}`);
}

const r = await gv.login(id);
console.log(r.message);
console.log("Logged in already?", r.loggedIn);
console.log("Window is open. Finish logging in, then press Ctrl+C here.");

setInterval(() => {}, 1 << 30);
