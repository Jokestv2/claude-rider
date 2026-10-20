// test/check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESUME_NUDGE } from "../scripts/bindings/claude-code.mjs";
import { check } from "../scripts/lib/check.mjs";
import { failingOf } from "../scripts/lib/await.mjs";
import { render, renderCheck } from "../scripts/lib/render.mjs";
import { next, resume, start, status } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { AWAIT_PROMPTS, AWAIT_RIDER_MD, FakeClock, REQUIRES_RIDER_MD, TEST_RIDER_MD, makeCtx, requiring, save, settled, tmpProject } from "./helpers.mjs";

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

/** Plan's stretch on `riderMd`, scripted as `statuses` and not yet checked; plan has no requires of its own. */
function planOn(t, riderMd, { statuses = ["done"], local = {} } = {}) {
  const p = tmpProject({ riderMd });
  t.after(p.cleanup);
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses, read: { lastText: GREEN, turns: 5 } }] }), local });
  start(ctx);
  return { ctx, flag: (name) => join(p.root, name) };
}

test("a decidable block annotates labels whose target's requires fails", (t) => {
  const { ctx, flag } = planOn(t, REQUIRES_RIDER_MD);
  const r = check(ctx);
  assert.equal(r.state, "done");
  assert.deepEqual(r.requires, [{ label: "planned", to: "build", ok: false, cmd: "test -f ok.flag", status: 1, firstLine: "" }]);
  assert.match(r.decideWith, /--on [0-9a-f]{4}\.1 --because "…" {5}\(labels: planned ✗ · blocked · resume · operator\)$/);
  // Information, never a refusal (§5.3): the next check reads the condition as it is then.
  writeFileSync(flag("ok.flag"), "");
  const again = check(ctx);
  assert.deepEqual(again.requires, [{ label: "planned", to: "build", ok: true, cmd: null, status: null, firstLine: null }]);
  assert.match(again.decideWith, /\(labels: planned · blocked · resume · operator\)$/);
});

test("every edge to a phase gets an entry, in the order declared, with the first line of a failure's output", (t) => {
  const md = requiring("build", ["test -d riders", "echo over budget; echo detail; exit 3"], TEST_RIDER_MD.replace("edges: { planned: build, blocked: operator }", "edges: { planned: build, skip: close, blocked: operator }"));
  const { ctx } = planOn(t, md);
  const r = check(ctx);
  assert.deepEqual(r.requires, [
    { label: "planned", to: "build", ok: false, cmd: "echo over budget; echo detail; exit 3", status: 3, firstLine: "over budget" },
    { label: "skip", to: "close", ok: true, cmd: null, status: null, firstLine: null },
  ]);
  assert.match(r.decideWith, /\(labels: planned ✗ · skip · blocked · resume · operator\)$/);
});

test("a rider with no requires on any edge's target gets no annotation", (t) => {
  const { ctx } = planOn(t, TEST_RIDER_MD);
  const r = check(ctx);
  assert.equal(r.state, "done");
  assert.equal("requires" in r, false);
  assert.match(r.decideWith, /\(labels: planned · blocked · resume · operator\)$/);
});

test("a running stretch runs no requires", (t) => {
  const { ctx, flag } = planOn(t, requiring("build", ["touch ran.flag"]), { statuses: ["running"] });
  const r = check(ctx);
  assert.equal(r.state, "running");
  assert.equal("requires" in r, false);
  assert.equal(existsSync(flag("ran.flag")), false);
});

test("the watcher's check runs no requires; the judge's does", (t) => {
  const { ctx, flag } = planOn(t, requiring("build", ["touch ran.flag"]));
  const w = check(ctx, { readouts: false });
  assert.equal(w.state, "done");
  assert.equal("requires" in w, false);
  assert.equal(existsSync(flag("ran.flag")), false, "readouts: false runs none of it (§5.3)");
  assert.deepEqual(check(ctx).requires, [{ label: "planned", to: "build", ok: true, cmd: null, status: null, firstLine: null }]);
  assert.equal(existsSync(flag("ran.flag")), true);
});

