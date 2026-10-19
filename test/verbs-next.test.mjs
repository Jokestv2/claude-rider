// test/verbs-next.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../scripts/lib/check.mjs";
import { next, note, reset, resume, start, status } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FACT_A, INSTANCE_RIDER_MD, TEST_RIDER_MD, makeCtx, settled, tmpProject } from "./helpers.mjs";

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
