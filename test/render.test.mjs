// test/render.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventLine, render, renderCheck } from "../scripts/lib/render.mjs";

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

// A stopped session with a human turn in it: the shape the `── human turns ──` section renders from.
const base = {
  rider: "lemmaria", runId: "c84c", phase: "build", visit: 1,
  session: { shortId: "4c511ecd" }, attach: "claude attach 4c511ecd",
  state: "intervened", statusHint: "STATUS: code green", resumes: 0,
  cost: 52.43, turns: 433, elapsedMs: 4_860_000, finalText: "done.", labels: [],
};

test("the human-turns section prints the turns the count refers to", () => {
  const out = renderCheck({
    ...base,
    humanTurns: 1,
    humanTurnDetails: [{ at: "2026-09-06T08:19:50.091Z", origin: "no origin, string content", bytes: 3200, text: "This session is being continued", truncated: true }],
  });
  assert.match(out, /── human turns ─+/);
  assert.match(out, /1 turn after launch/);
  assert.match(out, /\[2026-09-06T08:19:50\.091Z\] \(no origin, string content\)/);
  assert.match(out, /This session is being continued/);
  assert.match(out, /… 3200 bytes total, cut/);

  // Plural, and no section at all when nothing beyond the launch reached the session.
  assert.match(renderCheck({ ...base, humanTurns: 2, humanTurnDetails: [
    { at: null, origin: "human", bytes: 4, text: "stop", truncated: false },
    { at: null, origin: "human", bytes: 3, text: "why", truncated: false },
  ] }), /2 turns after launch/);
  assert.doesNotMatch(renderCheck({ ...base, humanTurns: 0, humanTurnDetails: [] }), /human turns ─/);
});

test("a capped list of human turns says so; an uncapped one adds no line", () => {
  const turn = (i) => ({ at: null, origin: "human", bytes: 6, text: `turn ${i}`, truncated: false });
  // The binding keeps at most 10 details, so a long intervention can show fewer turns than it counts.
  const capped = renderCheck({ ...base, humanTurns: 13, humanTurnDetails: Array.from({ length: 9 }, (_, i) => turn(i)) });
  assert.match(capped, /13 turns after launch\n  showing the first 9 of 13\n/);
  assert.doesNotMatch(renderCheck({ ...base, humanTurns: 2, humanTurnDetails: [turn(0), turn(1)] }), /showing the first/);
  // A run record written before the details existed: the section is honest about having none to show.
  assert.match(renderCheck({ ...base, humanTurns: 1, humanTurnDetails: [] }), /showing the first 0 of 1/);
});

test("more turns shown than counted is surfaced, not hidden", () => {
  // Reachable only when an entry that should have been marked `nudge` was not — in which case one of
  // the blocks below is the rider's own nudge dressed as an intervention. The arithmetic count is the
  // only thing that can expose that, so it is printed rather than reconciled away: nothing at this
  // point identifies which entry to drop.
  const turn = (i) => ({ at: null, origin: "human", bytes: 6, text: `turn ${i}`, truncated: false });
  const out = renderCheck({ ...base, humanTurns: 1, humanTurnDetails: [turn(0), turn(1)] });
  assert.match(out, /1 turn after launch\n  2 shown, 1 counted\n/);
  assert.doesNotMatch(out, /showing the first/);
  assert.match(out, /turn 0[\s\S]*turn 1/, "both are still printed; the operator judges which is which");
});

test("state none keeps the verb's own message and error", () => {
  assert.equal(render("reset", { ok: true, state: "none", message: "no active run; nothing to reset" }), "no active run; nothing to reset");
  assert.equal(render("reset", { ok: true, state: "none", message: "run 3f2a forgotten; its record is under runs/" }), "run 3f2a forgotten; its record is under runs/");
  assert.match(render("reset", { ok: true, state: "none", message: "run 3f2a forgotten; its record is under runs/", lastRun: { runId: "3f2a", phase: "plan", endedBy: "reset", reason: "rider reset" } }), /^run 3f2a forgotten; its record is under runs\/\nlast run 3f2a ended at reset \(phase plan\): rider reset$/);
  assert.equal(render("check", { state: "none", error: "run 3f2a has no session for phase plan" }), "no active run\nrun 3f2a has no session for phase plan");
  assert.equal(render("check", { state: "none" }), "no active run");
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

test("status renders both branches, and a run with no base", () => {
  const base = { rider: "lemmaria", runId: "c84c", phase: "build", visits: { build: 1 }, startedAt: "2026-09-06T06:37:37.845Z", state: "running", watcher: 33268, sessions: [], totalCost: 0 };
  assert.match(render("status", { ...base, baseBranch: "main", workBranch: "feature/r4-grounding" }), /· base main → work feature\/r4-grounding ·/);
  assert.match(render("status", { ...base, baseBranch: "main", workBranch: null }), /· branch main ·/);
  // The legacy `branch` field is no longer read (§15): only `baseBranch` names the base.
  assert.match(render("status", { ...base, branch: "main" }), /· branch \? ·/);
  assert.match(render("status", { ...base }), /· branch \? ·/);
});

test("an event renders as one line: at, kind, rider/instance/runId, phase, key, text", () => {
  const e = { seq: 4, at: "2026-10-19T12:00:00.000Z", rider: "lemmaria", instance: "default", runId: "3f2a", kind: "done", phase: "build", key: "3f2a.2", text: "STATUS: code green" };
  assert.equal(eventLine(e), "2026-10-19T12:00:00.000Z done lemmaria/default/3f2a build 3f2a.2 STATUS: code green");
  // Absent fields are left out, an unknown run reads "?", and a multi-line text stays on its line.
  assert.equal(eventLine({ ...e, kind: "watcher-stopped", runId: null, phase: null, key: null, text: "watcher giving up:\nboom" }), "2026-10-19T12:00:00.000Z watcher-stopped lemmaria/default/? watcher giving up: boom");
  assert.equal(render("await", { ok: true, state: "event", events: [e, { ...e, kind: "gone", text: "" }] }), `${eventLine(e)}\n2026-10-19T12:00:00.000Z gone lemmaria/default/3f2a build 3f2a.2`);
  const status = { rider: "lemmaria", runId: "3f2a", phase: "build", visits: { build: 1 }, startedAt: e.at, state: "finished", watcher: null, sessions: [], totalCost: 0, baseBranch: "main", lastEvent: e };
  assert.match(render("status", status), new RegExp(`last event: ${eventLine(e)}\n`));
});
