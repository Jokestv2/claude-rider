// test/verbs-next.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../scripts/lib/check.mjs";
import { next, note, reset, resume, start, status } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FACT_A, INSTANCE_RIDER_MD, REQUIRES_RIDER_MD, TEST_RIDER_MD, makeCtx, requiring, settled, tmpProject } from "./helpers.mjs";

const done = (lastText, extra = {}) => ({ statuses: ["done"], read: { lastText, ...extra } });
const GREEN = "STATUS: planned\n<promise>MILESTONE PLANNED</promise>";

test("next follows an edge, records the transition with its reason, enters the target", () => {
  const p = tmpProject();
  const binding = new FakeBinding({ script: [done(GREEN, { cost: 10 }), { statuses: ["running"] }] });
  const ctx = makeCtx({ root: p.root, binding });
  start(ctx);
  assert.match(next(ctx, "planned", { on: status(ctx).key }).error, /still running — rider check first/);
  check(ctx);
  assert.match(next(ctx, "gate green", { on: status(ctx).key }).error, /"gate green" is not an edge of plan — legal: planned · blocked · resume · operator/);
  assert.match(next(ctx, undefined, { on: status(ctx).key }).error, /next needs a label/);
  const r = next(ctx, "planned", { on: status(ctx).key, because: "plan committed, STATUS planned, tree clean" });
  assert.equal(r.state, "running");
  assert.equal(r.phase, "build");
  const run = ctx.loadRun();
  assert.deepEqual(run.transitions.map((t) => [t.from, t.label, t.to, t.because]), [["plan", "planned", "build", "plan committed, STATUS planned, tree clean"]]);
  assert.deepEqual(run.visits, { plan: 1, build: 1 });
  assert.equal(binding.calls.filter((c) => c.call === "launch")[1].prompt, "BUILD PROMPT");
  assert.equal(status(ctx).state, "running");
  p.cleanup();
});

test("operator ends the run with the reason; status then reports the last run; start works again", () => {
  const p = tmpProject();
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [done("STATUS: BLOCKED — design change: X"), {}] }) });
  start(ctx);
  check(ctx);
  const r = next(ctx, "blocked", { on: status(ctx).key, because: "BLOCKED: design change X, see open-questions.md" });
  assert.equal(r.state, "operator");
  assert.equal(ctx.loadRun(), null);
  const s = status(ctx);
  assert.equal(s.state, "none");
  assert.deepEqual([s.instance, s.scope], ["default", "."]);
  assert.deepEqual([s.lastRun.endedBy, s.lastRun.reason, s.lastRun.phase], ["operator", "BLOCKED: design change X, see open-questions.md", "plan"]);
  assert.equal(start(ctx, { phase: "plan" }).state, "running");
  // An active run's status still names the run before it.
  assert.deepEqual([status(ctx).lastRun.runId, status(ctx).instance], [r.runId, "default"]);
  p.cleanup();
});

test("entering a human phase prints show; status says human; reset ends the run and keeps the record", () => {
  const p = tmpProject();
  let killed = 0;
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [done("STATUS: gate green\n<promise>X</promise>")] }), killWatcher: () => { killed++; } });
  start(ctx, { phase: "close" });
  const { key } = check(ctx);
  const r = next(ctx, "gate green", { on: key, because: "gate record closed" });
  assert.equal(r.state, "human");
  assert.equal(r.show, "SHOW-OUTPUT");
  assert.equal(status(ctx).state, "human");
  assert.match(next(ctx, "anything", { on: key }).error, /human phase/);
  assert.equal(note(ctx, "drove 3 scenarios, all fine").ok, true);
  assert.equal(ctx.loadRun().notes[0].text, "drove 3 scenarios, all fine");
  assert.equal(reset(ctx, { on: r.runId }).state, "none");
  assert.equal(killed, 1);
  assert.equal(ctx.lastEndedRun().endedBy, "reset");
  assert.equal(ctx.lastEndedRun().notes.length, 1);
  p.cleanup();
});

test("reset on a live phase names the session it is forgetting and how to stop it", () => {
  const p = tmpProject();
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses: ["running"] }] }) });
  const s = start(ctx);
  const r = reset(ctx, { on: s.runId });
  assert.equal(r.state, "none");
  assert.match(r.message, new RegExp(`session ${s.session.shortId} is still running`));
  assert.match(r.message, new RegExp(`claude stop ${s.session.shortId}`));
  assert.match(ctx.lastEndedRun().reason, new RegExp(`claude stop ${s.session.shortId}`));
  p.cleanup();
});

