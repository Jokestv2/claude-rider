// test/watch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitEvent, watchLoop } from "../scripts/lib/watch.mjs";
import { currentKey } from "../scripts/lib/keys.mjs";
import { currentSession } from "../scripts/lib/state.mjs";
import { next, start, status } from "../scripts/lib/verbs.mjs";
import { render } from "../scripts/lib/render.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, limitSoon, makeCtx, save, tmpProject, wake } from "./helpers.mjs";

const GREEN = "STATUS: planned\n<promise>MILESTONE PLANNED</promise>";
function setup(script, local = {}) {
  const p = tmpProject();
  const binding = new FakeBinding({ script });
  const clock = new FakeClock();
  const ctx = makeCtx({ root: p.root, binding, clock, local });
  return { p, binding, clock, ctx, logs: [] };
}
const opts = (t) => ({ pollMs: 30_000, log: (m) => t.logs.push(m) });

test("done: the watch polls, emits one line, exits", () => {
  // STATUS line without the promise: the signed-off rule must NOT cut this one short
  const t = setup([{ statuses: ["running", "running", "done"], read: { lastText: "STATUS: planned", cost: 3 } }]);
  start(t.ctx);
  const r = watchLoop(t.ctx, opts(t));
  assert.equal(r.state, "done");
  const ev = wake(t.ctx);
  assert.equal(ev.length, 1);
  assert.match(ev[0].at, /^2026-09-03T12:0\d:\d\d\.000Z$/);
  assert.deepEqual({ ...ev[0], at: null, seq: null }, { seq: null, at: null, rider: "lemmaria", instance: "default", runId: r.runId, kind: "done", phase: "plan", key: `${r.runId}.1`, text: "STATUS: planned" });
  assert.deepEqual(t.clock.slept.filter((ms) => ms === 30_000).length, 2);
  t.p.cleanup();
});

test("a rate limit inside the caps: no event, wait to the reset + 1 min, resume, carry on", () => {
  const t = setup([]);
  t.binding.s.scripts.push({ statuses: ["done"], read: { lastText: null, signal: limitSoon(t.clock), cost: 10, turns: 20 } }, { statuses: ["done"], read: { lastText: GREEN, cost: 25, turns: 35 } });
  start(t.ctx);
  const r = watchLoop(t.ctx, opts(t));
  assert.equal(r.state, "done");
  assert.equal(r.resumes, 1);
  assert.equal(r.cost, 15);
  assert.deepEqual(wake(t.ctx).map((e) => [e.kind, e.key]), [["done", `${r.runId}.2`]]);
  assert.equal(t.binding.calls.filter((c) => c.call === "resume").length, 1);
  assert.ok(t.logs.some((m) => /rate limited; waiting/.test(m)));
  // The wait is pollMs ticks, each one state read, never one long sleep: a stretch launched meanwhile is picked up in a poll.
  assert.ok(t.clock.slept.every((ms) => ms <= 30_000), `slept ${t.clock.slept.join(", ")}`);
  t.p.cleanup();
});

test("a decision during the rate-limit wait: the same watcher watches the new stretch and emits its stop", () => {
  const t = setup([]);
  t.binding.s.scripts.push({ statuses: ["done"], read: { lastText: null, signal: limitSoon(t.clock), turns: 20 } }, { statuses: ["running", "done"], read: { lastText: "STATUS: code green\n<promise>X</promise>", turns: 9 } });
  const judge = makeCtx({ root: t.p.root, binding: t.binding, clock: t.clock });
  const { runId: r } = start(t.ctx);
  // The judge decides plan's stretch while the watcher sleeps through the wait. `next` finds this watcher alive and
  // spawns none, so nothing else would watch build.
  const sleep = t.ctx.sleep;
  let decided = false;
  t.ctx.sleep = (ms) => {
    sleep(ms);
    if (!decided && judge.loadRun().sessions[0].outcome === "rate-limited") {
      decided = true;
      assert.equal(next(judge, "planned", { on: `${r}.1`, because: "the plan was committed before the limit" }).phase, "build");
    }
  };
  const out = watchLoop(t.ctx, opts(t));
  assert.equal(decided, true);
  assert.deepEqual([out?.state, out?.key, out?.phase], ["done", `${r}.2`, "build"]);
  assert.deepEqual(wake(t.ctx).map((e) => [e.kind, e.key]), [["done", `${r}.2`]]);
  assert.equal(t.binding.calls.filter((c) => c.call === "resume").length, 0, "the waited stretch is not resumed");
  assert.ok(t.logs.includes("the run moved on while waiting; watching its current stretch"), t.logs.join("\n"));
  t.p.cleanup();
});

