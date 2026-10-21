// test/watch-await.test.mjs — the instance's one watcher polls an await phase's check (§7.2, §7.3, §7.5, §7.6)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pollAwait } from "../scripts/lib/await.mjs";
import { currentKey } from "../scripts/lib/keys.mjs";
import { sh } from "../scripts/lib/shell.mjs";
import { render } from "../scripts/lib/render.mjs";
import { next, start, status } from "../scripts/lib/verbs.mjs";
import { awaitEvent, watchLoop } from "../scripts/lib/watch.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { AWAIT_PROMPTS, AWAIT_RIDER_MD, FakeClock, makeCtx, tmpProject, wake } from "./helpers.mjs";

const HOUR = 3_600_000;
const CHECK = "test -f ready.flag || exit 75";

/** A runCheck that answers from `answers` in order, the last one repeating, as the fake binding's statuses do. An answer
 *  is an exit status, or the part of `{ status, timedOut, output, error }` it sets. `during(n)` runs inside the nth call,
 *  while the check would be running. */
function scripted(answers, during = () => {}) {
  const calls = [];
  const fn = (cmd, { timeoutMs, env, key }) => {
    calls.push({ cmd, timeoutMs, key, phase: env?.RIDER_PHASE });
    during(calls.length);
    const a = answers.length > 1 ? answers.shift() : answers[0];
    return { status: 0, timedOut: false, output: "", error: null, ...(typeof a === "number" ? { status: a } : a) };
  };
  fn.calls = calls;
  return fn;
}

/** A project on the await fixture (or `md`), its watcher's context answering from `answers`. */
function project(t, { md = AWAIT_RIDER_MD, answers = [75], during, script = [], instances = [], instance = null } = {}) {
  const p = tmpProject({ riderMd: md, prompts: AWAIT_PROMPTS, instances });
  t.after(p.cleanup);
  const clock = new FakeClock();
  const binding = new FakeBinding({ script });
  const runCheck = scripted(answers, during);
  const ctx = makeCtx({ root: p.root, binding, clock, runCheck, instance });
  const logs = [];
  return { p, clock, binding, ctx, runCheck, logs, opts: { pollMs: 30_000, log: (m) => logs.push(m) } };
}
const waitOf = (ctx) => ctx.loadRun().sessions.find((s) => s.kind === "await");
const at = (min) => new Date(Date.parse("2026-09-03T12:00:00Z") + min * 60_000).toISOString();

test("awaiting → ready after N polls at the phase's interval", (t) => {
  const polledAt = [];
  const w = project(t, { answers: [75, 75, { status: 0, output: "\n  3/3 jobs settled  \n2 succeeded, 1 failed" }], during: () => polledAt.push(w.clock.now().toISOString()) });
  const { runId, key } = start(w.ctx, { phase: "wait" });
  const version = w.ctx.readState().version;
  const r = watchLoop(w.ctx, w.opts);
  assert.deepEqual(r, { ok: true, state: "ready", key, phase: "wait" });
  assert.deepEqual(polledAt, [at(0), at(1), at(2)], "the phase's pollSeconds, not local.json's");
  assert.deepEqual(w.clock.slept, Array(4).fill(30_000), "slept in local.json's pollMs slices, so a decision meanwhile is seen within one");
  assert.deepEqual(w.runCheck.calls, Array(3).fill({ cmd: CHECK, timeoutMs: 300_000, key, phase: "wait" }));
  assert.deepEqual(wake(w.ctx).map((e) => [e.kind, e.runId, e.phase, e.key, e.text]), [["ready", runId, "wait", key, "3/3 jobs settled"]]);
  // A poll appends no event (§7.6): its state.json rewrite is how a reader sees the watcher is still polling.
  assert.deepEqual(w.ctx.readEvents().map((e) => e.kind), ["run-started", "phase-entered", "ready"]);
  assert.equal(w.ctx.readState().version, version + 3);
  const { kind, outcome, polls, lastPollAt, lastExit, lastError, lastOutput, failures, failingSince, failingEmitted, readyAt, timedOutAt } = waitOf(w.ctx);
  assert.deepEqual({ kind, outcome, polls, lastPollAt, lastExit, lastError, lastOutput, failures, failingSince, failingEmitted, readyAt, timedOutAt }, {
    kind: "await", outcome: "ready", polls: 3, lastPollAt: at(2), lastExit: 0, lastError: null, lastOutput: "\n  3/3 jobs settled  \n2 succeeded, 1 failed",
    failures: 0, failingSince: null, failingEmitted: false, readyAt: at(2), timedOutAt: null,
  });
  // An empty ready output still says why the judge woke.
  const quiet = project(t, { answers: [0] });
  start(quiet.ctx, { phase: "wait" });
  watchLoop(quiet.ctx, quiet.opts);
  assert.deepEqual(wake(quiet.ctx).map((e) => [e.kind, e.text]), [["ready", "check passed"]]);
});

