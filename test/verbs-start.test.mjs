// test/verbs-start.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { start } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FACT_A, INSTANCE_RIDER_MD, TEST_RIDER_MD, makeCtx, tmpProject } from "./helpers.mjs";

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

test("start names a phase as an operator override; a human or unknown phase is refused", () => {
  const p = tmpProject();
  const binding = new FakeBinding({ script: [{}] });
  const ctx = makeCtx({ root: p.root, binding });
  assert.match(start(ctx, { phase: "merge" }).error, /human phase/);
  assert.match(start(ctx, { phase: "ship" }).error, /no phase "ship"/);
  assert.equal(ctx.loadRun(), null);
  assert.equal(start(ctx, { phase: "build" }).phase, "build");
  assert.equal(binding.calls[0].prompt, "BUILD PROMPT");
  p.cleanup();
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
  assert.deepEqual(ctx.readEvents(), []);
  p.cleanup();
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