test("the visit cap ends the run at operator on a revisit edge", () => {
  const md = TEST_RIDER_MD.replace("edges: { planned: build, blocked: operator }", "edges: { retry: plan, planned: build }").replace("intake:", "limits:\n  visits: 2\nintake:");
  const p = tmpProject({ riderMd: md });
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [done("STATUS: retry"), done("STATUS: retry"), done("STATUS: retry")] }) });
  start(ctx);
  check(ctx);
  assert.equal(next(ctx, "retry", { on: status(ctx).key, because: "once more" }).state, "running");
  check(ctx);
  const r = next(ctx, "retry", { on: status(ctx).key, because: "again" });
  assert.equal(r.state, "operator");
  assert.match(r.reason, /visit cap: plan entered 3 times \(limits\.visits is 2\)/);
  assert.equal(ctx.loadRun(), null);
  p.cleanup();
});

test("resume re-enters the same session: bare when listed, with options when not; cost is per stretch", () => {
  const p = tmpProject();
  const binding = new FakeBinding({ script: [
    { statuses: ["done"], read: { lastText: null, signal: "API Error: 429 rate limit exceeded - resets 1:40am (UTC)", cost: 10, turns: 20 } },
    { statuses: ["done"], read: { lastText: GREEN, cost: 25, turns: 35 } },
  ] });
  const ctx = makeCtx({ root: p.root, binding });
  start(ctx);
  assert.match(resume(ctx, { on: status(ctx).key }).error, /is running — rider check first/);
  assert.equal(settled(check, ctx).state, "rate-limited");
  const r = resume(ctx, { on: status(ctx).key, reason: "rate-limit" });
  assert.equal(r.state, "running");
  assert.equal(r.resumed, "sess-1");
  const call = binding.calls.find((c) => c.call === "resume");
  assert.deepEqual([call.sessionId, call.listed, call.model], ["sess-1", true, "fable"]);
  const run = ctx.loadRun();
  assert.equal(run.sessions.length, 2);
  assert.deepEqual([run.sessions[1].resumedFrom, run.sessions[1].resumeReason, run.sessions[1].baselineTurns, run.sessions[1].id], ["sess-1", "rate-limit", 20, "sess-1"]);
  const c = check(ctx);
  assert.equal(c.state, "done");
  assert.equal(c.cost, 15);
  assert.equal(c.resumes, 1);
  assert.deepEqual(c.lastResume.reason, "rate-limit");
  assert.equal(c.humanTurns, 0); // userTurns 1 by default: the fixture's transcript has the prompt only
  p.cleanup();
});

test("dry runs change nothing: next previews the launch, resume previews the argv", () => {
  const p = tmpProject();
  const binding = new FakeBinding({ script: [{ statuses: ["done"], read: { lastText: GREEN } }] });
  const ctx = makeCtx({ root: p.root, binding });
  start(ctx);
  assert.equal(check(ctx).state, "done");
  const d = next(ctx, "planned", { on: status(ctx).key, dryRun: true });
  assert.deepEqual([d.state, d.phase, Array.isArray(d.argv)], ["dry-run", "build", true]);
  const rd = resume(ctx, { on: status(ctx).key, dryRun: true });
  assert.deepEqual([rd.state, rd.phase, Array.isArray(rd.argv)], ["dry-run", "plan", true]);
  const run = ctx.loadRun();
  assert.deepEqual([run.phase, run.transitions.length, run.sessions.length], ["plan", 0, 1]);
  assert.deepEqual(binding.calls.map((c) => c.call), ["launch", "stop"]);
  assert.match(next(ctx, "toString", { on: status(ctx).key, dryRun: true }).error, /is not an edge of plan/);
  p.cleanup();
});

test("a gone session is resumed with its options again (unlisted)", () => {
  const p = tmpProject();
  const binding = new FakeBinding({ script: [{ statuses: ["gone"] }, { statuses: ["running"] }] });
  const ctx = makeCtx({ root: p.root, binding });
  start(ctx);
  check(ctx);
  assert.equal(check(ctx).state, "gone");
  const r = next(ctx, "resume", { on: status(ctx).key, because: "killed, transcript intact" });
  assert.equal(r.state, "running");
  assert.equal(binding.calls.find((c) => c.call === "resume").listed, false);
  p.cleanup();
});

