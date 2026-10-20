// test/verbs-await.test.mjs — entering an await phase, and the verbs that decide on a wait (§7.4, §7.5)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyOf } from "../scripts/lib/state.mjs";
import { next, reset, resume, start, status } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { AWAIT_PROMPTS, AWAIT_RIDER_MD, makeCtx, requiring, save, tmpProject } from "./helpers.mjs";

const HOUR = 3_600_000;
const AWAITING = (key, polls = 0, exit = "none") => `wait is awaiting its check (poll ${polls}, last exit ${exit}): only the operator ends a wait early — rider next operator --on ${key} --by operator --because "…"`;
const NO_RESUME = "wait has no session to resume: an await phase waits on its check, and waiting again is an edge back to it";

/** A project on the await fixture (or `md`). The watcher spawns, the kills and the await checks are counted: nothing in
 *  these verbs may run the check (§7.5), so `checks` stays empty. */
function project(t, { md = AWAIT_RIDER_MD, script = [], ...opts } = {}) {
  const p = tmpProject({ riderMd: md, prompts: AWAIT_PROMPTS });
  t.after(p.cleanup);
  const n = { spawns: 0, kills: 0 };
  const checks = [];
  const binding = new FakeBinding({ script });
  const ctx = makeCtx({ root: p.root, binding, spawnWatcher: () => { n.spawns++; return true; }, killWatcher: () => { n.kills++; }, runCheck: (cmd) => { checks.push(cmd); return { status: 75, timedOut: false, output: "", error: null }; }, ...opts });
  return { p, ctx, binding, n, checks, flag: (name) => join(p.root, name) };
}

/** What the watcher's poll would have stored (Task 9 polls; these tests set it by hand): the current wait, ready or timed out. */
function settle(ctx, outcome = "ready") {
  const run = ctx.loadRun();
  const wait = run.sessions.at(-1);
  const at = ctx.now().toISOString();
  Object.assign(wait, { outcome, polls: 3, lastPollAt: at, lastExit: outcome === "ready" ? 0 : 75 }, outcome === "ready" ? { readyAt: at } : { timedOutAt: at });
  save(ctx, run);
  return keyOf(run, wait);
}

/** A review stretch stopped as the watcher would have found it: decidable, with no check through the binding. */
function reviewDone(ctx) {
  const run = ctx.loadRun();
  const sess = run.sessions.at(-1);
  sess.outcome = "done";
  save(ctx, run);
  return keyOf(run, sess);
}

test("locate may print an await phase", (t) => {
  const { ctx, binding } = project(t, { md: AWAIT_RIDER_MD.replace("start: plan\n", "start: plan\nlocate: echo wait\n") });
  const r = start(ctx);
  assert.deepEqual([r.ok, r.state, r.phase], [true, "awaiting", "wait"]);
  assert.deepEqual(ctx.loadRun().entry, { by: "locate", located: "wait", phase: "wait" });
  assert.equal(binding.calls.length, 0);
});

test("start may name an await phase: a wait record, a watcher, no launch", (t) => {
  const { ctx, binding, n, checks } = project(t);
  const r = start(ctx, { phase: "wait" });
  const run = ctx.loadRun();
  const key = `${run.runId}.1`;
  const at = "2026-09-03T12:00:00.000Z";
  const deadline = "2026-09-03T14:00:00.000Z";
  assert.deepEqual(r, { ok: true, state: "awaiting", runId: run.runId, phase: "wait", visit: 1, key, check: "test -f ready.flag || exit 75", pollSeconds: 60, deadline });
  assert.deepEqual(run.sessions, [{
    kind: "await", phase: "wait", at, check: "test -f ready.flag || exit 75", outcome: "awaiting", polls: 0, lastPollAt: null, lastExit: null, lastError: null, lastOutput: null,
    failures: 0, failingSince: null, failingEmitted: false, deadline, readyAt: null, timedOutAt: null, watcherSpawns: 1,
  }]);
  assert.equal(new Date(run.sessions[0].deadline) - new Date(run.sessions[0].at), 2 * HOUR);
  assert.deepEqual(run.visits, { wait: 1 });
  assert.deepEqual(run.entry, { by: "operator", located: null, phase: "wait" });
  assert.deepEqual([n.spawns, binding.calls.length, checks.length], [1, 0, 0], "one watcher, no launch, and the check is the watcher's to run");
  assert.deepEqual(ctx.readEvents().map((e) => [e.kind, e.phase, e.key, e.text]), [["run-started", "wait", null, "wait by operator"], ["phase-entered", "wait", key, "visit 1 · await: test -f ready.flag || exit 75 every 60 s"]]);
});

