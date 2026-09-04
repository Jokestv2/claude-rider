// test/loopsim.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../scripts/lib/check.mjs";
import { next, start, status } from "../scripts/lib/verbs.mjs";
import { watchLoop } from "../scripts/lib/watch.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, makeCtx, tmpProject } from "./helpers.mjs";

const G = (s) => ({ statuses: ["running", "done"], read: { lastText: `STATUS: ${s}\n<promise>MILESTONE</promise>`, cost: 5, turns: 30 } });
const BLOCKED = { statuses: ["done"], read: { lastText: "STATUS: BLOCKED - design change needed: X\n<promise>MILESTONE</promise>", cost: 2 } };
const QUIET = { statuses: ["done"], read: { lastText: "I had a think.", cost: 1 } };
// reset `min` minutes after the clock's time AT SCRIPT CREATION — successive limits need increasing
// offsets, each later than the previous wait's end, or the second parses as tomorrow (past the cap)
const limitIn = (clock, min) => { const t = new Date(clock.t + min * 60_000); return { statuses: ["done"], read: { lastText: null, signal: `hit your session limit - resets ${t.getUTCHours()}:${String(t.getUTCMinutes()).padStart(2, "0")} (UTC)`, cost: 4, turns: min } }; }; // turns grow with the offset so a resumed stretch clears its baseline
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
  next(t.ctx, "planned", { because: "plan committed" });
  assert.equal(w(t.ctx).state, "done");
  next(t.ctx, "code green", { because: "tests green, tree clean" });
  assert.equal(w(t.ctx).state, "done");
  const h = next(t.ctx, "gate green", { because: "gate record closed" });
  assert.equal(h.state, "human");
  assert.equal(w(t.ctx).state, "human");
  const run = t.ctx.loadRun();
  assert.deepEqual(run.transitions.map((x) => `${x.from}:${x.label}>${x.to}`), ["plan:planned>build", "build:code green>close", "close:gate green>merge"]);
  assert.deepEqual(run.visits, { plan: 1, build: 1, close: 1, merge: 1 });
  assert.equal(run.sessions.length, 3);
  assert.equal(t.ctx.readEvents().length, 3);
  writeFileSync(join(t.p.root, "merged.flag"), "");
  assert.equal(check(t.ctx).state, "none");
  assert.deepEqual([t.ctx.lastEndedRun().endedBy, status(t.ctx).lastRun.totalCost], ["done", 15]);
  t.p.cleanup();
});

test("429 twice mid-plan: both waited out inside the watch, resumed twice, then the work", () => {
  const t = sim((clock) => [limitIn(clock, 30), limitIn(clock, 65), G("planned")]);
  start(t.ctx);
  const r = w(t.ctx);
  assert.equal(r.state, "done");
  assert.equal(r.resumes, 2);
  assert.equal(t.ctx.readEvents().length, 1);
  assert.deepEqual(t.ctx.loadRun().sessions.map((s) => [s.phase, s.outcome, s.resumeReason]), [["plan", "rate-limited", null], ["plan", "rate-limited", "rate-limit"], ["plan", "done", "rate-limit"]]);
  t.p.cleanup();
});

test("genuine silence is done with no status hint: the judge decides, the executor never retries", () => {
  const t = sim([QUIET]);
  start(t.ctx);
  const r = w(t.ctx);
  assert.equal(r.state, "done");
  assert.equal(r.statusHint, null);
  assert.match(r.doneReason, /no STATUS line/);
  assert.equal(next(t.ctx, "operator", { because: "no STATUS line and nothing in the tree" }).state, "operator");
  t.p.cleanup();
});

test("BLOCKED mid-chain stops the run for the operator; closing is never reached", () => {
  const t = sim([G("planned"), BLOCKED, G("gate green")]);
  start(t.ctx);
  w(t.ctx);
  next(t.ctx, "planned", { because: "ok" });
  const r = w(t.ctx);
  assert.equal(r.state, "done");
  assert.match(r.statusHint, /BLOCKED/);
  assert.equal(next(t.ctx, "blocked", { because: r.statusHint }).state, "operator");
  assert.equal(t.binding.calls.filter((c) => c.call === "launch").length, 2);
  assert.equal(t.ctx.lastEndedRun().reason, "STATUS: BLOCKED - design change needed: X");
  t.p.cleanup();
});

test("a killed build session is resumed under the same id and the chain carries on", () => {
  const t = sim([G("planned"), { statuses: ["gone"] }, { statuses: ["done"], read: { lastText: "STATUS: code green\n<promise>M</promise>", cost: 7, turns: 12 } }]);
  start(t.ctx);
  w(t.ctx);
  next(t.ctx, "planned", { because: "ok" });
  assert.equal(w(t.ctx).state, "gone");
  assert.equal(next(t.ctx, "resume", { because: "killed; transcript intact" }).state, "running");
  assert.equal(w(t.ctx).state, "done");
  const s = t.ctx.loadRun().sessions;
  assert.deepEqual([s[1].id, s[2].id, s[2].resumedFrom, s[2].resumeReason], ["sess-2", "sess-2", "sess-2", "killed; transcript intact"]);
  t.p.cleanup();
});

test("a rate limit that keeps returning is bounded: three resumes, then the operator", () => {
  const t = sim((clock) => Array.from({ length: 6 }, (_, i) => limitIn(clock, 20 + i * 30)));
  start(t.ctx);
  assert.equal(w(t.ctx).state, "rate-limited");
  assert.equal(t.binding.calls.filter((c) => c.call === "resume").length, 3);
  assert.equal(status(t.ctx).state, "finished");
  t.p.cleanup();
});