test("an instance rider's resume carries its facts and its name, and so does its dry run", () => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a"] });
  const binding = new FakeBinding({ script: [{ statuses: ["gone"] }, { statuses: ["running"] }] });
  const ctx = makeCtx({ root: p.root, instance: "a", binding });
  start(ctx);
  check(ctx);
  assert.equal(check(ctx).state, "gone");
  assert.equal(next(ctx, "resume", { on: status(ctx).key, dryRun: true }).argv.at(-1), FACT_A);
  next(ctx, "resume", { on: status(ctx).key, because: "killed, transcript intact" });
  const call = binding.calls.find((c) => c.call === "resume");
  assert.deepEqual([call.listed, call.facts], [false, [FACT_A]]);
  assert.match(call.name, /^rider lemmaria\/a\/[0-9a-f]{4} plan$/);
  p.cleanup();
});

/** Plan done on a rider with `requires`: the judge holds plan's key, and build's preconditions decide `planned`. */
function planDone(t, { riderMd = REQUIRES_RIDER_MD, instance = null, instances = [], local = {} } = {}) {
  const p = tmpProject({ riderMd, instances });
  t.after(p.cleanup);
  const binding = new FakeBinding({ script: [done(GREEN), { statuses: ["running"] }] });
  const ctx = makeCtx({ root: p.root, instance, binding, local });
  start(ctx);
  const { state, key } = check(ctx);
  assert.equal(state, "done");
  const launches = () => binding.calls.filter((c) => c.call === "launch");
  return { p, ctx, binding, key, launches, flag: (name) => join(p.root, name) };
}

/** What a refusal must leave as it was: state.json's bytes, and the events up to it. */
const snapshotOf = (ctx) => ({ bytes: readFileSync(ctx.paths.state, "utf8"), events: ctx.readEvents().length });
const eventRow = (e) => [e.kind, e.runId, e.phase, e.key, e.text, e.by, e.cause];

test("a failing requires refuses the edge and changes nothing", (t) => {
  const { ctx, key, launches } = planDone(t);
  const before = snapshotOf(ctx);
  const r = next(ctx, "planned", { on: key, because: "plan committed" });
  assert.deepEqual([r.ok, r.cause], [false, "requires"]);
  assert.match(r.error, /requires check failed for build \(exit 1\): test -f ok\.flag/);
  assert.equal(readFileSync(ctx.paths.state, "utf8"), before.bytes, "no state write");
  assert.equal(ctx.loadRun().visits.build, undefined, "no visit counted");
  assert.equal(launches().length, 1, "no launch past plan's");
  const runId = ctx.loadRun().runId;
  assert.deepEqual(ctx.readEvents().slice(before.events).map(eventRow), [["refused", runId, "plan", key, r.error, "judge", "requires"]]);
});

test("the same decision succeeds once the condition holds", (t) => {
  const { ctx, key, launches, flag } = planDone(t);
  assert.equal(next(ctx, "planned", { on: key }).cause, "requires");
  writeFileSync(flag("ok.flag"), "");
  const r = next(ctx, "planned", { on: key, because: "the flag is there now" });
  assert.deepEqual([r.ok, r.state, r.phase], [true, "running", "build"]);
  assert.equal(launches()[1].prompt, "BUILD PROMPT");
  assert.deepEqual(ctx.loadRun().visits, { plan: 1, build: 1 });
});

test("requires runs in order and stops at the first that fails", (t) => {
  const { ctx, key, flag } = planDone(t, { riderMd: requiring("build", ["test -d riders", "echo why not; exit 4", "touch ran.flag"]) });
  const r = next(ctx, "planned", { on: key });
  assert.equal(r.error, "requires check failed for build (exit 4): echo why not; exit 4\nwhy not");
  assert.equal(existsSync(flag("ran.flag")), false);
});

