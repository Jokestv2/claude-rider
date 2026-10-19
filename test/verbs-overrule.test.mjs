// test/verbs-overrule.test.mjs — the operator's ruling on a stop the judge routed to `operator`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../scripts/lib/check.mjs";
import { render } from "../scripts/lib/render.mjs";
import { next, note, overrule, reset, start, status } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, TEST_RIDER_MD, makeCtx, tmpProject } from "./helpers.mjs";

const done = (lastText, extra = {}) => ({ statuses: ["done"], read: { lastText, turns: 5, ...extra } });
const GATE = "STATUS: gate green\n<promise>MILESTONE GATE GREEN</promise>";

/** Run 842b's shape: close printed `gate green`, the judge would not pick it and stopped the run. */
function stoppedAtOperator(script = [done(GATE, { cost: 33 })], phase = "close") {
  const p = tmpProject();
  const binding = new FakeBinding({ script });
  const ctx = makeCtx({ root: p.root, binding });
  start(ctx, { phase });
  const { key } = check(ctx);
  const stop = next(ctx, "operator", { on: key, because: "gate green, but the session fixed the Done record in place and asked whether that stands" });
  return { p, binding, ctx, stop };
}

test("842b: the ruling revives the stopped run, takes the edge, and the merge check can then end it", () => {
  const { p, ctx, stop } = stoppedAtOperator();
  try {
    const runId = stop.runId;
    // The stop itself says what can be done about it — nothing is left for the judge to invent.
    assert.deepEqual(stop.overrulable, ["gate green"]);
    assert.match(render("next", stop), /rider overrule "<label>" --because "…"[^\n]*\(gate green\)\n\s+rider start \[phase\]/);
    assert.deepEqual(status(ctx).lastRun.overrulable, ["gate green"]);
    assert.match(render("status", status(ctx)), /next, on the operator's word:\n\s+rider overrule/);

    const r = overrule(ctx, "gate green", { on: runId, because: "the in-place correction stands; close.md's BLOCKED rule is stricter than practice" });
    assert.deepEqual([r.state, r.phase, r.runId], ["human", "merge", runId], "the same run, not a fresh one");
    const run = ctx.loadRun();
    assert.equal(run.endedBy, undefined);
    assert.deepEqual(run.transitions.map((t) => [t.from, t.label, t.to, t.by ?? "judge"]), [["close", "operator", "operator", "judge"], ["close", "gate green", "merge", "operator"]], "the judge's call stays beside the ruling");
    assert.equal(readdirSync(ctx.paths.runs).length, 0, "the record moved back: one run is never both active and ended");

    writeFileSync(join(p.root, "merged.flag"), "");
    assert.equal(check(ctx).state, "none");
    assert.deepEqual([ctx.lastEndedRun().runId, ctx.lastEndedRun().endedBy, readdirSync(ctx.paths.runs).length], [runId, "done", 1]);
    assert.equal(status(ctx).lastRun.totalCost, 33, "and it still carries what its sessions cost");
  } finally { p.cleanup(); }
});

test("overrule into a session phase launches it like any edge", () => {
  const { p, ctx, binding, stop } = stoppedAtOperator([done("STATUS: planned — build pending\n<promise>X</promise>"), { statuses: ["running"] }], "plan");
  try {
    const r = overrule(ctx, "planned", { on: stop.runId, because: "the plan is fine; the judge misread the evidence" });
    assert.deepEqual([r.state, r.phase], ["running", "build"]);
    assert.equal(binding.calls.filter((c) => c.call === "launch")[1].prompt, "BUILD PROMPT");
    assert.deepEqual(ctx.loadRun().visits, { plan: 1, build: 1 });
  } finally { p.cleanup(); }
});

test("only a label that leaves for another phase, and only with the ruling in words", () => {
  const { p, ctx, stop: { runId: on } } = stoppedAtOperator();
  try {
    assert.match(overrule(ctx, undefined, { on }).error, /overrule needs a label — edges of close: gate green/);
    assert.match(overrule(ctx, "blocked", { on, because: "x" }).error, /"blocked" is not an edge of close that leaves for another phase — legal: gate green/);
    assert.match(overrule(ctx, "resume", { on, because: "x" }).error, /not an edge of close that leaves/);
    assert.match(overrule(ctx, "toString", { on, because: "x" }).error, /not an edge of close that leaves/);
    assert.match(overrule(ctx, "gate green", { on }).error, /overrule needs --because/);
    assert.match(overrule(ctx, "gate green", { on, because: "  " }).error, /overrule needs --because/);
    assert.equal(ctx.loadRun(), null, "a refusal revives nothing");
    assert.equal(ctx.lastEndedRun().endedBy, "operator");
  } finally { p.cleanup(); }
});

test("a dry run previews the edge and changes nothing", () => {
  const { p, ctx, stop } = stoppedAtOperator();
  try {
    const d = overrule(ctx, "gate green", { on: stop.runId, because: "stands", dryRun: true });
    assert.deepEqual([d.state, d.phase, d.human], ["dry-run", "merge", true]);
    assert.equal(ctx.loadRun(), null);
    assert.equal(ctx.lastEndedRun().transitions.length, 1);
  } finally { p.cleanup(); }
});

test("nothing to overrule: an active run, no run, a reset, a finished run, a stop the executor made", () => {
  const p = tmpProject();
  const clock = new FakeClock();
  const ctx = makeCtx({ root: p.root, clock, binding: new FakeBinding({ script: [{ statuses: ["running"] }, done(GATE)] }) });
  try {
    assert.match(overrule(ctx, "gate green", { on: "ab12", because: "x" }).error, /no ended run/);
    const { runId } = start(ctx);
    assert.match(overrule(ctx, "planned", { on: runId, because: "x" }).error, /is active at phase plan — overrule revives a run that stopped at operator/);
    reset(ctx, { on: runId });
    assert.match(overrule(ctx, "planned", { on: runId, because: "x" }).error, /ended by reset, not at operator/);
    assert.deepEqual(status(ctx).lastRun.overrulable, []);
    clock.t += 60_000; // records are named by start time: two runs started at one frozen instant would tie
    const closed = start(ctx, { phase: "close" });
    check(ctx);
    next(ctx, "gate green", { on: status(ctx).key, because: "ok" });
    writeFileSync(join(p.root, "merged.flag"), "");
    check(ctx);
    assert.match(overrule(ctx, "gate green", { on: closed.runId, because: "x" }).error, /ended by done, not at operator/);
  } finally { p.cleanup(); }

  // The visit cap: nobody judged that stop, so there is no call to overrule — and the stop says so by
  // offering only `start`.
  const md = TEST_RIDER_MD.replace("edges: { planned: build, blocked: operator }", "edges: { retry: plan, planned: build }").replace("intake:", "limits:\n  visits: 1\nintake:");
  const q = tmpProject({ riderMd: md });
  const qctx = makeCtx({ root: q.root, binding: new FakeBinding({ script: [done("STATUS: retry")] }) });
  try {
    start(qctx);
    check(qctx);
    const capped = next(qctx, "retry", { on: status(qctx).key, because: "once more" });
    assert.equal(capped.state, "operator");
    assert.equal(qctx.lastEndedRun().transitions.at(-1).by, "executor");
    assert.match(overrule(qctx, "planned", { on: capped.runId, because: "x" }).error, /stopped by the executor, not by a judge's call \(visit cap: plan entered 2 times/);
    assert.doesNotMatch(render("next", capped), /rider overrule/);
    assert.match(render("next", capped), /rider start \[phase\]/);
  } finally { q.cleanup(); }
});

test("entering a human phase names the rider and does not claim an exit code it never had", () => {
  const p = tmpProject();
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [done(GATE)] }) });
  try {
    start(ctx, { phase: "close" });
    check(ctx);
    const r = next(ctx, "gate green", { on: status(ctx).key, because: "ok" });
    const out = render("next", r);
    assert.match(out, new RegExp(`^rider lemmaria/${r.runId} · phase merge is yours\\n`));
    assert.match(out, /check: test -f merged\.flag   \(not run yet: rider check runs it — the run ends when it exits 0\)/);
    assert.doesNotMatch(out, /undefined|exit \?/);
    // `rider check` is what runs it, and only then is there an exit code to print.
    assert.match(render("check", check(ctx)), /\(exit 1 — the run ends when it exits 0\)/);
  } finally { p.cleanup(); }
});

