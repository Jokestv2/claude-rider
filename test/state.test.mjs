// test/state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, chainCost, chainResumes, consecutiveRateLimitResumes, currentSession, endRun, ensureDirs, lastEndedRun, loadLocal, loadRun, newRun, readEvents, saveRun, statePaths, totalCost, writeLog } from "../scripts/lib/state.mjs";

const now = new Date("2026-09-03T12:00:00Z");
const R = (phase, id, { cost = null, resumedFrom = null, resumeReason = null } = {}) => ({ phase, id, cost, resumedFrom, resumeReason, outcome: "done" });

test("a run is created, saved, ended into runs/, and found again as the last ended run", () => {
  const root = mkdtempSync(join(tmpdir(), "rider-state-"));
  const paths = statePaths(root, "lemmaria");
  ensureDirs(paths);
  assert.equal(loadRun(paths), null);
  const run = newRun({ rider: "lemmaria", phase: "plan", branch: "main", now });
  assert.match(run.runId, /^[0-9a-f]{4}$/);
  assert.deepEqual([run.phase, run.visits, run.transitions, run.sessions, run.notes], ["plan", {}, [], [], []]);
  saveRun(paths, run);
  assert.equal(loadRun(paths).runId, run.runId);
  endRun(paths, run, { endedBy: "operator", reason: "BLOCKED: x", now });
  assert.equal(loadRun(paths), null);
  assert.equal(readdirSync(paths.runs).length, 1);
  assert.deepEqual([lastEndedRun(paths).endedBy, lastEndedRun(paths).reason], ["operator", "BLOCKED: x"]);
  const line = appendEvent(paths, ["done", "lemmaria/ab12", "build", "s1", "STATUS: code green"], now);
  assert.equal(line, "2026-09-03T12:00:00.000Z done lemmaria/ab12 build s1 STATUS: code green");
  assert.deepEqual(readEvents(paths), [line]);
  const log = writeLog(paths, "x.json", { a: 1 });
  assert.ok(existsSync(log));
  assert.deepEqual(loadLocal(paths), { maxWaitHours: 6, pollSeconds: 30, models: {}, advisor: null, claudePath: null, shell: null, permissionMode: "auto" });
  rmSync(root, { recursive: true, force: true });
});

test("currentSession is the last record of the current phase", () => {
  const run = { phase: "build", sessions: [R("plan", "a"), R("build", "b"), R("build", "b", { resumedFrom: "b" })] };
  assert.equal(currentSession(run), run.sessions[2]);
  assert.equal(currentSession({ phase: "close", sessions: run.sessions }), null);
});

test("a record pays only for its own stretch; nudges are counted along the chain", () => {
  const first = R("plan", "a", { cost: 10 });
  const second = R("plan", "a", { cost: null, resumedFrom: "a", resumeReason: "rate-limit" });
  const third = R("plan", "a", { resumedFrom: "a", resumeReason: "rate-limit" });
  const forked = R("plan", "z", { resumedFrom: "a", resumeReason: "judge" });
  const fresh = R("plan", "q");
  assert.equal(chainCost([first, second], second), 10);
  assert.equal(chainResumes([first, second, third], third), 2);
  assert.equal(chainResumes([first, second, third, forked], forked), 3);
  assert.equal(chainCost([first, second, forked], forked), 10);
  assert.equal(chainCost([first, fresh], fresh), 0);
  assert.equal(chainResumes([first, fresh], fresh), 0);
  assert.equal(consecutiveRateLimitResumes([first, second, third], "plan"), 2);
  assert.equal(consecutiveRateLimitResumes([first, second, third, forked], "plan"), 0);
  assert.equal(consecutiveRateLimitResumes([R("build", "x")], "plan"), 0);
  assert.equal(totalCost({ sessions: [first, R("build", "x", { cost: 2.5 })] }), 12.5);
});