test("requires sees the target, the phase left, the label, the instance and the scope", (t) => {
  const { ctx, key, flag } = planDone(t, { riderMd: requiring("build", ["env > seen.env"], INSTANCE_RIDER_MD), instance: "a", instances: ["a"] });
  rmSync(flag("seen.env")); // the check that found plan done wrote it, as its requires readout (§5.3): only next's may count
  const runId = ctx.loadRun().runId;
  assert.equal(next(ctx, "planned", { on: key }).state, "running");
  const env = Object.fromEntries(readFileSync(flag("seen.env"), "utf8").split("\n").filter((l) => l.startsWith("RIDER_")).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.deepEqual([env.RIDER_PHASE, env.RIDER_FROM_PHASE, env.RIDER_LABEL, env.RIDER_INSTANCE, env.RIDER_SCOPE, env.RIDER_RUN_ID, env.RIDER_NAME], ["build", "plan", "planned", "a", "nodes/a", runId, "lemmaria"]);
});

test("requires runs before the lock", (t) => {
  // Inside the hold the lock file exists, so this requirement would fail there (§4).
  const { ctx, key } = planDone(t, { riderMd: requiring("build", ["test ! -e .rider/lemmaria/default/lock"]) });
  const r = next(ctx, "planned", { on: key });
  assert.deepEqual([r.ok, r.state, r.error], [true, "running", undefined]);
});

test("a stale key with a failing requires is refused as stale", (t) => {
  // The cheap early exit (§4): the unlocked read already shows the key stale, so no requirement runs.
  const { ctx, key, launches, flag } = planDone(t, { riderMd: requiring("build", ["touch ran.flag", "test -f ok.flag"]) });
  const resumed = next(ctx, "resume", { on: key, because: "one more pass" });
  assert.equal(resumed.state, "running");
  rmSync(flag("ran.flag")); // the check that found plan done ran it, as its requires readout (§5.3)
  const latest = status(ctx).key;
  const before = snapshotOf(ctx);
  const r = next(ctx, "planned", { on: key });
  assert.deepEqual([r.ok, r.stale, r.cause], [false, true, undefined]);
  assert.match(r.error, new RegExp(`^${key.replace(".", "\\.")} judged phase plan, but the latest stretch of plan is ${latest.replace(".", "\\.")}`));
  assert.equal(existsSync(flag("ran.flag")), false, "no requirement ran");
  assert.equal(readFileSync(ctx.paths.state, "utf8"), before.bytes);
  assert.deepEqual(ctx.readEvents().slice(before.events).map((e) => [e.kind, e.key, e.cause]), [["refused", key, "stale"]]);
  assert.equal(launches().length, 1);
});

test("a dry run runs requires and records nothing", (t) => {
  const { ctx, key, launches, flag } = planDone(t);
  const before = snapshotOf(ctx);
  const r = next(ctx, "planned", { on: key, dryRun: true });
  assert.deepEqual([r.ok, r.cause], [false, "requires"]);
  assert.match(r.error, /requires check failed for build \(exit 1\)/);
  assert.deepEqual(snapshotOf(ctx), before, "no state write, no event");
  writeFileSync(flag("ok.flag"), "");
  const d = next(ctx, "planned", { on: key, dryRun: true });
  assert.deepEqual([d.state, d.phase], ["dry-run", "build"]);
  assert.deepEqual(snapshotOf(ctx), before);
  assert.equal(launches().length, 1);
});

test("resume runs no requires", (t) => {
  const p = tmpProject({ riderMd: requiring("plan", ["touch ran.flag"]) });
  t.after(p.cleanup);
  const ran = join(p.root, "ran.flag");
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses: ["gone"] }, { statuses: ["running"] }] }) });
  start(ctx);
  assert.equal(existsSync(ran), true, "entering plan ran its requirement");
  rmSync(ran);
  check(ctx);
  assert.equal(check(ctx).state, "gone");
  const r = next(ctx, "resume", { on: status(ctx).key, because: "killed, transcript intact" });
  assert.equal(r.state, "running");
  assert.equal(existsSync(ran), false, "a resume re-enters a phase already admitted (§5.2)");
});

test("a requires that hangs is refused, not passed", (t) => {
  // Review Focus 2: a command past its cap is a failure, exit -1, and says so. The cap is lowered for the test only.
  const { ctx, key, launches } = planDone(t, { riderMd: requiring("build", ["sleep 30"]), local: { requiresTimeoutMs: 300 } });
  const before = snapshotOf(ctx);
  const r = next(ctx, "planned", { on: key });
  assert.deepEqual([r.ok, r.cause, r.error], [false, "requires", "requires check failed for build (exit -1: timed out after 0.3 s): sleep 30"]);
  assert.equal(readFileSync(ctx.paths.state, "utf8"), before.bytes, "no state write");
  assert.equal(ctx.loadRun().visits.build, undefined);
  assert.equal(launches().length, 1);
});