test("the requires readout runs after the lock is released", (t) => {
  // Inside the hold the lock file exists, so this requirement would fail there.
  const { ctx } = planOn(t, requiring("build", ["test ! -e .rider/lemmaria/default/lock"]));
  assert.equal(check(ctx).requires[0].ok, true);
});

test("a requires that hangs reads timed out in the readout", (t) => {
  // The cap is lowered for the test only; `sleep 3` keeps the orphan a timed-out shell leaves short.
  const { ctx } = planOn(t, requiring("build", ["sleep 3"]), { local: { requiresTimeoutMs: 300 } });
  assert.deepEqual(check(ctx).requires, [{ label: "planned", to: "build", ok: false, cmd: "sleep 3", status: -1, firstLine: "", timedOut: true }]);
});

/** A run entered at the await fixture's wait (or `md`'s). The watcher's spawns and the await checks are counted: `check`
 *  must never run the check (§7.3), so `n.checks` stays 0. `alive` is what `watcherAlive` answers. */
function waitOn(t, { md = AWAIT_RIDER_MD, alive = null, local = {} } = {}) {
  const p = tmpProject({ riderMd: md, prompts: AWAIT_PROMPTS });
  t.after(p.cleanup);
  const n = { spawns: 0, checks: 0 };
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding(), local, watcherAlive: () => alive, spawnWatcher: () => { n.spawns++; return true; }, runCheck: () => { n.checks++; return { status: 0, timedOut: false, output: "", error: null }; } });
  const { key } = start(ctx, { phase: "wait" });
  return { ctx, n, key, flag: (name) => join(p.root, name) };
}
/** What the watcher's polls would have stored (Task 9 polls; these tests set it by hand). */
function stored(ctx, fields) {
  const run = ctx.loadRun();
  Object.assign(run.sessions.at(-1), fields);
  save(ctx, run);
}
const READY = { outcome: "ready", polls: 3, lastPollAt: "2026-09-03T12:02:00.000Z", lastExit: 0, lastOutput: "3/3 jobs settled", readyAt: "2026-09-03T12:02:00.000Z" };

test("rider check never runs an await phase's check", (t) => {
  // Nor anything else while it awaits: a show, the evidence and an edge target's requires would all leave a flag (§7.5).
  const md = requiring("review", ["touch required.flag"], AWAIT_RIDER_MD.replace("check: test -f ready.flag || exit 75", "check: touch ran.flag; exit 75").replace("show: echo SHOW-WAIT", "show: touch shown.flag"));
  const { ctx, n, key, flag } = waitOn(t, { md });
  const r = check(ctx);
  assert.deepEqual([r.state, r.kind, r.key, r.phase, r.visit], ["awaiting", "await", key, "wait", 1]);
  assert.equal(existsSync(flag("ran.flag")), false);
  assert.equal(n.checks, 0, "nor through the runner: the watcher alone polls (§7.3)");
  assert.deepEqual([r.show, r.evidence, r.decideWith, "requires" in r], [null, [], null, false]);
  assert.deepEqual([existsSync(flag("shown.flag")), existsSync(flag("required.flag"))], [false, false]);
  assert.deepEqual(r.wait, status(ctx).wait, "the wait as status reads it");
  assert.match(render("check", r).split("\n")[0], new RegExp(`^rider lemmaria/default/${r.runId} · phase wait · visit 1 · awaiting since 2026-09-03T12:00:00\\.000Z \\(0m\\) · 0 polls$`));
});

test("a ready block carries show, evidence and the decide-with line", (t) => {
  const { ctx, n, key } = waitOn(t);
  stored(ctx, READY);
  const r = check(ctx);
  assert.deepEqual([r.state, r.kind, r.key, r.checkOutput, r.showCmd], ["ready", "await", key, "3/3 jobs settled", "echo SHOW-WAIT"]);
  assert.equal(r.show, "SHOW-WAIT");
  assert.deepEqual(r.evidence.map((e) => [e.cmd, e.status, e.output]), [["echo evidence-ok", 0, "evidence-ok"]]);
  assert.deepEqual(r.labels.map((l) => l.label), ["settled", "timed out", "operator"]);
  assert.ok(r.decideWith.endsWith(`--on ${key} --because "…"     (labels: settled · timed out · operator)`), r.decideWith);
  assert.deepEqual([r.wait.readyAt, r.elapsedMs, n.checks], [READY.readyAt, 2 * 60_000, 0]);
  assert.match(render("check", r), /\ndecide with: {2}rider next <label> --on [0-9a-f]{4}\.1 /);
  // A timed-out wait is decided the same way: the deadline is no verdict on anyone's work (§7.2).
  stored(ctx, { outcome: "timed-out", readyAt: null, timedOutAt: "2026-09-03T14:00:00.000Z", lastExit: 75 });
  const late = check(ctx);
  assert.deepEqual([late.state, late.show, late.evidence.length, late.elapsedMs], ["timed-out", "SHOW-WAIT", 1, 2 * 3_600_000]);
  assert.ok(late.decideWith.endsWith("(labels: settled · timed out · operator)"), late.decideWith);
});

