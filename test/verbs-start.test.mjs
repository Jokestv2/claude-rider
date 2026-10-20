// test/verbs-start.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newRun } from "../scripts/lib/state.mjs";
import { emptyState, endedRunPath, writeJsonAtomic, writeState } from "../scripts/lib/store.mjs";
import { reset, start } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FACT_A, INSTANCE_RIDER_MD, TEST_RIDER_MD, makeCtx, requiring, tmpProject } from "./helpers.mjs";

test("a fresh start runs intake, creates the run in state.json, launches the start phase, spawns the watcher", () => {
  const p = tmpProject();
  let spawned = 0;
  const binding = new FakeBinding({ script: [{ statuses: ["running"] }] });
  const ctx = makeCtx({ root: p.root, binding, spawnWatcher: () => { spawned++; return true; } });
  const r = start(ctx);
  assert.equal(r.ok, true);
  assert.equal(r.state, "running");
  assert.equal(r.phase, "plan");
  assert.equal(r.visit, 1);
  assert.equal(r.model, "fable");
  assert.equal(r.session.shortId, "s1");
  assert.match(r.attach, /claude attach s1/);
  const run = ctx.loadRun();
  assert.equal(existsSync(ctx.paths.state), true);
  assert.equal(run.rider, "lemmaria");
  assert.match(run.runId, /^[0-9a-f]{4}$/);
  assert.deepEqual(run.visits, { plan: 1 });
  assert.equal(run.sessions.length, 1);
  assert.deepEqual([run.sessions[0].outcome, run.sessions[0].resumedFrom, run.sessions[0].baselineTurns, run.sessions[0].watcherSpawns], ["running", null, 0, 1]);
  assert.equal(spawned, 1);
  const launch = binding.calls[0];
  assert.equal(launch.prompt, "PLAN PROMPT");
  assert.equal(launch.name, `rider lemmaria/default/${run.runId} plan`);
  assert.equal(launch.cwd, p.root);
  // No phase named and no locate declared: the canonical start (§6.2).
  assert.deepEqual(run.entry, { by: "start", located: null, phase: "plan" });
  assert.equal(ctx.readEvents().find((e) => e.kind === "run-started").text, "plan by start");
  assert.equal("note" in r, false);
  p.cleanup();
});

test("an instance rider's launch carries its facts and its name; an undeclared rider's carries none", () => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a", "b"] });
  const binding = new FakeBinding({ script: [{ statuses: ["running"] }] });
  const ctx = makeCtx({ root: p.root, instance: "a", binding });
  assert.equal(start(ctx, { dryRun: true }).argv.at(-1), FACT_A, "the dry run previews the same launch");
  start(ctx);
  assert.deepEqual(binding.calls[0].facts, [FACT_A]);
  assert.match(binding.calls[0].name, /^rider lemmaria\/a\/[0-9a-f]{4} plan$/);
  assert.equal(binding.calls[0].prompt, "PLAN PROMPT", "the prompt file is sent whole and unmodified");
  p.cleanup();

  const q = tmpProject();
  const plain = new FakeBinding({ script: [{ statuses: ["running"] }] });
  start(makeCtx({ root: q.root, binding: plain }));
  assert.deepEqual(plain.calls[0].facts, []);
  assert.match(plain.calls[0].name, /^rider lemmaria\/default\//);
  q.cleanup();
});

test("start names a phase as an operator override; an unknown phase is refused, and a human one is entered", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const binding = new FakeBinding({ script: [{}] });
  const ctx = makeCtx({ root: p.root, binding });
  assert.match(start(ctx, { phase: "ship" }).error, /no phase "ship"/);
  assert.match(start(ctx, { phase: "toString" }).error, /no phase "toString"/, "a phase name never reads through Object.prototype");
  assert.equal(ctx.loadRun(), null);
  // §6.2: any declared phase, a gate included. The gate waits on the operator, so nothing launches.
  const gate = start(ctx, { phase: "merge" });
  assert.deepEqual([gate.state, gate.phase, binding.calls.length], ["human", "merge", 0]);
  assert.deepEqual(ctx.loadRun().entry, { by: "operator", located: null, phase: "merge" });
  assert.equal(reset(ctx, { on: gate.runId }).ok, true);
  assert.equal(start(ctx, { phase: "build" }).phase, "build");
  assert.equal(binding.calls[0].prompt, "BUILD PROMPT");
});