test("timed-out at the deadline", (t) => {
  const w = project(t, { answers: [75] });
  const { key } = start(w.ctx, { phase: "wait" });
  const r = watchLoop(w.ctx, w.opts);
  assert.deepEqual(r, { ok: true, state: "timed-out", key, phase: "wait" });
  // Polls at 12:00, 12:01, … 14:00: the poll that reaches the deadline is the one that times the wait out.
  const wait = waitOf(w.ctx);
  assert.deepEqual([wait.outcome, wait.polls, wait.lastExit, wait.timedOutAt, wait.readyAt], ["timed-out", 121, 75, "2026-09-03T14:00:00.000Z", null]);
  assert.equal(w.clock.slept.length, 240, "120 waits of 60 s, each in two 30 s slices");
  assert.deepEqual(wake(w.ctx).map((e) => [e.kind, e.key, e.text]), [["timed-out", key, "deadline 2026-09-03T14:00:00.000Z passed; last exit 75"]]);
});

test("ready beats timed-out after a long sleep", (t) => {
  const w = project(t, { answers: [{ status: 0, output: "settled" }] });
  const { key } = start(w.ctx, { phase: "wait" });
  w.clock.t += 3 * HOUR; // a laptop asleep through the deadline
  assert.deepEqual(watchLoop(w.ctx, w.opts), { ok: true, state: "ready", key, phase: "wait" });
  const wait = waitOf(w.ctx);
  assert.deepEqual([wait.outcome, wait.readyAt, wait.timedOutAt], ["ready", at(180), null]);
  assert.deepEqual(wake(w.ctx).map((e) => [e.kind, e.text]), [["ready", "settled"]]);
});

test("three errors in a row wake the judge once, a 75 ends the streak, and a later streak wakes it again", (t) => {
  const boom = { status: 1, output: "Traceback (most recent call last):\n  File \"tick.py\"" };
  const net = { status: 2, output: "\n  ssh: connect to host: no route to host  \n" };
  // What the record held as each poll's check ran: the streak before that poll was committed.
  const seen = [];
  const w = project(t, { answers: [boom, boom, boom, boom, 75, net, net, net, 0], during: () => { const x = waitOf(w.ctx); seen.push([x.failures, x.failingSince, x.failingEmitted]); } });
  const { key } = start(w.ctx, { phase: "wait" });
  assert.equal(watchLoop(w.ctx, w.opts).state, "ready");
  assert.deepEqual(wake(w.ctx).map((e) => [e.kind, e.key, e.at, e.text]), [
    ["check-failing", key, at(2), "exit 1, 3 in a row: Traceback (most recent call last):"],
    ["check-failing", key, at(7), "exit 2, 3 in a row: ssh: connect to host: no route to host"],
    ["ready", key, at(8), "check passed"],
  ]);
  assert.deepEqual(seen, [
    [0, null, false], [1, at(0), false], [2, at(0), false], [3, at(0), true], [4, at(0), true],
    [0, null, false], [1, at(5), false], [2, at(5), false], [3, at(5), true],
  ]);
  assert.deepEqual(w.clock.slept, Array(16).fill(30_000), "a failing check keeps polling at the phase's interval (the events' times), in pollMs slices");
  // A 0 ends the streak as a 75 does (§7.2): a wait that passed is never reported as failing.
  const wait = waitOf(w.ctx);
  assert.deepEqual([wait.outcome, wait.failures, wait.failingSince, wait.failingEmitted], ["ready", 0, null, false]);
  const st = status(w.ctx);
  assert.deepEqual([st.outcome, st.wait.failures, st.wait.failing], ["ready", 0, false]);
  assert.doesNotMatch(render("status", st), /check failing/);
});