test("an awaiting check respawns a dead watcher and counts it on the wait", (t) => {
  const { ctx, n } = waitOn(t);
  assert.deepEqual([n.spawns, ctx.loadRun().sessions[0].watcherSpawns], [1, 1], "start's");
  check(ctx);
  assert.deepEqual([n.spawns, ctx.loadRun().sessions[0].watcherSpawns], [2, 2]);
  // Every check that finds none alive: a wait has no session that a registry could stop listing.
  assert.equal(check(ctx).state, "awaiting");
  assert.deepEqual([n.spawns, ctx.loadRun().sessions[0].watcherSpawns], [3, 3]);
  // A live watcher is left alone, and a decided wait has nothing left to watch.
  check(makeCtx({ root: ctx.root, binding: ctx.binding, watcherAlive: () => 4242, spawnWatcher: () => { n.spawns++; return true; } }));
  stored(ctx, READY);
  check(ctx);
  assert.deepEqual([n.spawns, ctx.loadRun().sessions[0].watcherSpawns], [3, 3]);
});

test("a decided wait's block marks a label whose target's requires fails", (t) => {
  const { ctx, flag } = waitOn(t, { md: requiring("review", ["test -f ok.flag"], AWAIT_RIDER_MD) });
  stored(ctx, READY);
  const r = check(ctx);
  // `timed out` leads to operator, which is no phase and has no requires.
  assert.deepEqual(r.requires, [{ label: "settled", to: "review", ok: false, cmd: "test -f ok.flag", status: 1, firstLine: "" }]);
  assert.ok(r.decideWith.endsWith("(labels: settled ✗ · timed out · operator)"), r.decideWith);
  writeFileSync(flag("ok.flag"), "");
  assert.ok(check(ctx).decideWith.endsWith("(labels: settled · timed out · operator)"));
});

test("an awaiting wait at the failure threshold reads failing; a decided one never does", (t) => {
  const { ctx } = waitOn(t, { local: { awaitCheckFailures: 2 } });
  stored(ctx, { polls: 2, lastExit: 127, lastOutput: "sh: tool: not found", failures: 2, failingSince: "2026-09-03T12:01:00.000Z" });
  const r = check(ctx);
  assert.deepEqual([r.state, r.wait.failing, r.wait.failures, r.wait.failingSince], ["awaiting", true, 2, "2026-09-03T12:01:00.000Z"]);
  assert.equal(r.wait.failing, status(ctx).wait.failing);
  stored(ctx, { outcome: "timed-out", timedOutAt: "2026-09-03T14:00:00.000Z" });
  assert.deepEqual([check(ctx).state, check(ctx).wait.failing], ["timed-out", false]);
  // The one predicate (R7), as pollAwait, status and the board read it.
  assert.deepEqual([failingOf({ outcome: "awaiting", failures: 3 }, 3), failingOf({ outcome: "awaiting", failures: 2 }, 3), failingOf({ outcome: "ready", failures: 3 }, 3), failingOf({ outcome: "timed-out", failures: 9 }, 3)], [true, false, false, false]);
});

test("an await phase with no wait record reads as none, with the reason", (t) => {
  const { ctx } = waitOn(t);
  const run = ctx.loadRun();
  run.sessions = [];
  save(ctx, run);
  assert.deepEqual(check(ctx), { state: "none", error: `run ${run.runId} has no wait record for await phase wait` });
});