test("three resumes, then rate-limited is an event for the operator", () => {
  const t = setup([]);
  for (let i = 0; i < 5; i++) t.binding.s.scripts.push({ statuses: ["done"], read: { lastText: null, signal: limitSoon(t.clock, 30 + i * 30), turns: 1 + i } });
  start(t.ctx);
  const r = watchLoop(t.ctx, opts(t));
  assert.equal(r.state, "rate-limited");
  assert.equal(t.binding.calls.filter((c) => c.call === "resume").length, 3);
  const ev = wake(t.ctx);
  assert.deepEqual(ev.map((e) => e.kind), ["rate-limited"]);
  assert.match(ev[0].text, /resumed after a rate limit 3 times/);
  t.p.cleanup();
});

test("a reset past the cap, or no reset time, is an event at once", () => {
  const far = setup([{ statuses: ["done"], read: { lastText: null, signal: "hit your session limit - resets 11:00pm (UTC)" } }], { maxWaitHours: 6 });
  start(far.ctx);
  assert.equal(watchLoop(far.ctx, { ...opts(far), maxWaitHours: 6 }).state, "rate-limited");
  assert.deepEqual(wake(far.ctx).map((e) => e.kind), ["rate-limited"]);
  assert.match(wake(far.ctx)[0].text, /past the 6h cap/);
  assert.equal(far.binding.calls.some((c) => c.call === "resume"), false);
  far.p.cleanup();
  const none = setup([{ statuses: ["done"], read: { lastText: null, signal: "API Error: 429 too many requests" } }]);
  start(none.ctx);
  watchLoop(none.ctx, opts(none));
  assert.deepEqual(wake(none.ctx).map((e) => e.kind), ["rate-limited"]);
  assert.match(wake(none.ctx)[0].text, /no reset time/);
  none.p.cleanup();
});