test("a dry run at an await phase names its check and records nothing", (t) => {
  const { ctx, n } = project(t);
  const d = start(ctx, { phase: "wait", dryRun: true });
  assert.deepEqual(d, { ok: true, state: "dry-run", phase: "wait", await: true, check: "test -f ready.flag || exit 75", entry: { by: "operator", located: null, phase: "wait" } });
  assert.deepEqual([n.spawns, ctx.readEvents().length, existsSync(ctx.paths.state)], [0, 0, false]);
});

test("start runs an await target's requires", (t) => {
  const { ctx, flag } = project(t, { md: requiring("wait", ["test -f ok.flag"], AWAIT_RIDER_MD) });
  const r = start(ctx, { phase: "wait" });
  assert.deepEqual([r.ok, r.cause, r.error], [false, "requires", "requires check failed for wait (exit 1): test -f ok.flag"]);
  assert.equal(existsSync(ctx.paths.state), false, "no run");
  writeFileSync(flag("ok.flag"), "");
  assert.equal(start(ctx, { phase: "wait" }).state, "awaiting");
});

test("a fractional timeoutHours gives the right deadline; none gives none", (t) => {
  const { ctx } = project(t, { md: AWAIT_RIDER_MD.replace("timeoutHours: 2", "timeoutHours: 0.5") });
  const r = start(ctx, { phase: "wait" });
  assert.equal(r.deadline, "2026-09-03T12:30:00.000Z");
  assert.equal(new Date(r.deadline) - new Date(ctx.loadRun().sessions[0].at), HOUR / 2);
  const { ctx: open } = project(t, { md: AWAIT_RIDER_MD.replace("    timeoutHours: 2\n", "") });
  assert.equal(start(open, { phase: "wait" }).deadline, null);
  assert.equal(open.loadRun().sessions[0].deadline, null);
});

test("while awaiting, only the operator's operator is accepted", (t) => {
  const { ctx, n } = project(t);
  const { runId, key } = start(ctx, { phase: "wait" });
  const bytes = readFileSync(ctx.paths.state, "utf8");
  for (const [label, by] of [["settled", "judge"], ["settled", "operator"], ["timed out", "judge"], ["operator", "judge"], ["resume", "operator"], [undefined, "judge"]]) {
    const r = next(ctx, label, { on: key, by, because: "x" });
    assert.deepEqual([r.ok, r.error], [false, AWAITING(key)], `${label} by ${by}`);
  }
  assert.equal(readFileSync(ctx.paths.state, "utf8"), bytes, "a refusal changes nothing");
  // The poll it names is the stored one.
  const run = ctx.loadRun();
  Object.assign(run.sessions[0], { polls: 169, lastExit: 75 });
  save(ctx, run);
  assert.equal(next(ctx, "settled", { on: key }).error, AWAITING(key, 169, 75));
  const r = next(ctx, "operator", { on: key, by: "operator", because: "the jobs were cancelled by hand" });
  assert.deepEqual([r.ok, r.state, r.runId, r.reason], [true, "operator", runId, "the jobs were cancelled by hand"]);
  assert.equal(ctx.loadRun(), null);
  assert.deepEqual(ctx.lastEndedRun().transitions.map((x) => [x.from, x.label, x.to, x.by]), [["wait", "operator", "operator", "operator"]]);
  assert.equal(n.kills, 0, "the watcher is not killed: its next commit finds the run moved on");
});