test("a wait that times out mid-streak keeps its streak but is not reported as failing", (t) => {
  const w = project(t, { md: AWAIT_RIDER_MD.replace("timeoutHours: 2", "timeoutHours: 0.05"), answers: [{ status: 1, output: "boom" }] });
  const { key } = start(w.ctx, { phase: "wait" });
  assert.equal(watchLoop(w.ctx, w.opts).state, "timed-out");
  assert.deepEqual(wake(w.ctx).map((e) => [e.kind, e.key, e.at]), [["check-failing", key, at(2)], ["timed-out", key, at(3)]]);
  // The record keeps what the wait went through; check-failing is an awaiting wait at the threshold (§7.5, §7.8), and this one is over.
  const wait = waitOf(w.ctx);
  assert.deepEqual([wait.outcome, wait.failures, wait.failingSince, wait.failingEmitted], ["timed-out", 4, at(0), true]);
  const st = status(w.ctx);
  assert.deepEqual([st.state, st.outcome, st.wait.failures, st.wait.failing], ["finished", "timed-out", 4, false]);
  assert.doesNotMatch(render("status", st), /check failing/);
});

test("a timeout counts as an error", (t) => {
  const w = project(t, { answers: [{ status: -1, timedOut: true, output: "" }] });
  const { key } = start(w.ctx, { phase: "wait" });
  const polled = [1, 2, 3].map(() => pollAwait(w.ctx, { threshold: 3 }));
  assert.deepEqual(polled, [{ outcome: "awaiting", key, phase: "wait", failing: false }, { outcome: "awaiting", key, phase: "wait", failing: false }, { outcome: "awaiting", key, phase: "wait", failing: true }]);
  const wait = waitOf(w.ctx);
  assert.deepEqual([wait.failures, wait.lastExit, wait.lastOutput], [3, -1, ""]);
  assert.match(wait.lastError, /timed out/);
  assert.equal(wait.lastError, "timed out after 300 s");
  // With no output, the error stands in for its first line.
  assert.deepEqual(wake(w.ctx).map((e) => [e.kind, e.text]), [["check-failing", "exit -1, 3 in a row: timed out after 300 s"]]);
  // A timed-out shell that still exited 0 or 75 is no answer: it is an error all the same.
  const zero = project(t, { answers: [{ status: 0, timedOut: true }, { status: 75, timedOut: true }] });
  start(zero.ctx, { phase: "wait" });
  pollAwait(zero.ctx, { threshold: 3 });
  pollAwait(zero.ctx, { threshold: 3 });
  assert.deepEqual([waitOf(zero.ctx).outcome, waitOf(zero.ctx).failures], ["awaiting", 2]);
});

test("the check runs outside the lock", (t) => {
  const held = [];
  const w = project(t, { answers: [75, 0], during: () => held.push([existsSync(w.ctx.paths.lock), w.ctx.holding()]) });
  start(w.ctx, { phase: "wait" });
  assert.equal(watchLoop(w.ctx, w.opts).state, "ready");
  assert.deepEqual(held, [[false, false], [false, false]]);
});

