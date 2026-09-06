// test/check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../scripts/lib/check.mjs";
import { renderCheck } from "../scripts/lib/render.mjs";
import { start } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, makeCtx, tmpProject } from "./helpers.mjs";

const GREEN = "Plan is committed.\nSTATUS: planned\n<promise>MILESTONE PLANNED</promise>";
function setup(script, extra = {}) {
  const p = tmpProject();
  const binding = new FakeBinding({ script });
  const clock = new FakeClock();
  const ctx = makeCtx({ root: p.root, binding, clock, ...extra });
  start(ctx);
  return { p, binding, clock, ctx };
}

test("no run → none", () => {
  const p = tmpProject();
  assert.equal(check(makeCtx({ root: p.root, binding: new FakeBinding() })).state, "none");
  p.cleanup();
});

test("running: nothing to judge, no evidence, watcher respawned if dead", () => {
  let spawns = 0;
  const { ctx, p } = setup([{ statuses: ["running"] }], { spawnWatcher: () => { spawns++; return true; } });
  const r = check(ctx);
  assert.equal(r.state, "running");
  assert.deepEqual(r.evidence, []);
  assert.equal(spawns, 2); // once at start, once by check (watcherAlive is stubbed to null)
  p.cleanup();
});

test("done: stop, harvest, log, status hint, evidence, legal labels; a second check prints the stored block", () => {
  const { ctx, binding, p } = setup([{ statuses: ["done"], read: { lastText: GREEN, cost: 10, turns: 40 } }]);
  const r = check(ctx);
  assert.equal(r.state, "done");
  assert.equal(r.statusHint, "STATUS: planned");
  assert.equal(r.cost, 10);
  assert.equal(r.turns, 40);
  assert.equal(r.finalText, GREEN);
  assert.equal(binding.calls.filter((c) => c.call === "stop").length, 1);
  assert.deepEqual(r.evidence.map((e) => [e.cmd, e.status, e.output]), [["echo evidence-ok", 0, "evidence-ok"]]);
  assert.deepEqual(r.labels.map((l) => l.label), ["planned", "blocked", "resume", "operator"]);
  assert.match(r.log, /-plan-s1\.json$/);
  const again = check(ctx);
  assert.equal(again.state, "done");
  assert.equal(again.finalText, GREEN);
  assert.equal(binding.calls.filter((c) => c.call === "stop").length, 1);
  p.cleanup();
});

test("idle before the first new turn is still running; after ten minutes it is done", () => {
  const { ctx, clock, p } = setup([{ statuses: ["done"], read: { turns: 0, lastText: null } }]);
  assert.equal(check(ctx).state, "running");
  clock.t += 11 * 60_000;
  assert.equal(check(ctx).state, "done");
  p.cleanup();
});

test("gone needs two sightings", () => {
  const { ctx, p } = setup([{ statuses: ["gone"] }]);
  const first = check(ctx);
  assert.equal(first.state, "running");
  assert.match(first.note, /not listed once/);
  assert.equal(check(ctx).state, "gone");
  assert.equal(ctx.loadRun().sessions[0].outcome, "gone");
  p.cleanup();
});

test("a session the registry stopped listing is not gone while its transcript advances", () => {
  const { ctx, binding, p } = setup([{ statuses: ["running", "gone"], read: { turns: 5, lastText: "working" } }]);
  const orig = binding.read.bind(binding);
  let extra = 0;
  binding.read = (ids) => { const h = orig(ids); h.turns = 5 + extra++; return h; };
  assert.equal(check(ctx).state, "running"); // records turns 5
  const second = check(ctx);
  assert.equal(second.state, "running");
  assert.match(second.note, /transcript advanced/);
  assert.equal(ctx.loadRun().sessions[0].goneSightings, 0);
  assert.equal(check(ctx).state, "running");
  assert.equal(ctx.loadRun().sessions[0].goneSightings, 0);
  p.cleanup();
});

test("two gone sightings with a static transcript are still gone", () => {
  const { ctx, p } = setup([{ statuses: ["running", "gone"], read: { turns: 5, lastText: "working" } }]);
  assert.equal(check(ctx).state, "running");
  assert.match(check(ctx).note, /not listed once/);
  assert.equal(check(ctx).state, "gone");
  p.cleanup();
});