test("next while awaiting runs no requires", (t) => {
  // Controller ruling R2: the hold refuses every label but the operator's operator here, and that one has no requires.
  const { ctx, flag } = project(t, { md: requiring("review", ["touch ran.flag"], AWAIT_RIDER_MD) });
  const { key } = start(ctx, { phase: "wait" });
  assert.equal(next(ctx, "settled", { on: key }).error, AWAITING(key));
  assert.equal(existsSync(flag("ran.flag")), false);
});

test("resume is refused at an await phase", (t) => {
  const { ctx, binding } = project(t);
  const { key } = start(ctx, { phase: "wait" });
  assert.deepEqual([resume(ctx, { on: key }).ok, resume(ctx, { on: key }).error], [false, NO_RESUME]);
  settle(ctx);
  assert.equal(resume(ctx, { on: key }).error, NO_RESUME);
  assert.equal(next(ctx, "resume", { on: key }).error, NO_RESUME, "nor is it a label of a decided wait");
  assert.equal(binding.calls.length, 0);
});

test("at ready, an edge is taken against the stored poll", (t) => {
  const { ctx, binding, checks, flag } = project(t, { script: [{ statuses: ["running"] }] });
  start(ctx, { phase: "wait" });
  writeFileSync(flag("ready.flag"), "");
  const key = settle(ctx);
  rmSync(flag("ready.flag")); // the check would now say "not yet": next must not ask it again (§16 C4)
  assert.equal(next(ctx, "bogus", { on: key }).error, '"bogus" is not an edge of wait — legal: settled · timed out · operator');
  const r = next(ctx, "settled", { on: key, because: "3/3 jobs settled" });
  assert.deepEqual([r.ok, r.state, r.phase, r.visit], [true, "running", "review", 1]);
  assert.equal(binding.calls[0].prompt, "REVIEW PROMPT");
  assert.equal(checks.length, 0, "no check ran");
  const run = ctx.loadRun();
  assert.deepEqual(run.transitions.map((x) => [x.from, x.label, x.to]), [["wait", "settled", "review"]]);
  assert.deepEqual(ctx.readEvents().filter((e) => e.kind === "decided").map((e) => [e.key, e.text]), [[key, "settled → review: 3/3 jobs settled"]]);
});

test("a timed-out wait takes its edge like a ready one", (t) => {
  const { ctx } = project(t);
  start(ctx, { phase: "wait" });
  const key = settle(ctx, "timed-out");
  const r = next(ctx, "timed out", { on: key, because: "deadline passed" });
  assert.deepEqual([r.state, r.reason], ["operator", "deadline passed"]);
  assert.deepEqual(r.overrulable, ["settled"], "the judge's stop is the operator's to overrule");
});

test("the visit cap fires on the await phase's fourth entry", (t) => {
  const { ctx, binding } = project(t, { script: [{}, {}, {}] });
  start(ctx, { phase: "wait" });
  for (let visit = 1; visit <= 3; visit++) {
    assert.equal(next(ctx, "settled", { on: settle(ctx) }).phase, "review");
    const r = next(ctx, "more", { on: reviewDone(ctx), because: "a job needs rerunning" });
    if (visit < 3) { assert.deepEqual([r.state, r.visit], ["awaiting", visit + 1]); continue; }
    assert.equal(r.state, "operator");
    assert.equal(r.reason, "visit cap: wait entered 4 times (limits.visits is 3)");
  }
  assert.equal(ctx.loadRun(), null);
  assert.deepEqual(ctx.lastEndedRun().visits, { wait: 4, review: 3 });
  assert.equal(binding.calls.length, 3);
});