test("a run that moved on during a check gets no poll committed, and the watcher watches what runs now", (t) => {
  let judge = null;
  let started = null;
  const w = project(t, {
    answers: [75],
    script: [{ statuses: ["running", "done"], read: { lastText: "STATUS: planned" } }],
    // The operator ends the wait while the tick runs, then starts plan: `start` finds this watcher's pid alive in
    // production, so nothing else would watch plan (§7.3.2).
    during: (n) => {
      if (n !== 1) return;
      assert.equal(next(judge, "operator", { on: currentKey(judge.loadRun()), by: "operator", because: "the jobs were cancelled by hand" }).state, "operator");
      started = start(judge);
      assert.deepEqual([started.state, started.phase], ["running", "plan"]);
    },
  });
  judge = makeCtx({ root: w.p.root, binding: w.binding, clock: w.clock });
  const { runId } = start(w.ctx, { phase: "wait" });
  const r = watchLoop(w.ctx, w.opts);
  assert.deepEqual([r?.state, r?.phase, r?.key], ["done", "plan", `${started.runId}.1`]);
  const ended = w.ctx.lastEndedRun();
  assert.equal(ended.runId, runId);
  assert.deepEqual([ended.sessions[0].kind, ended.sessions[0].polls, ended.sessions[0].lastPollAt, ended.sessions[0].lastExit], ["await", 0, null, null], "the tick's answer is not committed");
  assert.equal(w.runCheck.calls.length, 1, "the tick was left to finish, and the wait polled no more");
  assert.ok(w.logs.includes("the run moved on; watching its current stretch"), w.logs.join("\n"));
  assert.deepEqual(wake(w.ctx).map((e) => [e.kind, e.key]), [["done", `${started.runId}.1`]]);
  // One watcher spans both kinds, each at its own interval: plan's polls are local.json's pollMs.
  assert.equal(w.clock.slept.includes(60_000), false, `slept ${w.clock.slept.join(", ")}`);
  assert.equal(w.clock.slept[0], 30_000);
});

test("a stretch launched during the wait's sleep is watched within one pollMs slice, not after pollSeconds", (t) => {
  // The operator ends an hourly wait and starts plan while the watcher sleeps: `start` finds this watcher alive and
  // spawns none, so this one has to notice the move (§7.3.2, §7.5).
  let judge = null;
  let started = null;
  const w = project(t, { md: AWAIT_RIDER_MD.replace("pollSeconds: 60", "pollSeconds: 3600"), answers: [75], script: [{ statuses: ["running", "done"], read: { lastText: "STATUS: planned" } }] });
  judge = makeCtx({ root: w.p.root, binding: w.binding, clock: w.clock });
  start(w.ctx, { phase: "wait" });
  const sleep = w.ctx.sleep;
  w.ctx.sleep = (ms) => {
    sleep(ms);
    if (started) return;
    assert.equal(next(judge, "operator", { on: currentKey(judge.loadRun()), by: "operator", because: "the jobs were cancelled by hand" }).state, "operator");
    started = start(judge);
  };
  const r = watchLoop(w.ctx, w.opts);
  assert.deepEqual([r?.state, r?.phase, r?.key], ["done", "plan", `${started.runId}.1`]);
  assert.deepEqual(w.clock.slept.slice(0, 2), [30_000, 30_000], "one slice of the wait's sleep, then plan's one poll");
  assert.ok(w.clock.slept.every((ms) => ms <= 30_000), `slept ${w.clock.slept.join(", ")}`);
  const events = wake(w.ctx);
  assert.deepEqual(events.map((e) => [e.kind, e.key]), [["done", `${started.runId}.1`]]);
  assert.ok(events[0].at < at(2), `plan's stop is seen at ${events[0].at}, not an hour on`);
  assert.ok(w.logs.includes("the run moved on; watching its current stretch"), w.logs.join("\n"));
  assert.equal(w.runCheck.calls.length, 1, "the wait polled no more");
});