test("intake refuses before any launch and names the command", () => {
  const p = tmpProject({ riderMd: TEST_RIDER_MD.replace("  - test -d riders", "  - test -d riders\n  - exit 3") });
  const binding = new FakeBinding({ script: [{}] });
  const ctx = makeCtx({ root: p.root, binding });
  const r = start(ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /intake check failed \(exit 3\): exit 3/);
  assert.equal(binding.calls.length, 0);
  assert.equal(existsSync(ctx.paths.state), false, "no run was written");
  assert.deepEqual(ctx.readEvents().map((e) => e.kind), ["refused"], "the refusal is on file, and nothing else");
  p.cleanup();
});

/** The test rider with its one intake command replaced. */
const withIntake = (cmd) => TEST_RIDER_MD.replace("  - test -d riders", `  - ${cmd}`);

test("intake runs before the lock", (t) => {
  // Inside the hold the lock file exists, so this intake would fail there (§4).
  const p = tmpProject({ riderMd: withIntake("test ! -e .rider/lemmaria/default/lock") });
  t.after(p.cleanup);
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses: ["running"] }] }) });
  const r = start(ctx);
  assert.deepEqual([r.ok, r.state, r.error], [true, "running", undefined]);
});

test("an intake refusal records one refused event with cause intake, and creates no run", (t) => {
  const p = tmpProject({ riderMd: withIntake("test ! -f hold.flag") });
  t.after(p.cleanup);
  const binding = new FakeBinding({ script: [{ statuses: ["running"] }] });
  const ctx = makeCtx({ root: p.root, binding });
  // An instance with a past: its state.json exists, and the refusal must leave its bytes as they are.
  const { runId } = start(ctx);
  assert.equal(reset(ctx, { on: runId }).ok, true);
  writeFileSync(join(p.root, "hold.flag"), "");
  const bytes = readFileSync(ctx.paths.state, "utf8");
  const before = ctx.readEvents().length;
  const r = start(ctx);
  assert.deepEqual([r.ok, r.cause, r.error], [false, "intake", "intake check failed (exit 1): test ! -f hold.flag"]);
  assert.equal(readFileSync(ctx.paths.state, "utf8"), bytes, "no state write");
  assert.equal(binding.calls.filter((c) => c.call === "launch").length, 1, "no launch past the first run's");
  assert.deepEqual(readdirSync(ctx.paths.runs).length, 1, "no run created");
  const events = ctx.readEvents().slice(before);
  assert.deepEqual(events.map((e) => [e.kind, e.runId, e.phase, e.key, e.text, e.by, e.cause]), [["refused", null, "plan", null, r.error, "judge", "intake"]]);
  assert.equal(events[0].seq, before + 1);
});

test("a dry run with a failing intake records nothing", (t) => {
  const p = tmpProject({ riderMd: withIntake("exit 3") });
  t.after(p.cleanup);
  const binding = new FakeBinding({ script: [{}] });
  const ctx = makeCtx({ root: p.root, binding });
  const r = start(ctx, { dryRun: true });
  assert.deepEqual([r.ok, r.cause, r.error], [false, "intake", "intake check failed (exit 3): exit 3"]);
  assert.deepEqual(ctx.readEvents(), []);
  assert.equal(existsSync(ctx.paths.state), false);
  assert.equal(binding.calls.length, 0);
});

test("a usage refusal records nothing; --by names who sent a refused start", (t) => {
  const p = tmpProject({ riderMd: withIntake("exit 3") });
  t.after(p.cleanup);
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{}] }) });
  const r = start(ctx, { phase: "ship" });
  assert.deepEqual([r.ok, "cause" in r], [false, false], r.error);
  assert.deepEqual(ctx.readEvents(), [], "an unknown phase is a usage error, not a refused entry");
  start(ctx, { by: "operator" });
  assert.deepEqual(ctx.readEvents().map((e) => [e.kind, e.by, e.cause]), [["refused", "operator", "intake"]]);
});