test("a wait's key goes through keyRefusal unchanged", (t) => {
  const { ctx } = project(t, { script: [{ statuses: ["running"] }] });
  const { runId, key } = start(ctx, { phase: "wait" });
  // A key past the wait is no stretch of the run, refused as stale before the wait is asked anything.
  const ahead = next(ctx, "operator", { on: `${runId}.2`, by: "operator" });
  assert.deepEqual([ahead.ok, ahead.stale], [false, true]);
  assert.match(ahead.error, new RegExp(`^${runId}\\.2 is no stretch of run ${runId}, but the latest stretch of wait is ${runId}\\.1; now phase wait`));
  next(ctx, "settled", { on: settle(ctx) });
  const r = next(ctx, "settled", { on: key, by: "judge" });
  assert.deepEqual([r.ok, r.stale, r.error.split(";")[0]], [false, true, `${key} judged phase wait, but the latest stretch of review is ${runId}.2`]);
  assert.deepEqual(ctx.readEvents().filter((e) => e.kind === "refused").map((e) => [e.key, e.phase, e.by, e.cause]), [[`${runId}.2`, "wait", "operator", "stale"], [key, "review", "judge", "stale"]]);
});

test("status reports a wait: awaiting, then finished with its outcome", (t) => {
  const { ctx } = project(t);
  const { runId, key } = start(ctx, { phase: "wait" });
  const s = status(ctx);
  assert.deepEqual([s.state, s.outcome, s.key, s.phase, s.attach], ["awaiting", "awaiting", key, "wait", null]);
  assert.deepEqual(s.wait, { check: "test -f ready.flag || exit 75", at: "2026-09-03T12:00:00.000Z", polls: 0, lastPollAt: null, lastExit: null, lastError: null, failures: 0, failing: false, failingSince: null, deadline: "2026-09-03T14:00:00.000Z", readyAt: null, timedOutAt: null });
  assert.deepEqual(s.sessions.map((x) => [x.key, x.kind, x.phase, x.outcome]), [[key, "await", "wait", "awaiting"]]);
  // A failing check is no state of its own: an awaiting wait whose failures reached local.json's threshold (§7.5).
  const run = ctx.loadRun();
  Object.assign(run.sessions[0], { polls: 5, lastExit: 127, lastError: "sh: tool: not found", failures: 3, failingSince: "2026-09-03T12:02:00.000Z" });
  save(ctx, run);
  assert.deepEqual([status(ctx).state, status(ctx).wait.failing], ["awaiting", true]);
  assert.equal(status(makeCtx({ root: ctx.root, binding: ctx.binding, local: { awaitCheckFailures: 4 } })).wait.failing, false);
  settle(ctx, "timed-out");
  const done = status(ctx);
  assert.deepEqual([done.state, done.outcome, done.wait.timedOutAt, done.runId], ["finished", "timed-out", "2026-09-03T12:00:00.000Z", runId]);
  assert.deepEqual(status(ctx).sessions.map((x) => x.kind), ["await"]);
});

test("status rows carry kind: a session stretch beside a wait", (t) => {
  const { ctx } = project(t, { script: [{ statuses: ["running"] }] });
  start(ctx, { phase: "wait" });
  next(ctx, "settled", { on: settle(ctx) });
  const s = status(ctx);
  assert.deepEqual(s.sessions.map((x) => [x.kind, x.phase, x.outcome]), [["await", "wait", "ready"], ["session", "review", "running"]]);
  assert.equal("wait" in s, false, "a session phase has no wait");
});

test("reset of an await phase names no paying session", (t) => {
  const { ctx, n } = project(t);
  const { runId, key } = start(ctx, { phase: "wait" });
  const r = reset(ctx, { on: runId, because: "jobs moved to another queue" });
  assert.deepEqual([r.ok, r.message], [true, `run ${runId} forgotten; its record is under runs/`]);
  assert.equal(n.kills, 1, "the watcher, and with it the check group (§7.3.1)");
  assert.deepEqual(ctx.readEvents().filter((e) => e.kind === "reset").map((e) => [e.key, e.text]), [[key, "jobs moved to another queue"]]);
});

test("a gate reached from a wait alone records no handoff: a wait is no session", (t) => {
  const { ctx } = project(t, { md: AWAIT_RIDER_MD.replace("edges: { settled: review, timed out: operator }", "edges: { settled: merge, timed out: operator }") });
  start(ctx, { phase: "wait" });
  const r = next(ctx, "settled", { on: settle(ctx) });
  assert.deepEqual([r.state, r.phase], ["human", "merge"]);
  assert.equal(ctx.loadRun().handoff, null);
});
