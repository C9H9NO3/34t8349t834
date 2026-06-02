// Campaign dispatcher: distributes a queue of leads across multiple logged-in
// Google Voice sessions running in parallel. Each worker (one per session)
// pulls the next queued lead, runs it, records the outcome, and pulls again
// until the queue drains or the campaign is stopped.
//
// The dispatcher is GV-agnostic: the caller injects `runWorker(workerId, lead)`
// which returns an outcome `{ category, reason }`. Instant declines
// (`category: "declined"`) are requeued up to `declineRetries` times (some
// phones are on Do-Not-Disturb and drop the first ring).

import { digits } from "./util.js";
import { canonicalCategory } from "./outcomes.js";

// Internal runFlow categories that are terminal (vs "declined" which retries
// once, and "cancelled" which requeues). Tallying/marking uses the CANONICAL
// category derived from (category, reason, via) so progress matches callHistory.
const FINAL = new Set(["uncallable", "no_pickup", "picked_up"]);

// The 5 canonical buckets surfaced to the UI (plus live queued/calling).
const CANON = ["schedule_callback", "pickup_silent", "auto_decline", "no_answer", "uncallable"];

export class CampaignManager {
  constructor({ declineRetries = 1, onLead, onProgress, log } = {}) {
    this.declineRetries = declineRetries;
    this.onLead = onLead || (() => {});
    this.onProgress = onProgress || (() => {});
    this.log = log || (() => {});
    this.reset();
  }

  reset() {
    this.queue = []; // [{ number, name, email, status, attempts, category, reason }]
    this.byNumber = new Map();
    this.running = false;
    this.workers = 0;
    this.activeWorkers = 0;
    this.runWorker = null;
  }

  isRunning() {
    return this.running;
  }

  counts() {
    const c = { queued: 0, calling: 0 };
    for (const k of CANON) c[k] = 0;
    for (const l of this.queue) {
      if (l.status === "done") {
        const canon = canonicalCategory(l.category, l.reason, l.via);
        c[canon] = (c[canon] || 0) + 1;
      } else if (l.status === "calling") c.calling++;
      else c.queued++;
    }
    return c;
  }

  progress() {
    const counts = this.counts();
    const done = CANON.reduce((sum, k) => sum + (counts[k] || 0), 0);
    return {
      running: this.running,
      total: this.queue.length,
      done,
      inFlight: counts.calling,
      counts,
    };
  }

  emitProgress() {
    this.onProgress(this.progress());
  }

  emitLead(lead) {
    this.onLead({
      number: lead.number,
      name: lead.name,
      status: lead.status,
      category: lead.category || null,
      reason: lead.reason || null,
      via: lead.via || null,
      attempts: lead.attempts,
    });
  }

  // Starts the campaign. workerIds = logged-in session ids; runWorker =
  // async (workerId, lead) => { category, reason }.
  start({ leads, workerIds, runWorker }) {
    if (this.running) throw new Error("a campaign is already running");
    if (!Array.isArray(workerIds) || workerIds.length === 0) {
      throw new Error("no logged-in accounts available to run the campaign");
    }
    this.reset();
    this.running = true;
    this.runWorker = runWorker;
    this.queue = (leads || [])
      .map((l) => ({
        number: l.number,
        name: l.name || "",
        email: l.email || "",
        status: "queued",
        attempts: 0,
        category: null,
        reason: null,
        via: null,
      }))
      .filter((l) => l.number);
    for (const l of this.queue) this.byNumber.set(digits(l.number), l);

    this.workers = workerIds.length;
    this.activeWorkers = workerIds.length;
    this.log(
      `Campaign started: ${this.queue.length} numbers across ${workerIds.length} account(s).`
    );
    this.emitProgress();
    for (const id of workerIds) this._workerLoop(id);
    return this.progress();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    for (const l of this.queue) {
      if (l.status === "queued") {
        l.status = "stopped";
        this.emitLead(l);
      }
    }
    this.log("Campaign stopped.");
    this.emitProgress();
  }

  _nextLead() {
    if (!this.running) return null;
    return this.queue.find((l) => l.status === "queued") || null;
  }

  async _workerLoop(workerId) {
    while (this.running) {
      const lead = this._nextLead();
      if (!lead) break;
      lead.status = "calling";
      this.emitLead(lead);
      this.emitProgress();

      let outcome;
      try {
        outcome = await this.runWorker(workerId, lead);
      } catch (err) {
        this.log(`Worker ${String(workerId).slice(0, 8)} error on ${lead.number}: ${err.message}`);
        outcome = { category: "no_pickup", reason: `error: ${err.message}` };
      }

      if (!this.running) {
        // Campaign was stopped mid-call; leave this lead as stopped.
        lead.status = "stopped";
        this.emitLead(lead);
        break;
      }

      const category = outcome && outcome.category;
      if (category === "cancelled") {
        // Treat like stop for this lead - requeue so a restart can retry.
        lead.status = "queued";
        this.emitLead(lead);
        break;
      }

      if (category === "declined") {
        const attemptsSoFar = lead.attempts + 1;
        if (attemptsSoFar <= this.declineRetries) {
          lead.attempts = attemptsSoFar;
          lead.status = "queued"; // retry later (DND second ring)
          this.log(`${lead.number}: instant decline — requeued for retry (${attemptsSoFar}).`);
          this.emitLead(lead);
          this.emitProgress();
          continue;
        }
        lead.status = "done";
        lead.category = "no_pickup";
        lead.reason = "declined_twice";
      } else if (FINAL.has(category)) {
        lead.status = "done";
        lead.category = category;
        lead.reason = (outcome && outcome.reason) || "";
        lead.via = (outcome && outcome.via) || null;
      } else {
        // Unknown -> count as no_pickup so the queue always drains.
        lead.status = "done";
        lead.category = "no_pickup";
        lead.reason = (outcome && outcome.reason) || "unknown";
      }
      lead.attempts += 1;
      this.emitLead(lead);
      this.emitProgress();
    }

    this.activeWorkers -= 1;
    if (this.activeWorkers <= 0) {
      this.running = false;
      this.log("Campaign complete.");
      this.emitProgress();
    }
  }
}