test("a note finds the run it is about: the active one, or the one the merge just ended", () => {
  const p = tmpProject();
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [done(GATE)] }) });
  try {
    assert.match(note(ctx, "too early").error, /no run, active or ended/);
    start(ctx, { phase: "close" });
    check(ctx);
    next(ctx, "gate green", { on: status(ctx).key, because: "ok" });
    assert.deepEqual([note(ctx, "drove 4 scenarios").ended, ctx.loadRun().notes.length], [false, 1]);
    writeFileSync(join(p.root, "merged.flag"), "");
    check(ctx);
    // The gate report usually arrives after the merge — and the merge is what ended the run.
    const late = note(ctx, "scenario 3 found a stale cache; fixed in two commits before merging");
    assert.deepEqual([late.ok, late.ended, late.notes], [true, true, 2]);
    assert.match(render("note", late), /^noted \(2 notes on ended run /);
    const rec = ctx.lastEndedRun();
    assert.deepEqual(rec.notes.map((n) => [n.text.slice(0, 10), n.afterEnd ?? false]), [["drove 4 sc", false], ["scenario 3", true]]);
    assert.deepEqual([ctx.loadRun(), ctx.readState().lastRun.runId], [null, rec.runId], "noting on an ended run does not bring it back");
    assert.match(note(ctx, " ").error, /note needs text/);
  } finally { p.cleanup(); }
});
