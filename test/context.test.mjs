// test/context.test.mjs — one writer per instance: every write under the lock, the lock reentrant within one verb
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { check } from "../scripts/lib/check.mjs";
import { loadRider } from "../scripts/lib/rider-md.mjs";
import { isLive } from "../scripts/lib/state.mjs";
import { endedRunPath, readJson, readState } from "../scripts/lib/store.mjs";
import { next, overrule, reset, start, status } from "../scripts/lib/verbs.mjs";
import { awaitEvent, watchLoop } from "../scripts/lib/watch.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, limitSoon, makeCtx, tmpProject } from "./helpers.mjs";

const GATE = "STATUS: gate green\n<promise>X</promise>";

test("a write outside the lock throws", () => {
  const p = tmpProject();
  try {
    const ctx = makeCtx({ root: p.root, binding: new FakeBinding() });
    assert.throws(() => ctx.saveRun({}), /outside the instance lock/);
    assert.throws(() => ctx.endRun({ runId: "ab12", startedAt: "2026-09-03T12:00:00.000Z" }, { endedBy: "reset" }), /outside the instance lock/);
    assert.throws(() => ctx.saveEndedRun({ runId: "ab12", startedAt: "2026-09-03T12:00:00.000Z" }), /outside the instance lock/);
    assert.throws(() => ctx.reviveRun({ runId: "ab12", startedAt: "2026-09-03T12:00:00.000Z" }), /outside the instance lock/);
    assert.throws(() => ctx.event("noted", { runId: "ab12", phase: "plan" }), /outside the instance lock/);
    assert.throws(() => ctx.ensureWatcher(), /outside the instance lock/);
    assert.throws(() => ctx.killWatcher(), /outside the instance lock/);
    assert.equal(ctx.holding(), false);
    assert.equal(existsSync(ctx.paths.state), false, "nothing was written");
    assert.deepEqual(ctx.readEvents(), []);
  } finally { p.cleanup(); }
});

test("every nested path completes without waiting on its own lock", () => {
  const p = tmpProject();
  const clock = new FakeClock();
  const binding = new FakeBinding({ script: [{ statuses: ["running", "done"], read: { lastText: "STATUS: planned", turns: 5 } }] });
  let ctx = null;
  let spawns = 0;
  // A timeout of 0 turns any wait on the lock into a throw: a nested call that took it again would fail here.
  const spawnWatcher = () => { assert.equal(ctx.holding(), true, "the watcher is spawned inside the write that made the phase live"); spawns++; return true; };
  ctx = makeCtx({ root: p.root, binding, clock, spawnWatcher, lock: { timeoutMs: 0 } });
  const free = (what) => {
    assert.equal(ctx.holding(), false, `${what}: the lock is still held`);
    assert.equal(existsSync(ctx.paths.lock), false, `${what}: the lock file was left behind`);
  };
  try {
    assert.equal(start(ctx).state, "running"); // start → enterPhase → ensureWatcher
    free("start");
    assert.equal(check(ctx).state, "running"); // check → respawnWatcher
    free("check on a running session");
    assert.equal(spawns, 2);
    assert.equal(check(ctx).state, "done");
    free("check that stops the session");

    binding.s.scripts.push({ statuses: ["done"], read: { lastText: "STATUS: planned", turns: 9 } });
    assert.equal(next(ctx, "resume", { on: status(ctx).key, because: "once more" }).state, "running"); // next → resume
    free("next resume");
    assert.equal(check(ctx).state, "done");

    binding.s.scripts.push({ statuses: ["done"], read: { lastText: null, signal: limitSoon(clock), turns: 20 } }, { statuses: ["done"], read: { lastText: "STATUS: code green", turns: 35 } });
    assert.equal(next(ctx, "planned", { on: status(ctx).key, because: "plan committed" }).phase, "build"); // next → enterPhase
    free("next planned");
    assert.equal(watchLoop(ctx, { pollMs: 30_000 }).state, "done"); // check per poll, the rate-limit resume, one emit
    free("watchLoop through a rate-limit resume");
    assert.deepEqual(binding.calls.filter((c) => c.call === "resume").length, 2);

    binding.s.scripts.push({ statuses: ["running"] });
    assert.equal(next(ctx, "code green", { on: status(ctx).key, because: "tests green" }).phase, "close");
    const before = spawns;
    assert.equal(awaitEvent(ctx, { maxMinutes: 1, pollMs: 10_000 }).state, "timeout"); // a dead watcher, respawned
    free("awaitEvent with a dead watcher");
    assert.ok(spawns > before, "await respawned the dead watcher");
  } finally { p.cleanup(); }
});

