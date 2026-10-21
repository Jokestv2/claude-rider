// test/loopsim.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../scripts/lib/check.mjs";
import { next, start, status } from "../scripts/lib/verbs.mjs";
import { watchLoop } from "../scripts/lib/watch.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { AWAIT_PROMPTS, AWAIT_RIDER_MD, FakeClock, makeCtx, requiring, tmpProject, wake } from "./helpers.mjs";

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
  // running poll to sign off — the grace window would have cost twenty. The waits tick at the poll interval too, so
  // the polls are told apart by where the clock stops, not by counting 30 s sleeps.
  assert.ok(t.clock.t >= t0 + 66 * 60_000, `clock advanced ${(t.clock.t - t0) / 60_000} min`);
  assert.ok(t.clock.t - (t0 + 66 * 60_000) < 60_000, `${(t.clock.t - t0 - 66 * 60_000) / 1000} s after the second wait`);
  assert.ok(t.clock.slept.every((ms) => ms <= 30_000), "no sleep longer than a poll");
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

test("requires, locate and an await phase compose over three laps", (t) => {
  // The await fixture as a loop (§10): `locate` reads where the project's files say a fresh run enters, review needs a
  // budget, the wait may hand the run straight to the gate, and the visit cap is declared as 4, above the wait's three entries.
  const edit = (md, from, to) => { const out = md.replace(from, to); assert.notEqual(out, md, `fixture edit missed: ${from}`); return out; };
  let md = requiring("review", ["test -f budget.ok"], AWAIT_RIDER_MD);
  md = edit(md, "start: plan\n", "start: plan\nlocate: cat where.txt\n");
  md = edit(md, "timed out: operator }", "timed out: operator, check in: merge }");
  md = edit(md, "\nintake:\n", "\nlimits: { visits: 4 }\nintake:\n");
  const p = tmpProject({ riderMd: md, prompts: AWAIT_PROMPTS });
  t.after(p.cleanup);
  const file = (name) => join(p.root, name);
  // The jobs a wait waits on settle while the watcher sleeps: `flipIn` counts the sleeps left before ready.flag appears.
  // makeCtx takes the clock's sleep as it is, so the hook goes in first.
  const clock = new FakeClock();
  const tick = clock.sleep;
  let flipIn = 0;
  clock.sleep = (ms) => { tick(ms); if (flipIn && --flipIn === 0) writeFileSync(file("ready.flag"), ""); };
  const binding = new FakeBinding({ script: [G("planned"), G("more"), G("more"), G("done")] });
  const ctx = makeCtx({ root: p.root, binding, clock });
  assert.deepEqual([ctx.rider.locate, ctx.rider.phases.review.requires, ctx.rider.phases.wait.edges["check in"], ctx.rider.limits.visits], ["cat where.txt", ["test -f budget.ok"], "merge", 4]);
  writeFileSync(file("where.txt"), "plan\n");
  writeFileSync(file("budget.ok"), "");
  /** One wait watched to ready: two polls answer 75, the flag appears in the second sleep, the third poll passes. The
   *  flag is consumed, so the next lap's wait polls again. Returns the wait's key. */
  const waitReady = () => {
    flipIn = 2;
    assert.equal(w(ctx).state, "ready");
    rmSync(file("ready.flag"));
    const wait = ctx.loadRun().sessions.at(-1);
    assert.deepEqual([wait.kind, wait.outcome, wait.polls, wait.lastExit], ["await", "ready", 3, 0]);
    return status(ctx).key;
  };

  const s = start(ctx);
  assert.deepEqual([s.state, s.phase], ["running", "plan"]);
  assert.deepEqual(ctx.loadRun().entry, { by: "locate", located: "plan", phase: "plan" });
  assert.equal(w(ctx).state, "done");
  assert.equal(next(ctx, "planned", { on: status(ctx).key, because: "plan committed" }).state, "awaiting");
  for (let lap = 1; lap <= 2; lap++) {
    assert.equal(next(ctx, "settled", { on: waitReady(), because: "the jobs settled" }).phase, "review");
    assert.equal(w(ctx).state, "done");
    assert.equal(next(ctx, "more", { on: status(ctx).key, because: "a job needs rerunning" }).state, "awaiting");
  }
  // Lap three: the budget is spent by the time the jobs settle. The pre-flight refuses the review, the run stays where
  // it was, and the same key takes the other way out of the wait.
  const key = waitReady();
  rmSync(file("budget.ok"));
  const bytes = readFileSync(ctx.paths.state, "utf8");
  const refused = next(ctx, "settled", { on: key, because: "the jobs settled" });
  assert.deepEqual([refused.ok, refused.cause, refused.error], [false, "requires", "requires check failed for review (exit 1): test -f budget.ok"]);
  assert.equal(readFileSync(ctx.paths.state, "utf8"), bytes, "a refusal changes nothing");
  const runId = ctx.loadRun().runId;
  assert.deepEqual(ctx.readEvents().filter((e) => e.kind === "refused").map((e) => [e.cause, e.runId, e.phase, e.key, e.by]), [["requires", runId, "wait", `${runId}.6`, "judge"]]);
  assert.equal(key, `${runId}.6`);
  const gate = next(ctx, "check in", { on: key, because: "no budget left for another review" });
  assert.deepEqual([gate.state, gate.phase], ["human", "merge"]);
  writeFileSync(file("merged.flag"), "");
  assert.equal(check(ctx).state, "none");
  const first = ctx.lastEndedRun();
  assert.equal(first.endedBy, "done");
  assert.deepEqual(first.transitions.map((x) => `${x.from}:${x.label}>${x.to}`), ["plan:planned>wait", "wait:settled>review", "review:more>wait", "wait:settled>review", "review:more>wait", "wait:check in>merge"]);
  assert.deepEqual(first.visits, { plan: 1, wait: 3, review: 2, merge: 1 });
  // The one watcher spans both kinds: it woke the judge once per stretch, on done at a session and on ready at the wait.
  assert.deepEqual(wake(ctx).map((e) => [e.kind, e.phase]), [["done", "plan"], ["ready", "wait"], ["done", "review"], ["ready", "wait"], ["done", "review"], ["ready", "wait"]]);

  // The project's files now say the next run reviews. A located phase keeps its door: until the budget is back, review's
  // requires refuses the start and no run is made.
  writeFileSync(file("where.txt"), "review\n");
  const blocked = start(ctx);
  assert.deepEqual([blocked.ok, blocked.cause], [false, "requires"]);
  assert.equal(ctx.loadRun(), null);
  writeFileSync(file("budget.ok"), "");
  const second = start(ctx);
  assert.deepEqual([second.state, second.phase], ["running", "review"]);
  assert.deepEqual(ctx.loadRun().entry, { by: "locate", located: "review", phase: "review" });
  assert.equal(binding.calls.filter((c) => c.call === "launch").length, 4);
});