test("a run started while intake ran is refused inside the hold, in the words of the check before it", (t) => {
  // The intake itself plays the other writer: it puts an active run in place between the unlocked read and the hold.
  const p = tmpProject({ riderMd: withIntake("mkdir -p .rider/lemmaria/default && cp other.json .rider/lemmaria/default/state.json") });
  t.after(p.cleanup);
  const binding = new FakeBinding({ script: [{}] });
  const ctx = makeCtx({ root: p.root, binding });
  const other = { ...emptyState({ rider: "lemmaria", instance: "default", scope: "." }), version: 1, run: newRun({ rider: "lemmaria", phase: "build", baseBranch: "main", now: new Date(), roll: () => "beef" }) };
  writeFileSync(join(p.root, "other.json"), JSON.stringify(other));
  const raced = start(ctx);
  assert.deepEqual([raced.ok, raced.error], [false, "run beef is active at phase build — rider check, next, or reset first"]);
  assert.equal(start(ctx).error, raced.error, "the unlocked check gives the same refusal");
  assert.equal(binding.calls.length, 0);
  assert.deepEqual(ctx.readEvents(), [], "an active run is no refused entry");
});

test("a failing requires on the start phase creates no run, and records cause requires", (t) => {
  const p = tmpProject({ riderMd: requiring("plan", ["test -f ok.flag"]) });
  t.after(p.cleanup);
  const binding = new FakeBinding({ script: [{ statuses: ["running"] }] });
  const ctx = makeCtx({ root: p.root, binding });
  const r = start(ctx);
  assert.deepEqual([r.ok, r.cause, r.error], [false, "requires", "requires check failed for plan (exit 1): test -f ok.flag"]);
  assert.equal(existsSync(ctx.paths.state), false, "no run was written");
  assert.equal(binding.calls.length, 0);
  assert.deepEqual(ctx.readEvents().map((e) => [e.kind, e.runId, e.phase, e.key, e.text, e.by, e.cause]), [["refused", null, "plan", null, r.error, "judge", "requires"]]);
  writeFileSync(join(p.root, "ok.flag"), "");
  assert.equal(start(ctx).state, "running", "retryable once the condition holds");
});

test("start runs the target's requires after intake, with no run, no phase left and no label", (t) => {
  // A phase named by the operator is a target like the start phase: its requires run too.
  const p = tmpProject({ riderMd: requiring("build", ["env > seen.env", "test -f ok.flag"], withIntake("test -f go.flag")) });
  t.after(p.cleanup);
  const seen = join(p.root, "seen.env");
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses: ["running"] }] }) });
  assert.equal(start(ctx, { phase: "build" }).cause, "intake");
  assert.equal(existsSync(seen), false, "a failed intake runs no requires");
  writeFileSync(join(p.root, "go.flag"), "");
  assert.equal(start(ctx, { phase: "build" }).cause, "requires", "build still waits on ok.flag");
  const env = readFileSync(seen, "utf8");
  for (const line of ["RIDER_PHASE=build", "RIDER_FROM_PHASE=", "RIDER_LABEL=", "RIDER_RUN_ID="]) assert.match(env, new RegExp(`^${line}$`, "m"));
  writeFileSync(join(p.root, "ok.flag"), "");
  assert.equal(start(ctx, { phase: "build" }).phase, "build");
});

/** The test rider (or `md`) whose fresh runs enter the phase `cmd` prints (§6.1). */
const locating = (cmd, md = TEST_RIDER_MD) => md.replace("start: plan\n", `start: plan\nlocate: ${cmd}\n`);
/** A project on that rider, its `where.txt` holding `where` when given, and a context with a binding ready for one launch. */
function located(t, { cmd = "cat where.txt", where = null, md, local } = {}) {
  const p = tmpProject({ riderMd: locating(cmd, md) });
  t.after(p.cleanup);
  if (where != null) writeFileSync(join(p.root, "where.txt"), where);
  const binding = new FakeBinding({ script: [{ statuses: ["running"] }] });
  return { p, binding, ctx: makeCtx({ root: p.root, binding, local }) };
}
const launches = (binding) => binding.calls.filter((c) => c.call === "launch");