test("a check queued behind another returns the stored outcome and never writes gone", () => {
  // The finding: two checks on one session. The first stops it; the second, with what it read before the stop,
  // saw an unlisted session and recorded `gone` over a clean `done`. Under the lock the second reads after the first commits.
  const p = tmpProject();
  const binding = new FakeBinding({ script: [{ statuses: ["done"], read: { lastText: GATE, turns: 5 } }] });
  const a = makeCtx({ root: p.root, binding });
  const b = makeCtx({ root: p.root, binding, lock: { timeoutMs: 0 } });
  try {
    start(a, { phase: "close" });
    let statusCalls = 0;
    const status = binding.status.bind(binding);
    binding.status = (ids) => { statusCalls++; return status(ids); };
    const stop = binding.stop.bind(binding);
    let queued = false;
    binding.stop = (ids) => {
      assert.throws(() => check(b), /locked by pid/, "the second check cannot get in while the first holds the instance");
      queued = true;
      return stop(ids);
    };
    assert.equal(check(a).state, "done");
    assert.equal(queued, true);
    const seen = statusCalls;
    const r = check(b);
    assert.equal(r.state, "done");
    assert.equal(r.statusHint, "STATUS: gate green");
    assert.equal(b.loadRun().sessions[0].outcome, "done");
    assert.equal(statusCalls, seen, "the stored outcome is returned; the registry is not asked again");
  } finally { p.cleanup(); }
});

test("state.json survives the run's end: run null, lastRun filled, the record in runs/", () => {
  const p = tmpProject();
  const clock = new FakeClock();
  const ctx = makeCtx({ root: p.root, clock, binding: new FakeBinding({ script: [{ statuses: ["done"], read: { lastText: "STATUS: BLOCKED — x\n<promise>X</promise>", turns: 5, cost: 4 } }] }) });
  try {
    const s = start(ctx);
    check(ctx);
    next(ctx, "blocked", { on: `${s.runId}.1`, because: "blocked on x" });
    const state = readState(ctx.paths);
    assert.equal(state.run, null);
    assert.deepEqual(state.lastRun, { runId: s.runId, phase: "plan", startedAt: "2026-09-03T12:00:00.000Z", endedAt: clock.now().toISOString(), endedBy: "operator", reason: "blocked on x", totalCost: 4, overrulable: ["planned"] });
    const file = endedRunPath(ctx.paths, state.lastRun);
    assert.deepEqual(readdirSync(ctx.paths.runs), [basename(file)]);
    const rec = readJson(file);
    assert.deepEqual([rec.runId, rec.endedBy, rec.reason, rec.sessions.length], [s.runId, "operator", "blocked on x", 1]);
    assert.deepEqual(ctx.lastEndedRun(), rec);
    assert.deepEqual(ctx.readEvents().map((e) => [e.kind, e.runId]), [["run-started", s.runId], ["phase-entered", s.runId], ["decided", s.runId], ["run-ended", s.runId]]);
  } finally { p.cleanup(); }
});

test("overrule's revival moves the record back; lastRun falls back to the run before it", () => {
  const p = tmpProject();
  const clock = new FakeClock();
  const ctx = makeCtx({ root: p.root, clock, binding: new FakeBinding({ script: [{ statuses: ["done"], read: { lastText: GATE, turns: 5 } }, { statuses: ["done"], read: { lastText: GATE, turns: 5 } }] }) });
  const flag = join(p.root, "merged.flag");
  try {
    const one = start(ctx, { phase: "close" });
    check(ctx);
    next(ctx, "gate green", { on: `${one.runId}.1`, because: "gate record closed" });
    writeFileSync(flag, "");
    assert.equal(check(ctx).state, "none");
    rmSync(flag);
    clock.t += 60_000; // records are named by start time: two runs started at one frozen instant would tie
    const two = start(ctx, { phase: "close" });
    check(ctx);
    next(ctx, "operator", { on: `${two.runId}.1`, because: "asked for a ruling" });
    assert.equal(readState(ctx.paths).lastRun.runId, two.runId);
    assert.equal(readdirSync(ctx.paths.runs).length, 2);

    assert.equal(overrule(ctx, "gate green", { on: two.runId, because: "the correction stands" }).state, "human");
    const state = readState(ctx.paths);
    assert.equal(state.run.runId, two.runId);
    assert.equal(state.run.endedBy, undefined);
    assert.deepEqual([state.lastRun.runId, state.lastRun.endedBy], [one.runId, "done"]);
    assert.deepEqual(readdirSync(ctx.paths.runs), [basename(endedRunPath(ctx.paths, state.lastRun))], "only run 1's record is left in runs/");
    assert.equal(ctx.lastEndedRun().runId, one.runId);
  } finally { p.cleanup(); }
});

