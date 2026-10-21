// test/state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chainCost, chainResumes, consecutiveRateLimitResumes, currentSession, isLive, keyOf, loadLocal, newRun, riderEnv, totalCost, writeLog } from "../scripts/lib/state.mjs";
import { readJson, riderPaths } from "../scripts/lib/store.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { loadRider } from "../scripts/lib/rider-md.mjs";
import { AWAIT_PROMPTS, AWAIT_RIDER_MD, makeCtx, tmpProject } from "./helpers.mjs";

const now = new Date("2026-09-03T12:00:00Z");
const R = (phase, id, { cost = null, resumedFrom = null, resumeReason = null, at = null } = {}) => ({ phase, id, cost, resumedFrom, resumeReason, at, outcome: "done" });

test("a run is created, saved, ended into runs/, and found again as the last ended run", () => {
  const p = tmpProject();
  try {
    const ctx = makeCtx({ root: p.root, binding: new FakeBinding() });
    assert.equal(ctx.loadRun(), null);
    const run = newRun({ rider: "lemmaria", phase: "plan", baseBranch: "main", now });
    assert.match(run.runId, /^[0-9a-f]{4}$/);
    assert.deepEqual([run.phase, run.visits, run.transitions, run.sessions, run.notes], ["plan", {}, [], [], []]);
    ctx.update(() => ctx.saveRun(run));
    assert.equal(ctx.loadRun().runId, run.runId);
    ctx.update(() => ctx.endRun(run, { endedBy: "operator", reason: "BLOCKED: x" }));
    assert.equal(ctx.loadRun(), null);
    assert.equal(readdirSync(ctx.paths.runs).length, 1);
    assert.deepEqual([ctx.lastEndedRun().endedBy, ctx.lastEndedRun().reason], ["operator", "BLOCKED: x"]);
    const event = ctx.update(() => ctx.event("done", { runId: "ab12", phase: "build", key: "ab12.1", text: "STATUS: code green" }));
    assert.deepEqual(event, { seq: 2, at: "2026-09-03T12:00:00.000Z", rider: "lemmaria", instance: "default", runId: "ab12", kind: "done", phase: "build", key: "ab12.1", text: "STATUS: code green" });
    assert.deepEqual(ctx.readEvents().map((e) => [e.seq, e.kind]), [[1, "run-ended"], [2, "done"]]);
    const log = writeLog(ctx.paths, "x.json", { a: 1 });
    assert.ok(existsSync(log));
    assert.deepEqual(readJson(log), { a: 1 });
    assert.deepEqual(loadLocal(riderPaths(p.root, "lemmaria")), { maxWaitHours: 6, pollSeconds: 30, models: {}, advisor: null, launchArgs: [], claudePath: null, shell: null, permissionMode: "auto", staleDecisionMinutes: 20, awaitCheckFailures: 3 });
  } finally { p.cleanup(); }
});

test("local.json's awaitCheckFailures must be a positive integer", () => {
  // A null would slip past every default (a default fills only undefined) and make each awaiting wait read as failing.
  const p = tmpProject();
  try {
    const rp = riderPaths(p.root, "lemmaria");
    mkdirSync(rp.dir, { recursive: true });
    for (const bad of [null, 0, -1, 1.5, "3"]) {
      writeFileSync(rp.local, JSON.stringify({ awaitCheckFailures: bad }));
      assert.throws(() => loadLocal(rp), { message: `${rp.local}: awaitCheckFailures must be a positive integer (got ${JSON.stringify(bad)})` });
    }
    writeFileSync(rp.local, JSON.stringify({ awaitCheckFailures: 5 }));
    assert.equal(loadLocal(rp).awaitCheckFailures, 5);
  } finally { p.cleanup(); }
});

test("a run records base and work branch", () => {
  const run = newRun({ rider: "lemmaria", phase: "plan", baseBranch: "main", now: new Date("2026-09-06T06:37:37Z") });
  assert.equal(run.baseBranch, "main");
  assert.equal("branch" in run, false, "the legacy mirror is gone (§15)");
  assert.equal(run.workBranch, undefined);

  assert.deepEqual(riderEnv({ name: "lemmaria" }, { runId: "c84c", phase: "build", baseBranch: "main", workBranch: "feature/r4-grounding", workTip: "0f1e2d3c" }, { id: "default", scope: "." }), {
    RIDER_NAME: "lemmaria", RIDER_INSTANCE: "default", RIDER_SCOPE: ".", RIDER_RUN_ID: "c84c", RIDER_PHASE: "build",
    RIDER_BASE_BRANCH: "main", RIDER_WORK_BRANCH: "feature/r4-grounding", RIDER_WORK_TIP: "0f1e2d3c", RIDER_FROM_PHASE: "", RIDER_LABEL: "",
  });
  assert.deepEqual(riderEnv({ name: "lemmaria" }, null, { id: "a", scope: "nodes/a" }), {
    RIDER_NAME: "lemmaria", RIDER_INSTANCE: "a", RIDER_SCOPE: "nodes/a", RIDER_RUN_ID: "", RIDER_PHASE: "",
    RIDER_BASE_BRANCH: "", RIDER_WORK_BRANCH: "", RIDER_WORK_TIP: "", RIDER_FROM_PHASE: "", RIDER_LABEL: "",
  });

  // The base is read from `baseBranch` alone: a record carrying only the legacy `branch` has no base, and an
  // absent work branch is "". No instance is the rider without instances: `default`, at the root.
  assert.deepEqual(riderEnv({ name: "lemmaria" }, { runId: "c84c", phase: "merge", branch: "main" }), {
    RIDER_NAME: "lemmaria", RIDER_INSTANCE: "default", RIDER_SCOPE: ".", RIDER_RUN_ID: "c84c", RIDER_PHASE: "merge",
    RIDER_BASE_BRANCH: "", RIDER_WORK_BRANCH: "", RIDER_WORK_TIP: "", RIDER_FROM_PHASE: "", RIDER_LABEL: "",
  });

  // No run at all (intake, before newRun) must not throw.
  assert.equal(riderEnv({ name: "lemmaria" }, null).RIDER_RUN_ID, "");

  // An entry command (§4) is told the phase about to be entered, not the run's; `requires` also the phase left and the label.
  const entry = riderEnv({ name: "lemmaria" }, { runId: "c84c", phase: "plan" }, { id: "default", scope: "." }, { phase: "build", fromPhase: "plan", label: "planned" });
  assert.deepEqual([entry.RIDER_RUN_ID, entry.RIDER_PHASE, entry.RIDER_FROM_PHASE, entry.RIDER_LABEL], ["c84c", "build", "plan", "planned"]);
});