test("locate names the phase a fresh run enters, and run.entry records it", (t) => {
  const { ctx, binding } = located(t, { where: "build" });
  const r = start(ctx);
  assert.deepEqual([r.ok, r.state, r.phase], [true, "running", "build"]);
  assert.equal(launches(binding)[0].prompt, "BUILD PROMPT");
  assert.deepEqual(ctx.loadRun().entry, { by: "locate", located: "build", phase: "build" });
  assert.deepEqual(ctx.readEvents().map((e) => [e.kind, e.phase, e.text]).slice(0, 1), [["run-started", "build", "build by locate"]]);
  assert.equal("note" in r, false, "no disagreement, no note");
});

test("CRLF and blanks around the located phase are trimmed", (t) => {
  const { ctx } = located(t, { where: "\n  build\r\n" });
  assert.equal(start(ctx).phase, "build");
});

test("locate runs first, before intake, told its instance but no phase", (t) => {
  // §4: the target comes first, and locate is what finds it, so it runs with RIDER_PHASE empty. The intake passes only
  // once locate has run.
  const { p, ctx } = located(t, { cmd: "env > loc.env; cat where.txt", where: "build", md: withIntake("test -f loc.env") });
  assert.equal(start(ctx).phase, "build");
  const env = readFileSync(join(p.root, "loc.env"), "utf8");
  for (const line of ["RIDER_PHASE=", "RIDER_RUN_ID=", "RIDER_INSTANCE=default", "RIDER_SCOPE=."]) assert.match(env, new RegExp(`^${line}$`, "m"));
});

test("locate printing an undeclared phase is refused, quoting it", (t) => {
  const { ctx, binding } = located(t, { where: "revew" });
  const r = start(ctx);
  assert.match(r.error, /locate printed "revew", which is not a declared phase/);
  assert.deepEqual([r.ok, r.cause, r.error], [false, "locate", 'locate printed "revew", which is not a declared phase']);
  assert.equal(existsSync(ctx.paths.state), false, "no run");
  assert.equal(binding.calls.length, 0);
  assert.deepEqual(ctx.readEvents().map((e) => [e.kind, e.runId, e.phase, e.key, e.text, e.by, e.cause]), [["refused", null, null, null, r.error, "judge", "locate"]]);
  // A name on Object.prototype is no declared phase either.
  writeFileSync(join(ctx.root, "where.txt"), "toString");
  assert.deepEqual([start(ctx).cause, start(ctx).error], ["locate", 'locate printed "toString", which is not a declared phase']);
});

test("locate printing nothing is refused; it never falls back to start:", (t) => {
  const { ctx, binding } = located(t, { where: "\n \n" });
  const r = start(ctx);
  assert.deepEqual([r.ok, r.cause, r.error], [false, "locate", "locate printed nothing"]);
  assert.equal(binding.calls.length, 0);
  assert.deepEqual(ctx.readEvents().map((e) => e.cause), ["locate"]);
});

test("a failing locate is relayed", (t) => {
  // §6.2: this is how a rider says there is nothing for a session to do.
  const { ctx, binding } = located(t, { cmd: "echo cycle closed; exit 3" });
  const r = start(ctx);
  assert.match(r.error, /cycle closed/);
  assert.deepEqual([r.ok, r.cause, r.error], [false, "locate", "locate failed (exit 3): echo cycle closed; exit 3\ncycle closed"]);
  assert.equal(existsSync(ctx.paths.state), false);
  assert.equal(binding.calls.length, 0);
  // On the operator's word it is only noted (§6.2).
  const forced = start(ctx, { phase: "build" });
  assert.deepEqual([forced.state, forced.phase, forced.note], ["running", "build", "locate failed (exit 3); entering build on the operator's word"]);
  assert.deepEqual(ctx.loadRun().entry, { by: "operator", located: null, phase: "build" });
});