test("a hold's events are written when it commits, numbered as they land, and dropped when it throws", () => {
  const p = tmpProject();
  try {
    const ctx = makeCtx({ root: p.root, binding: new FakeBinding() });
    const queued = ctx.update(() => {
      const e = ctx.event("noted", { runId: "ab12", phase: "plan", text: "kept" });
      assert.deepEqual(ctx.readEvents(), [], "not on file while the hold is open");
      return e;
    });
    assert.equal(queued.seq, 1, "the caller's event carries its seq once the hold has committed");
    assert.deepEqual(ctx.readEvents(), [queued]);
    assert.throws(() => ctx.update(() => { ctx.event("noted", { runId: "ab12", phase: "plan", text: "lost" }); throw new Error("boom"); }), /boom/);
    assert.deepEqual(ctx.readEvents().map((e) => e.text), ["kept"]);
    assert.equal(ctx.holding(), false);
  } finally { p.cleanup(); }
});

test("a verb whose hold throws leaves no record event for the write it never made", () => {
  const p = tmpProject();
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses: ["done"], read: { lastText: "STATUS: planned", turns: 5 } }] }) });
  const kinds = () => ctx.readEvents().map((e) => e.kind);
  try {
    // start queues run-started, then the launch's prompt read throws before any state is written.
    rmSync(join(p.riderDir, "plan.md"));
    assert.throws(() => start(ctx), /ENOENT/);
    assert.deepEqual([kinds(), ctx.loadRun()], [[], null]);

    writeFileSync(join(p.riderDir, "plan.md"), "PLAN PROMPT");
    start(ctx);
    assert.equal(check(ctx).state, "done");
    // next queues decided, then entering build throws the same way: no decided, and the run has not moved.
    rmSync(join(p.riderDir, "build.md"));
    assert.throws(() => next(ctx, "planned", { on: status(ctx).key, because: "plan committed" }), /ENOENT/);
    assert.deepEqual(kinds(), ["run-started", "phase-entered"]);
    assert.deepEqual([ctx.loadRun().phase, ctx.loadRun().transitions.length], ["plan", 0]);

    // reset queues reset, then the end's first write fails: a file stands where runs/ goes.
    writeFileSync(ctx.paths.runs, "");
    assert.throws(() => reset(ctx, { on: status(ctx).runId }), { code: "EEXIST" });
    assert.deepEqual(kinds(), ["run-started", "phase-entered"], "neither reset nor run-ended");
    assert.equal(ctx.loadRun().phase, "plan", "state.json is the truth: the run is still active");
    assert.equal(ctx.holding(), false);
    assert.equal(existsSync(ctx.paths.lock), false);
  } finally { p.cleanup(); }
});

test("isLive: a session phase with a running or waiting stretch, nothing else", () => {
  const p = tmpProject();
  try {
    const rider = loadRider(p.file);
    const at = (phase, outcome) => ({ phase, sessions: outcome ? [{ phase, outcome }] : [] });
    const table = [
      ["human phase", at("merge", "running"), false],
      ["session running", at("plan", "running"), true],
      ["session waiting", at("plan", "waiting"), true],
      ["session done", at("plan", "done"), false],
      ["no session", at("plan", null), false],
      ["no run", null, false],
    ];
    for (const [name, run, live] of table) assert.equal(isLive(run, rider), live, name);
  } finally { p.cleanup(); }
});
