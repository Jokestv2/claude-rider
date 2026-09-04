// test/render.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../scripts/lib/render.mjs";

const done = {
  state: "done", outcome: "done", note: null, rider: "lemmaria", runId: "3f2a", phase: "build", visit: 1,
  session: { id: "full", shortId: "ce34947e", model: "opus", at: "2026-09-03T10:00:00.000Z", resumedFrom: "full" },
  attach: "claude attach ce34947e   (or ← for agents)", statusHint: "STATUS: code green — gate record pending", doneReason: null,
  resumes: 1, lastResume: { reason: "rate-limit", at: "2026-09-03T20:19:00.000Z" }, rateLimit: null, humanTurns: 0, cost: 112.47, turns: 196, elapsedMs: 3_600_000,
  question: null, finalText: "All green.\nSTATUS: code green — gate record pending",
  evidence: [{ cmd: "git status --porcelain", status: 0, output: "" }, { cmd: "git log --oneline main..HEAD", status: 0, output: "a1b2c3d feat(review): x" }],
  labels: [{ label: "code green", to: "close" }, { label: "blocked", to: "operator" }, { label: "resume", to: "build" }, { label: "operator", to: "operator" }], log: "/x/logs/l.json",
};

test("the check block has the §4.4 shape", () => {
  const out = render("check", done);
  const lines = out.split("\n");
  assert.equal(lines[0], "rider lemmaria/3f2a · phase build · visit 1 · session ce34947e (claude attach ce34947e   (or ← for agents))");
  assert.match(lines[1], /^state: done\s+\(running \| done \| waiting \| gone \| rate-limited \| intervened\)$/);
  assert.match(out, /status hint: STATUS: code green — gate record pending/);
  assert.match(out, /resumes: 1 \(rate-limit, 2026-09-03T20:19:00.000Z\)   human turns after launch: 0   cost this stretch: \$112.47   turns: 196/);
  assert.match(out, /── final message ─+ \(capped at 8 KB; full text in \/x\/logs\/l\.json\)\n  All green\.\n  STATUS: code green/);
  assert.match(out, /── evidence ─+\n  \$ git status --porcelain\n  \$ git log --oneline main\.\.HEAD\n  a1b2c3d feat\(review\): x/);
  assert.match(out, /── legal labels: code green → close · blocked → operator · resume · operator$/);
});

test("running, none, human and refusal render short", () => {
  assert.match(render("check", { ...done, state: "running", outcome: "running", evidence: [] }), /^rider lemmaria\/3f2a[^\n]*\nstate: running/);
  assert.equal(render("check", { ...done, state: "running", outcome: "running", evidence: [] }).includes("legal labels"), false);
  assert.match(render("check", { state: "none", lastRun: { runId: "ab12", phase: "plan", endedBy: "operator", reason: "BLOCKED: x" } }), /no active run\nlast run ab12 ended at operator \(phase plan\): BLOCKED: x/);
  assert.match(render("check", { state: "human", rider: "lemmaria", runId: "3f2a", phase: "merge", check: "git merge-base --is-ancestor HEAD main", checkExit: 1, checkOutput: "", show: "3 files changed", notes: [], totalCost: 187 }), /phase merge is yours[\s\S]*check: git merge-base[\s\S]*3 files changed[\s\S]*total cost: \$187\.00/);
  assert.equal(render("next", { ok: false, error: "nope" }), "refused: nope");
  assert.match(render("status", { ok: true, state: "none", rider: "lemmaria", watcher: null, lastEvent: null, lastRun: null }), /^rider lemmaria · no active run/);
  assert.match(render("await", { ok: false, state: "timeout", minutes: 60 }), /no event in 60 min/);
});