test("a locate that hangs fails as a timeout, and says so", (t) => {
  // The cap is lowered for the test only; a hung locate is a failure, never a pass.
  const { ctx } = located(t, { cmd: "sleep 3", local: { requiresTimeoutMs: 200 } });
  const r = start(ctx);
  assert.deepEqual([r.ok, r.cause, r.error], [false, "locate", "locate failed (exit -1: timed out after 0.2 s): sleep 3"]);
  assert.equal(start(ctx, { phase: "build" }).note, "locate failed (exit -1: timed out after 0.2 s); entering build on the operator's word");
});

test("stderr does not pollute the located phase", (t) => {
  const { ctx } = located(t, { cmd: "echo build; echo warn >&2" });
  assert.equal(start(ctx).phase, "build");
});

test("the operator's phase wins, and the disagreement is noted", (t) => {
  const { ctx, binding } = located(t, { where: "close" });
  // Who sent the verb (`by`, on its events) is not how the phase was chosen (`run.entry.by`).
  const r = start(ctx, { phase: "build", by: "judge" });
  assert.deepEqual([r.state, r.phase, r.note], ["running", "build", "located close; entering build on the operator's word"]);
  assert.equal(launches(binding)[0].prompt, "BUILD PROMPT");
  const run = ctx.loadRun();
  assert.equal(run.entry.by, "operator");
  assert.deepEqual(run.entry, { by: "operator", located: "close", phase: "build" });
  assert.equal(ctx.readEvents()[0].text, "build by operator; located close; entering build on the operator's word");
});

test("an operator's start that names no phase still enters where locate says", (t) => {
  const { ctx } = located(t, { where: "close" });
  assert.equal(start(ctx, { by: "operator" }).phase, "close");
  assert.deepEqual(ctx.loadRun().entry, { by: "locate", located: "close", phase: "close" });
});

test("locate agreeing with the operator's phase notes nothing", (t) => {
  const { ctx } = located(t, { where: "build" });
  const r = start(ctx, { phase: "build" });
  assert.equal("note" in r, false);
  assert.deepEqual(ctx.loadRun().entry, { by: "operator", located: "build", phase: "build" });
  assert.equal(ctx.readEvents()[0].text, "build by operator");
});

test("an undeclared or empty located line is only noted on the operator's word", (t) => {
  const { ctx } = located(t, { where: "revew" });
  const r = start(ctx, { phase: "build" });
  assert.equal(r.note, 'locate printed "revew", which is not a declared phase; entering build on the operator\'s word');
  assert.deepEqual(ctx.loadRun().entry, { by: "operator", located: null, phase: "build" });
});

test("locate may name a gate: the run starts at the human phase, with no handoff", (t) => {
  const { ctx, binding } = located(t, { where: "merge" });
  const r = start(ctx);
  assert.deepEqual([r.ok, r.state, r.phase, r.show], [true, "human", "merge", "SHOW-OUTPUT"]);
  assert.equal(binding.calls.length, 0, "a gate launches nothing");
  const run = ctx.loadRun();
  assert.equal(run.handoff, null, "no session handed anything over");
  assert.deepEqual(run.entry, { by: "locate", located: "merge", phase: "merge" });
  assert.deepEqual(ctx.readEvents().map((e) => [e.kind, e.phase]), [["run-started", "merge"], ["phase-entered", "merge"]]);
});

test("a gate whose check already passes is refused and creates no run", (t) => {
  const { p, ctx } = located(t, { where: "merge" });
  writeFileSync(join(p.root, "merged.flag"), "");
  const r = start(ctx);
  assert.deepEqual([r.ok, r.cause, r.error], [false, "gate", "merge's check already passes; nothing waits on the operator there"]);
  assert.equal(existsSync(ctx.paths.state), false, "no run");
  assert.deepEqual(ctx.readEvents().map((e) => [e.kind, e.phase, e.cause]), [["refused", "merge", "gate"]]);
  assert.equal(start(ctx, { phase: "merge" }).cause, "gate", "the operator's word does not enter a passed gate either");
  const dry = start(ctx, { dryRun: true });
  assert.equal(dry.cause, "gate", "a dry run runs the gate check");
  assert.equal(ctx.readEvents().length, 2, "and records nothing");
});