test("waiting is emitted once per question and the watch continues to done", () => {
  const q = { questions: [{ question: "A or B?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }] };
  const t = setup([{ statuses: ["waiting", "waiting", "waiting", "done"], read: { question: q, lastText: GREEN } }]);
  start(t.ctx);
  // the fake keeps `question` set; simulate the operator answering by clearing it after two waits
  const orig = t.binding.read.bind(t.binding);
  let reads = 0;
  t.binding.read = (ids) => { const h = orig(ids); if (++reads > 30) h.question = null; return h; };
  const r = watchLoop(t.ctx, opts(t));
  assert.equal(r.state, "done");
  const ev = wake(t.ctx);
  assert.equal(ev.filter((e) => e.kind === "waiting").length, 1);
  assert.equal(ev.find((e) => e.kind === "waiting").text, "asked with AskUserQuestion");
  assert.equal(ev.at(-1).kind, "done");
  t.p.cleanup();
});

test("gone is an event; the watch exits quietly when there is nothing to watch", () => {
  const t = setup([{ statuses: ["gone"] }]);
  start(t.ctx);
  assert.equal(watchLoop(t.ctx, opts(t)).state, "gone");
  assert.deepEqual(wake(t.ctx).map((e) => e.kind), ["gone"]);
  const idle = setup([]);
  assert.equal(watchLoop(idle.ctx, opts(idle)).state, "none");
  t.p.cleanup();
  idle.p.cleanup();
});

test("the watch survives a transient check failure and carries on", () => {
  const t = setup([{ statuses: ["running", "done"], read: { lastText: "STATUS: planned" } }]);
  start(t.ctx);
  const orig = t.binding.status.bind(t.binding);
  let calls = 0;
  t.binding.status = (ids) => { if (++calls === 1) throw new Error("registry read failed"); return orig(ids); };
  const r = watchLoop(t.ctx, opts(t));
  assert.equal(r.state, "done");
  assert.ok(t.logs.some((m) => /check failed \(1\/5\): registry read failed/.test(m)));
  assert.deepEqual(wake(t.ctx).map((e) => e.kind), ["done"]);
  t.p.cleanup();
});

test("five consecutive check failures: the watch emits an event and stops", () => {
  const t = setup([{ statuses: ["running"] }]);
  start(t.ctx);
  t.binding.status = () => { throw new Error("registry unreadable"); };
  const r = watchLoop(t.ctx, opts(t));
  assert.equal(r.ok, false);
  const { runId } = t.ctx.loadRun();
  const ev = wake(t.ctx);
  assert.equal(ev.length, 1);
  // The give-up is its own kind (v3 wrote the session's last outcome): the session may well be running still.
  assert.deepEqual([ev[0].kind, ev[0].runId, ev[0].phase, ev[0].key, ev[0].text], ["watcher-stopped", runId, "plan", `${runId}.1`, "watcher giving up: registry unreadable"]);
  assert.deepEqual(r.event, ev[0]);
  t.p.cleanup();
});

/** The judge reads the stopped session's stored block and decides in the gap between the watcher's two holds: the seam is
 *  the watcher's first hold once the stop is on file, which is its emit's, since its check stored the stop in the hold before. */
function decideBeforeEmit(t, judge, outcome) {
  const update = t.ctx.update;
  const seam = { decided: false };
  t.ctx.update = (fn) => {
    const run = judge.loadRun();
    if (!seam.decided && currentSession(run)?.outcome === outcome) {
      seam.decided = true;
      assert.equal(next(judge, "planned", { on: currentKey(run), because: "x" }).phase, "build");
    }
    return update(fn);
  };
  return seam;
}

test("a decision between the watcher's check and its emit: no event for the decided stretch, and the same watcher emits the next one's stop", () => {
  const t = setup([{ statuses: ["done"], read: { lastText: GREEN } }, { statuses: ["running", "done"], read: { lastText: "STATUS: code green\n<promise>X</promise>", turns: 9 } }]);
  const judge = makeCtx({ root: t.p.root, binding: t.binding, clock: t.clock });
  const { runId } = start(t.ctx);
  // `next` spawns no watcher for build while this one lives, between its check and its emit: this one has to watch it.
  const seam = decideBeforeEmit(t, judge, "done");
  const out = watchLoop(t.ctx, opts(t));
  assert.equal(seam.decided, true);
  assert.deepEqual([out?.state, out?.phase], ["done", "build"]);
  assert.deepEqual(wake(t.ctx).map((e) => e.key), [`${runId}.2`], "an await armed on build wakes on build's stop, never on plan's");
  assert.ok(t.logs.includes("the run moved on; watching its current stretch"), t.logs.join("\n"));
  t.p.cleanup();
});

test("a give-up emit that finds the run moved on keeps watching too", () => {
  // No reset time in the limit: the watcher gives up at once, and the decision lands before that emit.
  const t = setup([{ statuses: ["done"], read: { lastText: null, signal: "You've hit your limit" } }, { statuses: ["running", "done"], read: { lastText: "STATUS: code green\n<promise>X</promise>", turns: 9 } }]);
  const judge = makeCtx({ root: t.p.root, binding: t.binding, clock: t.clock });
  const { runId } = start(t.ctx);
  const seam = decideBeforeEmit(t, judge, "rate-limited");
  const out = watchLoop(t.ctx, opts(t));
  assert.equal(seam.decided, true);
  assert.deepEqual([out?.state, out?.phase], ["done", "build"]);
  assert.deepEqual(wake(t.ctx).map((e) => e.key), [`${runId}.2`]);
  assert.ok(t.logs.includes("the run moved on; watching its current stretch"), t.logs.join("\n"));
  t.p.cleanup();
});

test("await: a dead watcher under a live phase is respawned", () => {
  const p = tmpProject();
  const clock = new FakeClock();
  let spawns = 0;
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses: ["running"] }] }), clock, spawnWatcher: () => { spawns++; return true; }, watcherAlive: () => null });
  start(ctx);
  assert.equal(spawns, 1);
  const before = ctx.loadRun().sessions[0].watcherSpawns;
  const r = awaitEvent(ctx, { maxMinutes: 1, pollMs: 10_000 });
  assert.equal(r.state, "timeout");
  assert.ok(spawns > 1, `ensureWatcher was called ${spawns} times`);
  assert.ok(ctx.loadRun().sessions[0].watcherSpawns > before);
  p.cleanup();
});

