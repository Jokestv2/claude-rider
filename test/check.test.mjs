// test/check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESUME_NUDGE } from "../scripts/bindings/claude-code.mjs";
import { check } from "../scripts/lib/check.mjs";
import { renderCheck } from "../scripts/lib/render.mjs";
import { next, resume, start } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, makeCtx, save, settled, tmpProject } from "./helpers.mjs";

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
  assert.equal(settled(check, ctx).state, "done");
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
  // Only what was observed: whether the message asks for anything is the judge's reading, not check's.
  assert.match(r2.doneReason, /registry reports the session waiting for input; no AskUserQuestion is pending/);
  assert.doesNotMatch(r2.doneReason, /asked/);
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
  const run = ctx.loadRun(); run.sessions[0].baselineTurns = 12; save(ctx, run); // what `resume` records
  assert.equal(check(ctx).state, "running");
  assert.equal(check(ctx).state, "running");
  assert.equal(binding.calls.filter((c) => c.call === "stop").length, 0);
  p.cleanup();
});

test("no STATUS line: a rate limit (with its reset) vs an API error", () => {
  const a = setup([{ statuses: ["done"], read: { lastText: null, signal: "You've hit your session limit - resets 1:40am (UTC)" } }]);
  const r = settled(check, a.ctx);
  assert.equal(r.state, "rate-limited");
  assert.equal(r.rateLimit.resetAt, "2026-09-04T01:40:00.000Z");
  a.p.cleanup();
  const b = setup([{ statuses: ["done"], read: { lastText: null, signal: "API Error: 529 overloaded" } }]);
  const r2 = settled(check, b.ctx);
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
  const r = settled(check, ctx);
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

test("after a resume the nudge is dropped by identity, not by position", () => {
  // Chronological order in a resumed chain: launch, whatever the operator typed in stretch one, then
  // the rider's nudge. Dropping a fixed prefix would keep the nudge and hide the operator's turn.
  const launch = { at: "t0", origin: "human", bytes: 9, text: "Prompt A…", truncated: false, nudge: false };
  const typed = { at: "t1", origin: "human", bytes: 14, text: "actually, stop", truncated: false, nudge: false };
  const nudge = { at: "t2", origin: "human", bytes: RESUME_NUDGE.length, text: RESUME_NUDGE, truncated: false, nudge: true };
  const p = tmpProject();
  const binding = new FakeBinding({ script: [
    { statuses: ["done"], read: { lastText: null, signal: "API Error: 429 rate limit exceeded - resets 1:40am (UTC)", turns: 20, userTurns: 2, userTurnDetails: [launch, typed] } },
    { statuses: ["done"], read: { lastText: GREEN, turns: 35, userTurns: 3, userTurnDetails: [launch, typed, nudge] } },
  ] });
  const ctx = makeCtx({ root: p.root, binding });
  try {
    start(ctx);
    // The operator typed in this stretch, so it reads intervened over its rate-limited outcome.
    const first = settled(check, ctx);
    assert.deepEqual([first.state, first.outcome], ["intervened", "rate-limited"]);
    resume(ctx, { on: first.key, reason: "rate-limit" });
    const r = check(ctx);
    assert.equal(r.resumes, 1);
    assert.equal(r.humanTurns, 1, "launch and one nudge subtracted from three counted turns");
    assert.deepEqual(r.humanTurnDetails, [typed], "the operator's turn, not the nudge that follows it");
    const out = renderCheck(r);
    assert.match(out, /actually, stop/);
    assert.doesNotMatch(out, /Your previous turn was interrupted/);
    assert.doesNotMatch(out, /Prompt A/);
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
  const run = { rider: "lemmaria", runId: "ab12", startedAt: "2026-09-03T12:00:00.000Z", baseBranch: null, phase: "merge", visits: { merge: 1 }, transitions: [], sessions: [{ phase: "close", cost: 2, outcome: "done" }], notes: [] };
  save(ctx, run);
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

test("workBranch is sticky and reaches the declared commands", () => {
  let head = "main";
  // `setup` calls start(ctx), so override ctx.branch before the run is created: newRun records the base.
  const p = tmpProject();
  const binding = new FakeBinding({ script: [{ statuses: ["running"] }, { statuses: ["done"], read: { lastText: GREEN } }] });
  const ctx = makeCtx({ root: p.root, binding });
  ctx.branch = () => head;
  try {
    start(ctx);
    assert.equal(ctx.loadRun().baseBranch, "main");

    head = "feature/r4-grounding";
    check(ctx);
    assert.equal(ctx.loadRun().workBranch, "feature/r4-grounding");

    head = "main"; // the operator checks out the base to merge
    check(ctx);
    assert.equal(ctx.loadRun().workBranch, "feature/r4-grounding", "sticky — not cleared");

    assert.equal(ctx.shellOpts(ctx.loadRun()).env.RIDER_WORK_BRANCH, "feature/r4-grounding");
    assert.equal(ctx.shellOpts(ctx.loadRun()).env.RIDER_BASE_BRANCH, "main");
  } finally { p.cleanup(); }
});

test("the stopped path records workBranch too: a phase already done at its first check", () => {
  let head = "main";
  const p = tmpProject();
  // `read.turns` must be past the launch baseline (0), or `check` demotes this `done` back to `running`
  // inside the done-grace window and the stopped path — the one under test — is never reached.
  const binding = new FakeBinding({ script: [{ statuses: ["done"], read: { lastText: GREEN, turns: 5 } }] });
  const ctx = makeCtx({ root: p.root, binding });
  ctx.branch = () => head;
  try {
    start(ctx);
    head = "feature/r4-grounding"; // the phase created the branch and finished before the first check
    assert.equal(check(ctx).state, "done", "the first check must classify as stopped, not running");
    assert.equal(ctx.loadRun().workBranch, "feature/r4-grounding");
  } finally { p.cleanup(); }
});

// Run 7cb5, close phase: the session ended its turn to wait for its `tests/p1` subagent, as the system-prompt
// append says is safe. The watcher's poll landed in the two seconds between the subagent's completion being
// queued and the harness waking the session; the registry entry read `status: idle, state: working`, check
// called it `done`, and the live session was stopped mid-hand-back.
test("7cb5: one idle sample between a subagent finishing and the session waking does not stop it", () => {
  const { ctx, binding, p } = setup([{ statuses: [{ kind: "done", entry: { status: "idle", state: "working" } }, "running", "done"], read: { turns: 40, lastText: "Dispatched the tests/p1 subagent; ending my turn until it reports." } }]);
  const orig = binding.read.bind(binding);
  const later = [{}, { turns: 46, lastText: "The subagent is back; verifying its fixtures." }, { turns: 60, lastText: GREEN }];
  let at = 0;
  binding.read = (ids) => ({ ...orig(ids), ...later[at] });
  try {
    const first = check(ctx);
    assert.equal(first.state, "running");
    assert.match(first.note, /idle with no STATUS line/);
    assert.equal(binding.calls.some((c) => c.call === "stop"), false, "a live session is not stopped on one sample");
    at = 1;
    assert.equal(check(ctx).state, "running");
    assert.equal(ctx.loadRun().sessions[0].bareDone, null, "the sighting is forgotten once the session is seen working again");
    at = 2;
    const r = check(ctx);
    assert.deepEqual([r.state, r.statusHint], ["done", "STATUS: planned"]);
    assert.equal(binding.calls.filter((c) => c.call === "stop").length, 1);
  } finally { p.cleanup(); }
});

test("a bare done that stays put is believed, stopped exactly once, and says why it has no hint", () => {
  const { ctx, binding, p } = setup([{ statuses: [{ kind: "done", entry: { status: "idle", state: "done" } }], read: { turns: 9, lastText: "I had a think." } }]);
  try {
    // The registry calling it `state: done` buys no shortcut: the second look is what confirms it.
    const first = check(ctx);
    assert.deepEqual([first.state, first.note], ["running", "idle with no STATUS line; confirming on the next check"]);
    assert.equal(binding.calls.some((c) => c.call === "stop"), false);
    const r = check(ctx);
    assert.equal(r.state, "done");
    assert.match(r.doneReason, /no STATUS line/);
    assert.equal(binding.calls.filter((c) => c.call === "stop").length, 1);
    assert.equal(check(ctx).state, "done", "and it stays believed: the stored block, no second stop");
    assert.equal(binding.calls.filter((c) => c.call === "stop").length, 1);
  } finally { p.cleanup(); }
});

test("a confirming look starts over when the transcript moved in between", () => {
  // Two bare-done samples are only corroboration if nothing happened between them. The count is kept by
  // check itself, whatever the policy then makes of it.
  const { ctx, binding, p } = setup([{ statuses: ["done"], read: { turns: 9, lastText: "thinking" } }]);
  const orig = binding.read.bind(binding);
  let turns = 9;
  binding.read = (ids) => ({ ...orig(ids), turns });
  try {
    const run = ctx.loadRun();
    run.sessions[0].bareDone = { turns: 9, sightings: 1 }; // what a first, unconfirmed sighting leaves behind
    save(ctx, run);
    turns = 12;
    assert.equal(check(ctx).state, "running", "the second look in a row, but not over the same transcript");
    assert.deepEqual(ctx.loadRun().sessions[0].bareDone, { turns: 12, sightings: 1 }, "a moved transcript is a first sighting again");
    assert.equal(check(ctx).state, "done");
  } finally { p.cleanup(); }
});

test("what a session ran under is recorded at its stop and shown in the block", () => {
  const harness = { version: "2.1.277", effort: "xhigh", advisorModel: "claude-opus-5", outputStyle: "Learning" };
  const { ctx, p } = setup([{ statuses: ["done"], read: { lastText: GREEN, turns: 5, harness } }]);
  try {
    const r = check(ctx);
    assert.deepEqual(r.harness, harness);
    assert.deepEqual(ctx.loadRun().sessions[0].harness, harness, "on the run record: runs/*.json is what gets compared across runs");
    assert.match(renderCheck(r), /\nran under: version 2\.1\.277 · effort xhigh · advisorModel claude-opus-5 · outputStyle Learning\n/);
    // A binding that reports nothing prints nothing: the line is the binding's facts, not a template.
    assert.doesNotMatch(renderCheck({ ...r, harness: null }), /ran under/);
  } finally { p.cleanup(); }
});

test("the work tip travels with the work branch, follows it at the human phase, and outlives it", () => {
  let head = "main";
  const tips = { HEAD: "aaa1", "refs/heads/feature/v1": "aaa1" };
  const asked = [];
  const p = tmpProject();
  const binding = new FakeBinding({ script: [{ statuses: ["done"], read: { lastText: "STATUS: gate green\n<promise>X</promise>", turns: 5 } }] });
  const ctx = makeCtx({ root: p.root, binding });
  ctx.branch = () => head;
  ctx.tip = (ref) => tips[ref] ?? null;
  ctx.commitsBetween = (from, to) => { asked.push([from, to]); return ["bbb2 fix: found while driving scenario 3"]; };
  try {
    start(ctx, { phase: "close" });
    head = "feature/v1";
    const { key } = check(ctx);
    assert.equal(ctx.loadRun().workTip, "aaa1");
    assert.equal(ctx.shellOpts(ctx.loadRun()).env.RIDER_WORK_TIP, "aaa1");

    next(ctx, "gate green", { on: key, because: "gate record closed" });
    assert.deepEqual(ctx.loadRun().handoff, { phase: "merge", at: ctx.loadRun().handoff.at, tip: "aaa1" });

    // The operator fixes something on the branch during gate review: the tip to merge moves with it.
    tips["refs/heads/feature/v1"] = "bbb2";
    head = "main";
    assert.equal(check(ctx).state, "human");
    assert.equal(ctx.loadRun().workTip, "bbb2");

    // Merged, and the branch deleted: a check by name would exit 128 for ever; the last sighting stands.
    delete tips["refs/heads/feature/v1"];
    writeFileSync(join(p.root, "merged.flag"), "");
    assert.equal(check(ctx).state, "none");
    const ended = ctx.lastEndedRun();
    assert.equal(ended.workTip, "bbb2");
    assert.deepEqual(asked, [["aaa1", "main"]], "read from the base once the branch is gone");
    assert.deepEqual(ended.handoff.after, { ref: "main", commits: ["bbb2 fix: found while driving scenario 3"] });
  } finally { p.cleanup(); }
});