test("waiting carries the question; a STATUS line with no question is done", () => {
  const q = { questions: [{ question: "A or B?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }] };
  const a = setup([{ statuses: ["waiting"], read: { question: q, lastText: "Which?" } }]);
  const r = check(a.ctx);
  assert.equal(r.state, "waiting");
  assert.equal(r.question.questions[0].question, "A or B?");
  assert.equal(a.ctx.loadRun().sessions[0].questionRelayed, true);
  assert.equal(a.binding.calls.some((c) => c.call === "stop"), false);
  a.p.cleanup();
  const b = setup([{ statuses: ["waiting"], read: { question: null, lastText: "STATUS: planned\nShall I continue?" } }]);
  const r2 = check(b.ctx);
  assert.equal(r2.state, "done");
  assert.match(r2.doneReason, /asked in prose/);
  b.p.cleanup();
});

test("a busy session that signed off with no new turn across two checks is done", () => {
  const { ctx, binding, p } = setup([{ statuses: ["running"], read: { lastText: GREEN, turns: 12 } }]);
  assert.equal(check(ctx).state, "running");
  const r = check(ctx);
  assert.equal(r.state, "done");
  assert.match(r.doneReason, /holds the process open/);
  assert.equal(binding.calls.filter((c) => c.call === "stop").length, 1);
  p.cleanup();
});

test("a resumed stretch does not sign off on the previous stretch's text", () => {
  const { ctx, binding, p } = setup([{ statuses: ["running"], read: { lastText: GREEN, turns: 12 } }]);
  const run = ctx.loadRun(); run.sessions[0].baselineTurns = 12; ctx.saveRun(run); // what `resume` records
  assert.equal(check(ctx).state, "running");
  assert.equal(check(ctx).state, "running");
  assert.equal(binding.calls.filter((c) => c.call === "stop").length, 0);
  p.cleanup();
});

test("no STATUS line: a rate limit (with its reset) vs an API error", () => {
  const a = setup([{ statuses: ["done"], read: { lastText: null, signal: "You've hit your session limit - resets 1:40am (UTC)" } }]);
  const r = check(a.ctx);
  assert.equal(r.state, "rate-limited");
  assert.equal(r.rateLimit.resetAt, "2026-09-04T01:40:00.000Z");
  a.p.cleanup();
  const b = setup([{ statuses: ["done"], read: { lastText: null, signal: "API Error: 529 overloaded" } }]);
  const r2 = check(b.ctx);
  assert.equal(r2.state, "done");
  assert.match(r2.doneReason, /API error \(HTTP 529\)/);
  assert.equal(r2.statusHint, null);
  b.p.cleanup();
});

test("a STATUS line wins: the rate-limit classifier is consulted only when there is no hint", () => {
  const { ctx, p } = setup([{ statuses: ["done"], read: { lastText: "Documented the rate limits we hit.\nSTATUS: planned\n<promise>X</promise>" } }]);
  const r = check(ctx);
  assert.equal(r.state, "done");
  assert.equal(r.statusHint, "STATUS: planned");
  assert.equal(r.rateLimit, null);
  p.cleanup();
});

test("the reset is anchored at the transcript's last turn, not at check time", () => {
  // the judge was down for hours: a reset that has already passed must not parse as tomorrow
  const { ctx, p } = setup([{ statuses: ["done"], read: { lastText: null, signal: "You've hit your session limit - resets 1:40am (UTC)", lastAt: "2026-09-03T01:00:00.000Z" } }]);
  const r = check(ctx);
  assert.equal(r.state, "rate-limited");
  assert.equal(r.rateLimit.resetAt, "2026-09-03T01:40:00.000Z");
  p.cleanup();
});

test("human turns after the launch prompt mean intervened", () => {
  const { ctx, p } = setup([{ statuses: ["done"], read: { lastText: GREEN, userTurns: 2 } }]);
  const r = check(ctx);
  assert.equal(r.state, "intervened");
  assert.equal(r.outcome, "done");
  assert.equal(r.humanTurns, 1);
  p.cleanup();
});

test("the launch prompt is never shown as an intervention", () => {
  // Two counted turns, launch first: humanTurns is 1 and the list holds only the second.
  const details = [
    { at: "t0", origin: "human", bytes: 9, text: "Prompt A…", truncated: false },
    { at: "t1", origin: "human", bytes: 4, text: "stop", truncated: false },
  ];
  const { ctx, p } = setup([{ statuses: ["done"], read: { lastText: GREEN, userTurns: 2, userTurnDetails: details } }]);
  try {
    const r = check(ctx);
    assert.equal(r.humanTurns, 1);
    assert.deepEqual(r.humanTurnDetails, [details[1]], "the launch prompt is dropped, not shown");
    assert.match(renderCheck(r), /1 turn after launch/);
    assert.doesNotMatch(renderCheck(r), /Prompt A/);
  } finally { p.cleanup(); }
});

test("a live session the operator typed into is still running: intervened is a stop-time outcome", () => {
  const { ctx, p } = setup([{ statuses: ["running"], read: { userTurns: 3, lastText: "still working" } }]);
  const r = check(ctx);
  assert.equal(r.state, "running");
  assert.equal(r.humanTurns, 2);
  assert.equal(ctx.loadRun().sessions[0].intervened, true);
  p.cleanup();
});

test("at a human phase: check fails → human with show; check passes → the run ends", () => {
  const p = tmpProject();
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding() });
  const run = { rider: "lemmaria", runId: "ab12", startedAt: "2026-09-03T12:00:00.000Z", branch: null, phase: "merge", visits: { merge: 1 }, transitions: [], sessions: [{ phase: "close", cost: 2, outcome: "done" }], notes: [] };
  ctx.saveRun(run);
  const r = check(ctx);
  assert.equal(r.state, "human");
  assert.equal(r.check, "test -f merged.flag");
  assert.equal(r.show, "SHOW-OUTPUT");
  assert.equal(r.totalCost, 2);
  writeFileSync(join(p.root, "merged.flag"), "");
  const r2 = check(ctx);
  assert.equal(r2.state, "none");
  assert.deepEqual(r2.ended, { runId: "ab12", phase: "merge", reason: "merge: check passed (test -f merged.flag)" });
  assert.equal(ctx.loadRun(), null);
  assert.equal(ctx.lastEndedRun().endedBy, "done");
  p.cleanup();
});
