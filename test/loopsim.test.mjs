// test/loopsim.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../scripts/lib/check.mjs";
import { next, start, status } from "../scripts/lib/verbs.mjs";
import { watchLoop } from "../scripts/lib/watch.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, makeCtx, tmpProject, wake } from "./helpers.mjs";

const G = (s, { turns = 30, cost = 5 } = {}) => ({ statuses: ["running", "done"], read: { lastText: `STATUS: ${s}\n<promise>MILESTONE</promise>`, cost, turns } });
const BLOCKED = { statuses: ["done"], read: { lastText: "STATUS: BLOCKED - design change needed: X\n<promise>MILESTONE</promise>", cost: 2 } };
const QUIET = { statuses: ["done"], read: { lastText: "I had a think.", cost: 1 } };
// reset `min` minutes after the clock's time AT SCRIPT CREATION — successive limits need increasing
// offsets, each later than the previous wait's end, or the second parses as tomorrow (past the cap)
const limitIn = (clock, min) => { const t = new Date(clock.t + min * 60_000); return { statuses: ["done"], read: { lastText: null, signal: `hit your session limit - resets ${t.getUTCHours()}:${String(t.getUTCMinutes()).padStart(2, "0")} (UTC)`, cost: min / 5, turns: min } }; }; // turns and cost grow with the offset: a resumed stretch clears its baseline, and per-stretch costs come out distinct
const w = (ctx) => watchLoop(ctx, { pollMs: 30_000 });

function sim(script) {
  const p = tmpProject();
  const clock = new FakeClock();
  const binding = new FakeBinding({ script: typeof script === "function" ? script(clock) : script });
  const ctx = makeCtx({ root: p.root, binding, clock });
  return { p, clock, binding, ctx };
}

test("a green milestone: plan → build → close → merge, three transitions, ends when the human check passes", () => {
  const t = sim([G("planned"), G("code green"), G("gate green")]);
  start(t.ctx);
  assert.equal(w(t.ctx).state, "done");
  next(t.ctx, "planned", { on: status(t.ctx).key, because: "plan committed" });
  assert.equal(w(t.ctx).state, "done");
  next(t.ctx, "code green", { on: status(t.ctx).key, because: "tests green, tree clean" });
  assert.equal(w(t.ctx).state, "done");
  const h = next(t.ctx, "gate green", { on: status(t.ctx).key, because: "gate record closed" });
  assert.equal(h.state, "human");
  assert.equal(w(t.ctx).state, "human");
  const run = t.ctx.loadRun();
  assert.deepEqual(run.transitions.map((x) => `${x.from}:${x.label}>${x.to}`), ["plan:planned>build", "build:code green>close", "close:gate green>merge"]);
  assert.deepEqual(run.visits, { plan: 1, build: 1, close: 1, merge: 1 });
  assert.equal(run.sessions.length, 3);
  assert.deepEqual(wake(t.ctx).map((e) => [e.kind, e.phase, e.key]), [["done", "plan", `${run.runId}.1`], ["done", "build", `${run.runId}.2`], ["done", "close", `${run.runId}.3`]]);
  writeFileSync(join(t.p.root, "merged.flag"), "");
  assert.equal(check(t.ctx).state, "none");
  assert.deepEqual([t.ctx.lastEndedRun().endedBy, status(t.ctx).lastRun.totalCost], ["done", 15]);
  t.p.cleanup();
});