test("a corrupt state file names itself in the error", () => {
  const p = tmpProject();
  try {
    const ctx = makeCtx({ root: p.root, binding: new FakeBinding() });
    ctx.update(() => ctx.saveRun(newRun({ rider: "lemmaria", phase: "plan", baseBranch: null, now })));
    writeFileSync(ctx.paths.state, "{ not json");
    assert.throws(() => ctx.loadRun(), (e) => e.message.includes(ctx.paths.state) && /state\.json/.test(e.message));
    const rp = riderPaths(p.root, "lemmaria");
    writeFileSync(rp.local, "]");
    assert.throws(() => loadLocal(rp), (e) => e.message.includes(rp.local));
    rmSync(rp.local, { force: true });
    assert.deepEqual(readJson(rp.local, { a: 1 }), { a: 1 }); // a missing file is still the fallback
  } finally { p.cleanup(); }
});

test("a stretch's key is its run and its 1-based place in sessions", () => {
  const run = { runId: "3f2a", sessions: [R("plan", "a"), R("build", "b")] };
  assert.deepEqual([keyOf(run, run.sessions[0]), keyOf(run, run.sessions[1])], ["3f2a.1", "3f2a.2"]);
});

test("currentSession is the last record of the current phase", () => {
  const run = { phase: "build", sessions: [R("plan", "a"), R("build", "b"), R("build", "b", { resumedFrom: "b" })] };
  assert.equal(currentSession(run), run.sessions[2]);
  assert.equal(currentSession({ phase: "close", sessions: run.sessions }), null);
});

test("a record pays only for its own stretch; nudges are counted along the chain", () => {
  const first = R("plan", "a", { cost: 10 });
  const second = R("plan", "a", { cost: null, resumedFrom: "a", resumeReason: "rate-limit", at: "t2" });
  const third = R("plan", "a", { resumedFrom: "a", resumeReason: "rate-limit" });
  const forked = R("plan", "z", { resumedFrom: "a", resumeReason: "judge" });
  const fresh = R("plan", "q");
  assert.equal(chainCost([first, second], second), 10);
  assert.equal(chainResumes([first, second, third], third), 2);
  assert.equal(chainResumes([first, second, third, forked], forked), 3);
  assert.equal(chainCost([first, second, forked], forked), 10);
  assert.equal(chainCost([first, fresh], fresh), 0);
  assert.equal(chainCost([first, second], { ...second }), 10); // a copy of a stored record finds its twin by id + start time
  assert.throws(() => chainCost([first, second], R("plan", "a", { at: "never" })), /not in run\.sessions/);
  assert.equal(chainResumes([first, fresh], fresh), 0);
  assert.equal(consecutiveRateLimitResumes([first, second, third], "plan"), 2);
  assert.equal(consecutiveRateLimitResumes([first, second, third, forked], "plan"), 0);
  assert.equal(consecutiveRateLimitResumes([R("build", "x")], "plan"), 0);
  assert.equal(totalCost({ sessions: [first, R("build", "x", { cost: 2.5 })] }), 12.5);
});

test("isLive by kind: a running or waiting session, an awaiting wait, never a gate", (t) => {
  const p = tmpProject({ riderMd: AWAIT_RIDER_MD, prompts: AWAIT_PROMPTS });
  t.after(p.cleanup);
  const rider = loadRider(p.file);
  const at = (phase, outcome, kind) => ({ phase, sessions: outcome ? [{ phase, outcome, ...(kind ? { kind } : {}) }] : [] });
  const table = [
    ["session running", at("review", "running"), true],
    ["session waiting", at("review", "waiting"), true],
    ["session done", at("review", "done"), false],
    ["session not launched", at("review", null), false],
    ["wait awaiting", at("wait", "awaiting", "await"), true],
    ["wait ready", at("wait", "ready", "await"), false],
    ["wait timed out", at("wait", "timed-out", "await"), false],
    ["gate", at("merge", null), false],
    ["no run", null, false],
  ];
  for (const [name, run, live] of table) assert.equal(isLive(run, rider), live, name);
});
