// test/watch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitEvent, watchLoop } from "../scripts/lib/watch.mjs";
import { start } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, makeCtx, tmpProject } from "./helpers.mjs";

const GREEN = "STATUS: planned\n<promise>MILESTONE PLANNED</promise>";
// A reset `min` minutes after the clock's CURRENT time. Successive limits in one scenario must use
// increasing offsets: a wall-clock time already passed parses as tomorrow (past the cap).
const limitSoon = (clock, min = 30) => { const t = new Date(clock.t + min * 60_000); return `You've hit your session limit - resets ${t.getUTCHours()}:${String(t.getUTCMinutes()).padStart(2, "0")} (UTC)`; };
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
  const ev = t.ctx.readEvents();
  assert.equal(ev.length, 1);
  assert.match(ev[0], /^2026-09-03T12:0\d:\d\d\.000Z done lemmaria\/[0-9a-f]{4} plan s1 STATUS: planned$/);
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
  assert.equal(t.ctx.readEvents().length, 1);
  assert.equal(t.binding.calls.filter((c) => c.call === "resume").length, 1);
  assert.ok(t.logs.some((m) => /rate limited; waiting/.test(m)));
  t.p.cleanup();
});

test("three resumes, then rate-limited is an event for the operator", () => {
  const t = setup([]);
  for (let i = 0; i < 5; i++) t.binding.s.scripts.push({ statuses: ["done"], read: { lastText: null, signal: limitSoon(t.clock, 30 + i * 30), turns: 1 + i } });
  start(t.ctx);
  const r = watchLoop(t.ctx, opts(t));
  assert.equal(r.state, "rate-limited");
  assert.equal(t.binding.calls.filter((c) => c.call === "resume").length, 3);
  assert.match(t.ctx.readEvents()[0], / rate-limited .* resumed after a rate limit 3 times/);
  t.p.cleanup();
});

test("a reset past the cap, or no reset time, is an event at once", () => {
  const far = setup([{ statuses: ["done"], read: { lastText: null, signal: "hit your session limit - resets 11:00pm (UTC)" } }], { maxWaitHours: 6 });
  start(far.ctx);
  assert.equal(watchLoop(far.ctx, { ...opts(far), maxWaitHours: 6 }).state, "rate-limited");
  assert.match(far.ctx.readEvents()[0], /past the 6h cap/);
  assert.equal(far.binding.calls.some((c) => c.call === "resume"), false);
  far.p.cleanup();
  const none = setup([{ statuses: ["done"], read: { lastText: null, signal: "API Error: 429 too many requests" } }]);
  start(none.ctx);
  watchLoop(none.ctx, opts(none));
  assert.match(none.ctx.readEvents()[0], /no reset time/);
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
  const ev = t.ctx.readEvents();
  assert.equal(ev.filter((l) => / waiting /.test(l)).length, 1);
  assert.equal(ev.at(-1).includes(" done "), true);
  t.p.cleanup();
});

test("gone is an event; the watch exits quietly when there is nothing to watch", () => {
  const t = setup([{ statuses: ["gone"] }]);
  start(t.ctx);
  assert.equal(watchLoop(t.ctx, opts(t)).state, "gone");
  assert.match(t.ctx.readEvents()[0], / gone /);
  const idle = setup([]);
  assert.equal(watchLoop(idle.ctx, opts(idle)).state, "none");
  t.p.cleanup();
  idle.p.cleanup();
});

test("await: returns on a new event, at once when the phase is past running, or times out", () => {
  const t = setup([{ statuses: ["running"] }]);
  start(t.ctx);
  let polls = 0;
  const origSleep = t.ctx.sleep;
  t.ctx.sleep = (ms) => { origSleep(ms); if (++polls === 3) t.ctx.appendEvent(["done", "lemmaria/x", "plan", "s1"]); };
  const r = awaitEvent(t.ctx, { maxMinutes: 60, pollMs: 10_000 });
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 1);
  assert.match(r.events[0], / done lemmaria\/x plan s1$/);
  t.ctx.sleep = origSleep;
  const to = awaitEvent(t.ctx, { maxMinutes: 1, pollMs: 10_000 });
  assert.deepEqual([to.ok, to.state, to.minutes], [false, "timeout", 1]);
  const run = t.ctx.loadRun();
  run.sessions[0].outcome = "done";
  t.ctx.saveRun(run);
  const early = awaitEvent(t.ctx, { maxMinutes: 60, pollMs: 10_000 });
  assert.deepEqual([early.ok, early.events, early.reason], [true, [], "phase plan is done"]);
  t.p.cleanup();
});