test("429 twice mid-plan: both waited out inside the watch, resumed twice, then the work", () => {
  // the final stretch's turns (80) clear the second limit's baseline (65): it ends by the sign-off rule, not the 10-minute grace window
  const t = sim((clock) => [limitIn(clock, 30), limitIn(clock, 65), G("planned", { turns: 80, cost: 15 })]);
  const t0 = t.clock.t;
  start(t.ctx);
  const r = w(t.ctx);
  assert.equal(r.state, "done");
  assert.equal(r.resumes, 2);
  assert.deepEqual(wake(t.ctx).map((e) => e.kind), ["done"]);
  assert.deepEqual(t.ctx.loadRun().sessions.map((s) => [s.phase, s.outcome, s.resumeReason, s.cost]), [["plan", "rate-limited", null, 6], ["plan", "rate-limited", "rate-limit", 7], ["plan", "done", "rate-limit", 2]]);
  // both waits happened inside the watch: the clock sits past the second reset + 60 s, and the last stretch took one
  // running poll to sign off — the grace window would have cost twenty
  assert.ok(t.clock.t >= t0 + 66 * 60_000, `clock advanced ${(t.clock.t - t0) / 60_000} min`);
  // …plus one confirming poll per rate-limited stop: a `done` with no STATUS line is looked at twice before it is
  // believed (`bareDoneConfirmed`), and a rate limit is such a stop.
  assert.equal(t.clock.slept.filter((ms) => ms === 30_000).length, 3);
  t.p.cleanup();
});

test("genuine silence is done with no status hint: the judge decides, the executor never retries", () => {
  const t = sim([QUIET]);
  start(t.ctx);
  const r = w(t.ctx);
  assert.equal(r.state, "done");
  assert.equal(r.statusHint, null);
  assert.match(r.doneReason, /no STATUS line/);
  assert.equal(t.binding.calls.filter((c) => c.call === "resume").length, 0);
  assert.equal(next(t.ctx, "operator", { on: status(t.ctx).key, because: "no STATUS line and nothing in the tree" }).state, "operator");
  t.p.cleanup();
});

test("BLOCKED mid-chain stops the run for the operator; closing is never reached", () => {
  const t = sim([G("planned"), BLOCKED, G("gate green")]);
  start(t.ctx);
  w(t.ctx);
  next(t.ctx, "planned", { on: status(t.ctx).key, because: "ok" });
  const r = w(t.ctx);
  assert.equal(r.state, "done");
  assert.match(r.statusHint, /BLOCKED/);
  assert.equal(next(t.ctx, "blocked", { on: status(t.ctx).key, because: r.statusHint }).state, "operator");
  assert.equal(t.binding.calls.filter((c) => c.call === "launch").length, 2);
  assert.equal(t.ctx.lastEndedRun().reason, "STATUS: BLOCKED - design change needed: X");
  t.p.cleanup();
});

test("a killed build session is resumed under the same id and the chain carries on", () => {
  const t = sim([G("planned"), { statuses: ["gone"] }, { statuses: ["done"], read: { lastText: "STATUS: code green\n<promise>M</promise>", cost: 7, turns: 12 } }]);
  start(t.ctx);
  w(t.ctx);
  next(t.ctx, "planned", { on: status(t.ctx).key, because: "ok" });
  assert.equal(w(t.ctx).state, "gone");
  assert.equal(next(t.ctx, "resume", { on: status(t.ctx).key, because: "killed; transcript intact" }).state, "running");
  assert.equal(w(t.ctx).state, "done");
  const s = t.ctx.loadRun().sessions;
  assert.deepEqual([s[1].id, s[2].id, s[2].resumedFrom, s[2].resumeReason], ["sess-2", "sess-2", "sess-2", "killed; transcript intact"]);
  t.p.cleanup();
});

test("a rate limit that keeps returning is bounded: three resumes, then one rate-limited event for the operator", () => {
  const t = sim((clock) => Array.from({ length: 6 }, (_, i) => limitIn(clock, 20 + i * 30)));
  start(t.ctx);
  assert.equal(w(t.ctx).state, "rate-limited");
  assert.equal(t.binding.calls.filter((c) => c.call === "resume").length, 3);
  const ev = wake(t.ctx);
  assert.deepEqual(ev.map((e) => e.kind), ["rate-limited"]);
  assert.match(ev[0].text, /resumed after a rate limit 3 times/);
  assert.equal(status(t.ctx).state, "finished"); // the session stopped; the run stays active for the operator's next move
  t.p.cleanup();
});