test("branch drift during a wait is recorded", (t) => {
  const md = AWAIT_RIDER_MD.replace("name: lemmaria\n", "name: lemmaria\ninstances: nodes/*\n");
  let git = null;
  const w = project(t, { md, instances: ["a"], instance: "a", answers: [75, 0], during: (n) => { if (n === 1) git("checkout -q -b elsewhere"); } });
  git = (cmd) => { const r = sh(`git ${cmd}`, { cwd: w.p.root }); assert.equal(r.status, 0, `git ${cmd}: ${r.output}`); };
  git("init -q -b main");
  git("config user.name Test");
  git("config user.email test@example.com");
  git("config commit.gpgsign false");
  writeFileSync(join(w.p.root, ".gitignore"), ".rider/\n");
  git("add .gitignore riders");
  git('commit -q -m "chore: the rider"');
  start(w.ctx, { phase: "wait" });
  assert.equal(w.ctx.loadRun().baseBranch, "main");
  assert.equal(w.ctx.loadRun().branchDrift, undefined);
  assert.equal(watchLoop(w.ctx, w.opts).state, "ready");
  assert.deepEqual(w.ctx.loadRun().branchDrift, { branch: "elsewhere", at: at(0) }, "seen by the poll whose check it happened during, and kept");
});

test("a dead watcher is respawned mid-wait by await, and counted on the wait", (t) => {
  const w = project(t);
  const { key } = start(w.ctx, { phase: "wait" }); // its spawn fails: the wait starts with no watcher
  assert.equal(waitOf(w.ctx).watcherSpawns, 0);
  let spawns = 0;
  const judge = makeCtx({ root: w.p.root, binding: w.binding, clock: w.clock, watcherAlive: () => null, spawnWatcher: () => { spawns++; return true; } });
  // The respawned watcher's first poll finds the flag, through the default in-process check.
  const watcher = makeCtx({ root: w.p.root, binding: w.binding, clock: w.clock });
  const sleep = judge.sleep;
  judge.sleep = (ms) => {
    sleep(ms);
    if (spawns === 1 && waitOf(watcher).outcome === "awaiting") {
      writeFileSync(join(w.p.root, "ready.flag"), "");
      assert.deepEqual(pollAwait(watcher, { threshold: 3 }), { outcome: "ready", key, phase: "wait", failing: false });
    }
  };
  const r = awaitEvent(judge, { pollMs: 10_000 });
  assert.deepEqual([r.ok, r.state, r.events.map((e) => [e.kind, e.key])], [true, "event", [["ready", key]]]);
  assert.equal(spawns, 1);
  assert.equal(waitOf(w.ctx).watcherSpawns, 1);
});

test("await's heartbeat is 360 minutes at an await phase", (t) => {
  const w = project(t);
  start(w.ctx, { phase: "wait" });
  const judge = makeCtx({ root: w.p.root, binding: w.binding, clock: w.clock, watcherAlive: () => 4242 });
  const t0 = w.clock.t;
  assert.deepEqual(awaitEvent(judge, { pollMs: 600_000 }), { ok: false, state: "timeout", minutes: 360 });
  assert.equal(w.clock.t - t0, 360 * 60_000);
  assert.equal(awaitEvent(judge, { maxMinutes: 30, pollMs: 600_000 }).minutes, 30, "a given --max-minutes wins");
  // Elsewhere it stays 60.
  const s = project(t, { script: [{ statuses: ["running"] }] });
  start(s.ctx);
  const sJudge = makeCtx({ root: s.p.root, binding: s.binding, clock: s.clock, watcherAlive: () => 4242 });
  assert.deepEqual(awaitEvent(sJudge, { pollMs: 600_000 }), { ok: false, state: "timeout", minutes: 60 });
});

test("a check that finds the run entered a wait goes back round to poll it", (t) => {
  // The watcher's stored read saw a session phase, and a decision entered the wait before `check` took the lock: `check`
  // then reports the wait (§7.5), which is the watcher's to poll, never an event to emit.
  const w = project(t, { answers: [0] });
  const { key } = start(w.ctx, { phase: "wait" });
  const loadRun = w.ctx.loadRun;
  let reads = 0;
  w.ctx.loadRun = () => { const run = loadRun(); return ++reads === 1 ? { ...run, phase: "plan" } : run; };
  assert.deepEqual(watchLoop(w.ctx, w.opts), { ok: true, state: "ready", key, phase: "wait" });
  assert.deepEqual(w.ctx.readEvents().map((e) => e.kind), ["run-started", "phase-entered", "ready"]);
  assert.ok(w.logs.includes("the run moved on; watching its current stretch"), w.logs.join("\n"));
});