test("await: returns on a new event, at once when the phase is past running, or times out", () => {
  const t = setup([{ statuses: ["running"] }]);
  start(t.ctx);
  let polls = 0;
  const origSleep = t.ctx.sleep;
  t.ctx.sleep = (ms) => {
    origSleep(ms);
    // A record event first: await sleeps through it, and wakes on the watcher's kind only.
    if (++polls === 2) t.ctx.update(() => t.ctx.event("noted", { runId: "x", phase: "plan", text: "not a wake" }));
    if (polls === 3) t.ctx.update(() => t.ctx.event("done", { runId: "x", phase: "plan", key: "x.1" }));
  };
  const r = awaitEvent(t.ctx, { maxMinutes: 60, pollMs: 10_000 });
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 1);
  assert.deepEqual([r.events[0].kind, r.events[0].runId, r.events[0].phase, r.events[0].key], ["done", "x", "plan", "x.1"]);
  assert.equal(polls, 3, "the record event did not wake it");
  t.ctx.sleep = origSleep;
  const to = awaitEvent(t.ctx, { maxMinutes: 1, pollMs: 10_000 });
  assert.deepEqual([to.ok, to.state, to.minutes], [false, "timeout", 1]);
  const run = t.ctx.loadRun();
  run.sessions[0].outcome = "done";
  save(t.ctx, run);
  const early = awaitEvent(t.ctx, { maxMinutes: 60, pollMs: 10_000 });
  assert.deepEqual([early.ok, early.events, early.reason], [true, [], "phase plan is done"]);
  t.p.cleanup();
});

test("await: a rate-limited stretch whose watcher is alive waits for the reset; with the watcher gone it returns at once", () => {
  const p = tmpProject();
  const clock = new FakeClock();
  let pid = 4242;
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses: ["running"] }] }), clock, watcherAlive: () => pid });
  start(ctx);
  const run = ctx.loadRun();
  Object.assign(run.sessions[0], { outcome: "rate-limited", rateLimit: { at: clock.now().toISOString(), resetAt: "2026-09-03T13:00:00.000Z" } });
  save(ctx, run);
  // The watcher sleeps through the wait and resumes on its own: an await that returned here would be re-armed and
  // return again, with no event in between.
  assert.deepEqual(awaitEvent(ctx, { maxMinutes: 1, pollMs: 10_000 }).state, "timeout");
  pid = null;
  const gone = awaitEvent(ctx, { maxMinutes: 60, pollMs: 10_000 });
  assert.deepEqual([gone.ok, gone.events, gone.reason], [true, [], "phase plan is rate-limited"]);
  // A human turn reached it: the watcher does not wait on an intervened stretch, so neither does await.
  pid = 4242;
  Object.assign(run.sessions[0], { intervened: true });
  save(ctx, run);
  const touched = awaitEvent(ctx, { maxMinutes: 60, pollMs: 10_000 });
  assert.deepEqual([touched.ok, touched.events, touched.reason], [true, [], "phase plan is rate-limited"]);
  p.cleanup();
});

test("status: a rate-limited stretch whose watcher is alive reads as running, as await and the board read it", () => {
  const p = tmpProject();
  const clock = new FakeClock();
  let pid = 4242;
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses: ["running"] }] }), clock, watcherAlive: () => pid });
  start(ctx);
  const run = ctx.loadRun();
  Object.assign(run.sessions[0], { outcome: "rate-limited", rateLimit: { at: clock.now().toISOString(), resetAt: "2026-09-03T13:00:00.000Z" } });
  save(ctx, run);
  // The watcher resumes it after the reset: the hint must not send the judge to decide (spec decision 15).
  const live = status(ctx);
  assert.equal(live.state, "running");
  assert.match(render("status", live), /^next: arm rider await \(background\) and stop$/m);
  // With the watcher gone, nobody resumes it: the stretch is the judge's (or the operator's) to decide.
  pid = null;
  assert.equal(status(ctx).state, "finished");
  // A human turn reached the session: check classifies it intervened, the watcher does not wait on it.
  pid = 4242;
  Object.assign(run.sessions[0], { intervened: true });
  save(ctx, run);
  assert.equal(status(ctx).state, "finished");
  // A stopped stretch is finished even while its watcher's pid lingers between its emit and its exit.
  Object.assign(run.sessions[0], { outcome: "done", intervened: false });
  save(ctx, run);
  assert.equal(status(ctx).state, "finished");
  p.cleanup();
});