test("a dry run reports the located entry and records nothing", (t) => {
  const { ctx, binding } = located(t, { where: "close" });
  const d = start(ctx, { phase: "build", dryRun: true });
  assert.deepEqual([d.state, d.phase, d.entry, d.note], ["dry-run", "build", { by: "operator", located: "close", phase: "build" }, "located close; entering build on the operator's word"]);
  writeFileSync(join(ctx.root, "where.txt"), "merge");
  const gate = start(ctx, { dryRun: true });
  assert.deepEqual([gate.state, gate.phase, gate.human, gate.entry], ["dry-run", "merge", true, { by: "locate", located: "merge", phase: "merge" }]);
  assert.deepEqual([binding.calls.length, ctx.readEvents().length, existsSync(ctx.paths.state)], [0, 0, false]);
});

test("a second start on an active run is refused", () => {
  const p = tmpProject();
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{}, {}] }) });
  start(ctx);
  assert.match(start(ctx).error, /is active at phase plan/);
  p.cleanup();
});

test("per-phase model override from local.json; dry-run launches nothing", () => {
  const p = tmpProject();
  const binding = new FakeBinding({ script: [{}] });
  const ctx = makeCtx({ root: p.root, binding, local: { models: { plan: "haiku" } } });
  const d = start(ctx, { dryRun: true });
  assert.equal(d.state, "dry-run");
  assert.deepEqual(d.argv.slice(0, 3), ["fake", "--model", "haiku"]);
  assert.equal(binding.calls.length, 0);
  assert.equal(ctx.loadRun(), null);
  assert.equal(start(ctx).model, "haiku");
  p.cleanup();
});

test("a launch failure ends the run at operator with the reason", () => {
  const p = tmpProject();
  const binding = new FakeBinding({ script: [] }); // exhausted → launch throws
  const ctx = makeCtx({ root: p.root, binding });
  const r = start(ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /launch failed: fake binding: script exhausted/);
  assert.equal(ctx.loadRun(), null);
  assert.equal(readdirSync(ctx.paths.runs).length, 1);
  assert.equal(ctx.lastEndedRun().endedBy, "operator");
  p.cleanup();
});

test("a new run's id is none the instance has used: re-rolled past the last run and every ended run on file", () => {
  // §5: a run id is unique within the instance. A reused one would let a stale key (`<runId>.<n>`) match a stretch
  // of a different run.
  const p = tmpProject();
  try {
    const rolls = ["aaaa", "bbbb", "cccc", "dddd"];
    const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses: ["running"] }] }), rollRunId: () => rolls.shift() });
    const at = (min) => new Date(Date.UTC(2026, 8, 1, 10, min)).toISOString();
    // aaaa is only in runs/ (a record whose summary another run's end replaced); bbbb is only the last run's summary.
    writeJsonAtomic(endedRunPath(ctx.paths, { runId: "aaaa", startedAt: at(0) }), { runId: "aaaa", startedAt: at(0) });
    ctx.update(() => { const state = ctx.readState(); state.lastRun = { runId: "bbbb", phase: "plan", startedAt: at(5), endedAt: at(6), endedBy: "reset", reason: null, totalCost: 0, overrulable: [] }; writeState(ctx.paths, state, new Date()); });
    assert.deepEqual([...ctx.runIdsInUse()].sort(), ["aaaa", "bbbb"]);
    assert.equal(start(ctx).runId, "cccc");
    assert.deepEqual(rolls, ["dddd"], "three rolls: two collisions, then a free id");
    assert.equal(ctx.runIdsInUse().has("cccc"), true, "the active run's id is in use too");
  } finally { p.cleanup(); }
});

test("newRun re-rolls an id it was told is taken", () => {
  const rolls = ["0001", "0001", "0002"];
  const run = newRun({ rider: "lemmaria", phase: "plan", baseBranch: "main", now: new Date(), taken: new Set(["0001"]), roll: () => rolls.shift() });
  assert.equal(run.runId, "0002");
  assert.throws(() => newRun({ rider: "lemmaria", phase: "plan", baseBranch: "main", now: new Date(), taken: new Set(["0001"]), roll: () => "0001" }), /no unused run id/);
});
