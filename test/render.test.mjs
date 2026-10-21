// test/render.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideWithLine } from "../scripts/lib/keys.mjs";
import { eventLine, render, renderCheck } from "../scripts/lib/render.mjs";

const done = {
  state: "done", outcome: "done", note: null, rider: "lemmaria", instance: "a", runId: "3f2a", phase: "build", visit: 1,
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
  // One form throughout, as event lines and session names spell it: rider/instance/runId (`default` for a rider without instances).
  assert.equal(lines[0], "rider lemmaria/a/3f2a · phase build · visit 1 · session ce34947e (claude attach ce34947e   (or ← for agents))");
  assert.match(lines[1], /^state: done\s+\(running \| done \| waiting \| gone \| rate-limited \| intervened\)$/);
  assert.match(out, /status hint: STATUS: code green — gate record pending/);
  assert.match(out, /resumes: 1 \(rate-limit, 2026-09-03T20:19:00.000Z\)   human turns after launch: 0   cost this stretch: \$112.47   turns: 196/);
  assert.match(out, /── final message ─+ \(capped at 8 KB; full text in \/x\/logs\/l\.json\)\n  All green\.\n  STATUS: code green/);
  assert.match(out, /── evidence ─+\n  \$ git status --porcelain\n  \$ git log --oneline main\.\.HEAD\n  a1b2c3d feat\(review\): x/);
  assert.match(out, /── legal labels: code green → close · blocked → operator · resume · operator$/);
});

// A stopped session with a human turn in it: the shape the `── human turns ──` section renders from.
const base = {
  rider: "lemmaria", instance: "default", runId: "c84c", phase: "build", visit: 1,
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
  assert.match(render("check", { ...done, state: "running", outcome: "running", evidence: [] }), /^rider lemmaria\/a\/3f2a[^\n]*\nstate: running/);
  assert.equal(render("check", { ...done, state: "running", outcome: "running", evidence: [] }).includes("legal labels"), false);
  assert.match(render("check", { state: "none", lastRun: { runId: "ab12", phase: "plan", endedBy: "operator", reason: "BLOCKED: x" } }), /no active run\nlast run ab12 ended at operator \(phase plan\): BLOCKED: x/);
  assert.match(render("check", { state: "human", rider: "lemmaria", instance: "a", runId: "3f2a", phase: "merge", check: "git merge-base --is-ancestor HEAD main", checkExit: 1, checkOutput: "", show: "3 files changed", notes: [], totalCost: 187 }), /^rider lemmaria\/a\/3f2a · phase merge is yours[\s\S]*check: git merge-base[\s\S]*3 files changed[\s\S]*total cost: \$187\.00/);
  assert.equal(render("next", { ok: false, error: "nope" }), "refused: nope");
  assert.match(render("status", { ok: true, state: "none", rider: "lemmaria", instance: "a", watcher: null, lastEvent: null, lastRun: null }), /^rider lemmaria\/a · no active run/);
  assert.equal(render("await", { ok: false, state: "timeout", minutes: 60 }), "no event in 60 min; the phase is still running — re-arm rider await");
  // At a wait nothing runs: the heartbeat says there is nothing to judge yet.
  assert.equal(render("await", { ok: false, state: "timeout", minutes: 360, atWait: true }), "no event in 360 min; nothing is ready to judge yet — re-arm rider await");
});

test("status names the instance and the current stretch in its first line", () => {
  const st = { rider: "lemmaria", instance: "a", runId: "c84c", key: "c84c.2", phase: "build", visits: { build: 1 }, startedAt: "2026-09-06T06:37:37.845Z", state: "finished", watcher: null, sessions: [], totalCost: 0, baseBranch: "main" };
  assert.equal(render("status", st).split("\n")[0], "rider lemmaria/a/c84c · phase build (visit 1) · stretch c84c.2 · branch main · started 2026-09-06T06:37:37.845Z");
  // A human phase has no stretch to name.
  assert.equal(render("status", { ...st, state: "human", key: null }).split("\n")[0], "rider lemmaria/a/c84c · phase build (visit 1) · branch main · started 2026-09-06T06:37:37.845Z");
});

test("status renders both branches, and a run with no base", () => {
  const base = { rider: "lemmaria", instance: "default", runId: "c84c", phase: "build", visits: { build: 1 }, startedAt: "2026-09-06T06:37:37.845Z", state: "running", watcher: 33268, sessions: [], totalCost: 0 };
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
  const status = { rider: "lemmaria", instance: "default", runId: "3f2a", phase: "build", visits: { build: 1 }, startedAt: e.at, state: "finished", watcher: null, sessions: [], totalCost: 0, baseBranch: "main", lastEvent: e };
  assert.match(render("status", status), new RegExp(`last event: ${eventLine(e)}\n`));
});

test("the requires line and the marked tail", () => {
  const decideWith = decideWithLine({ rider: "lemmaria", multiRider: false, instance: "a", declared: true, key: "3f2a.2", labels: ["code green", "redo", "blocked", "resume", "operator"], failing: ["code green"] });
  assert.equal(decideWith, 'decide with:  rider next <label> --instance a --on 3f2a.2 --because "…"     (labels: code green ✗ · redo · blocked · resume · operator)');
  const requires = [
    { label: "code green", to: "close", ok: false, cmd: "tool budget --ok", status: 1, firstLine: "3.2 of 3.0 units spent" },
    { label: "redo", to: "plan", ok: true, cmd: null, status: null, firstLine: null },
  ];
  const labels = [{ label: "code green", to: "close" }, { label: "redo", to: "plan" }, ...done.labels.slice(1)];
  const lines = renderCheck({ ...done, labels, requires, decideWith }).split("\n");
  // After the legal labels and right before `decide with:`, the line the judge copies from.
  assert.equal(lines.at(-3), "── legal labels: code green → close · redo → plan · blocked → operator · resume · operator");
  assert.equal(lines.at(-2), "── requires ── code green → close ✗ tool budget --ok (exit 1): 3.2 of 3.0 units spent · redo → plan ✓");
  assert.equal(lines.at(-1), decideWith);
  // A failure that printed nothing leaves no dangling colon.
  const silent = [{ label: "code green", to: "close", ok: false, cmd: "test -f ok.flag", status: 1, firstLine: "" }];
  assert.equal(renderCheck({ ...done, requires: silent, decideWith }).split("\n").at(-2), "── requires ── code green → close ✗ test -f ok.flag (exit 1)");
  // No annotation, no line.
  assert.doesNotMatch(renderCheck({ ...done, decideWith }), /── requires ──/);
});

test("a requires that timed out says so in the requires line", () => {
  const requires = [{ label: "code green", to: "close", ok: false, cmd: "tool budget --ok", status: -1, firstLine: "", timedOut: true }];
  const lines = renderCheck({ ...done, requires, decideWith: "decide with: …" }).split("\n");
  assert.equal(lines.at(-2), "── requires ── code green → close ✗ tool budget --ok (exit -1: timed out after 10 s)");
});

test("start's note leads its result, and a dry run names its entry", () => {
  const note = "located close; entering build on the operator's word";
  const running = { ok: true, state: "running", runId: "3f2a", phase: "build", visit: 1, model: "opus", session: { shortId: "s1" }, attach: "claude attach s1" };
  assert.deepEqual(render("start", { ...running, note }).split("\n"), [`note: ${note}`, "build started as opus: s1  (claude attach s1)", "visit 1 of run 3f2a"]);
  assert.doesNotMatch(render("start", running), /note:/);
  const dry = { ok: true, state: "dry-run", phase: "build", model: "opus", name: "n", argv: ["fake", "--model", "opus"], entry: { by: "operator", located: "close", phase: "build" } };
  assert.deepEqual(render("start", { ...dry, note }).split("\n"), [`note: ${note}`, "[dry-run] build (opus): fake --model opus", "entry: build by operator"]);
  assert.deepEqual(render("start", { ...dry, entry: { by: "locate", located: "build", phase: "build" } }).split("\n"), ["[dry-run] build (opus): fake --model opus", "entry: build by locate"]);
  // At a gate, what entering it would do is wait on its check (§6.2).
  const gate = { ok: true, state: "dry-run", phase: "merge", human: true, check: "test -f merged.flag", entry: { by: "locate", located: "merge", phase: "merge" } };
  assert.deepEqual(render("start", gate).split("\n"), ["[dry-run] merge (human): test -f merged.flag", "entry: merge by locate"]);
  assert.equal(render("next", { ok: true, state: "dry-run", to: "operator" }), "[dry-run] operator", "a dry run with no entry prints none");
  // A check result's own note (the classification's) stays where the check block prints it.
  assert.match(render("check", { ...done, note: "not listed once; confirming on the next check" }).split("\n")[0], /^rider lemmaria\/a\/3f2a /);
});

test("the block printed on entering a human phase carries the drift line, and start's note above it", () => {
  const human = { ok: true, state: "human", rider: "lemmaria", instance: "a", runId: "3f2a", phase: "merge", check: "test -f merged.flag", show: null, notes: [], totalCost: 0, baseBranch: "main", branchDrift: { branch: "elsewhere", at: "2026-10-20T10:00:00.000Z" } };
  const lines = render("next", human).split("\n");
  assert.equal(lines[0], "rider lemmaria/a/3f2a · phase merge is yours");
  assert.equal(lines[1], "drift: the shared working tree left main for elsewhere (first seen 2026-10-20T10:00:00.000Z) — the executor does not switch back");
  assert.doesNotMatch(render("next", { ...human, branchDrift: null }), /drift:/);
  const started = render("start", { ...human, branchDrift: null, note: "located build; entering merge on the operator's word" }).split("\n");
  assert.deepEqual(started.slice(0, 2), ["note: located build; entering merge on the operator's word", "rider lemmaria/a/3f2a · phase merge is yours"]);
  // Entered by an edge, the check has not run; a start at the gate carries the pre-flight's exit, which did.
  assert.equal(render("next", { ...human, branchDrift: null }).split("\n")[1], "check: test -f merged.flag   (not run yet: rider check runs it — the run ends when it exits 0)");
  assert.deepEqual(render("start", { ...human, branchDrift: null, checkExit: 1, checkOutput: "no merged.flag" }).split("\n").slice(1, 3), ["check: test -f merged.flag   (exit 1 — the run ends when it exits 0)", "  no merged.flag"]);
});

test("an entry that lands on a wait prints the check it waits on, never a session", () => {
  const awaiting = { ok: true, state: "awaiting", runId: "3f2a", phase: "wait", visit: 2, key: "3f2a.5", check: "tool jobs tick --current", pollSeconds: 300, deadline: "2026-10-24T01:12:00.000Z" };
  assert.deepEqual(render("next", awaiting).split("\n"), ["wait awaiting: $ tool jobs tick --current every 300 s until 2026-10-24T01:12:00.000Z", "visit 2 of run 3f2a · stretch 3f2a.5"]);
  assert.deepEqual(render("overrule", { ...awaiting, deadline: null }).split("\n"), ["wait awaiting: $ tool jobs tick --current every 300 s", "visit 2 of run 3f2a · stretch 3f2a.5"]);
  assert.equal(render("start", { ...awaiting, note: "located plan; entering wait on the operator's word" }).split("\n")[0], "note: located plan; entering wait on the operator's word");
  const dry = { ok: true, state: "dry-run", phase: "wait", await: true, check: "tool jobs tick --current", entry: { by: "locate", located: "wait", phase: "wait" } };
  assert.deepEqual(render("start", dry).split("\n"), ["[dry-run] wait (await): tool jobs tick --current", "entry: wait by locate"]);
});

test("status at a wait: an await row, the wait line, and the hint to arm await or relay a failing check", () => {
  const wait = { check: "tool jobs tick --current", at: "2026-10-21T01:12:00.000Z", polls: 169, lastPollAt: "2026-10-21T15:15:00.000Z", lastExit: 75, lastError: null, failures: 0, failing: false, failingSince: null, deadline: "2026-10-24T01:12:00.000Z", readyAt: null, timedOutAt: null };
  const st = {
    ok: true, state: "awaiting", outcome: "awaiting", rider: "lemmaria", instance: "a", targetFlags: "--instance a", runId: "3f2a", key: "3f2a.2", phase: "wait", visits: { plan: 1, wait: 1 }, baseBranch: "main", startedAt: "2026-10-21T00:00:00.000Z", watcher: 4242, lastEvent: null, totalCost: 12,
    sessions: [
      { key: "3f2a.1", kind: "session", phase: "plan", model: "fable", shortId: "ce34947e", outcome: "done", cost: 12, turns: 40, at: "2026-10-21T00:00:00.000Z", resumedFrom: null },
      { key: "3f2a.2", kind: "await", phase: "wait", outcome: "awaiting", cost: null, turns: null, at: wait.at, resumedFrom: null },
    ],
    transitions: [], notes: [], attach: null, wait,
  };
  const lines = render("status", st).split("\n");
  assert.equal(lines[0], "rider lemmaria/a/3f2a · phase wait (visit 1) · stretch 3f2a.2 · branch main · started 2026-10-21T00:00:00.000Z");
  assert.match(lines[1], /^state: awaiting   watcher: alive \(pid 4242\)/);
  assert.equal(lines[2], "  plan     fable   ce34947e  done          $12.00  40 turns");
  assert.equal(lines[3], "  wait     await   -         awaiting");
  assert.equal(lines[4], "wait: $ tool jobs tick --current · 169 polls · last exit 75 at 2026-10-21T15:15:00.000Z · deadline 2026-10-24T01:12:00.000Z");
  assert.equal(lines.at(-1), "next: arm rider await --instance a (background) and stop");
  // Before the first poll, and with no deadline.
  const fresh = render("status", { ...st, wait: { ...wait, polls: 0, lastPollAt: null, lastExit: null, deadline: null } });
  assert.match(fresh, /^wait: \$ tool jobs tick --current · 0 polls · no poll yet$/m);
  const failing = render("status", { ...st, wait: { ...wait, lastExit: 127, failures: 3, failing: true, failingSince: "2026-10-21T15:05:00.000Z" } }).split("\n");
  assert.equal(failing[5], "check failing: 3 in a row since 2026-10-21T15:05:00.000Z");
  assert.equal(failing.at(-1), "next: relay the failing check to the operator, then arm rider await --instance a");
  const ready = render("status", { ...st, state: "finished", outcome: "ready", wait: { ...wait, lastExit: 0, readyAt: "2026-10-21T15:15:00.000Z" } });
  assert.match(ready, /^next: rider check --instance a, then the command its decide-with line prints$/m);
  assert.doesNotMatch(ready, /check failing/);
});

// A check at an await phase (§7.7): the stored poll, and once decided, what the judge reads before it picks a label.
const waitRead = { check: "tool jobs tick --current", at: "2026-10-21T01:12:00.000Z", polls: 169, lastPollAt: "2026-10-21T15:15:00.000Z", lastExit: 75, lastError: null, failures: 0, failing: false, failingSince: null, deadline: "2026-10-24T01:12:00.000Z", readyAt: null, timedOutAt: null };
const awaitBlock = {
  state: "awaiting", kind: "await", rider: "lemmaria", instance: "a", runId: "3f2a", key: "3f2a.5", phase: "await-jobs", visit: 2,
  wait: waitRead, elapsedMs: (14 * 60 + 3) * 60_000, checkOutput: "2/3 jobs running", show: null, showCmd: "tool jobs status --current", evidence: [],
  labels: [{ label: "settled", to: "review" }, { label: "jobs failed", to: "implement" }, { label: "timed out", to: "operator" }, { label: "operator", to: "operator" }],
  decideWith: null, baseBranch: "main", branchDrift: null,
};
const AWAIT_HEAD = "rider lemmaria/a/3f2a · phase await-jobs · visit 2 · awaiting since 2026-10-21T01:12:00.000Z (14h 3m) · 169 polls";

test("an awaiting block is the stored poll, with no decide-with line", () => {
  assert.deepEqual(render("check", awaitBlock).split("\n"), [
    AWAIT_HEAD,
    "state: awaiting",
    "── check ── $ tool jobs tick --current   (exit 75, polled 2026-10-21T15:15:00.000Z)",
    "  2/3 jobs running",
    "deadline: 2026-10-24T01:12:00.000Z",
  ]);
  // Not the line an entry prints: a check result names its kind, an entry's does not.
  assert.doesNotMatch(render("check", awaitBlock), /awaiting: \$/);
  // Before the first poll there is no exit to name; with no deadline, no deadline line.
  const fresh = { ...awaitBlock, elapsedMs: 0, checkOutput: "", wait: { ...waitRead, polls: 0, lastPollAt: null, lastExit: null, deadline: null } };
  assert.deepEqual(render("check", fresh).split("\n"), [
    "rider lemmaria/a/3f2a · phase await-jobs · visit 2 · awaiting since 2026-10-21T01:12:00.000Z (0m) · 0 polls",
    "state: awaiting",
    "── check ── $ tool jobs tick --current   (no poll yet)",
  ]);
});

test("a failing check says so in the awaiting block, its error after the exit", () => {
  const failing = { ...awaitBlock, checkOutput: "sh: tool: not found", wait: { ...waitRead, lastExit: 127, failures: 3, failing: true, failingSince: "2026-10-21T15:05:00.000Z" } };
  assert.deepEqual(render("check", failing).split("\n").slice(2), [
    "── check ── $ tool jobs tick --current   (exit 127, polled 2026-10-21T15:15:00.000Z)",
    "  sh: tool: not found",
    "check failing: 3 in a row since 2026-10-21T15:05:00.000Z",
    "deadline: 2026-10-24T01:12:00.000Z",
  ]);
  // The line is status's: one predicate, one text.
  assert.ok(render("status", { rider: "lemmaria", instance: "a", runId: "3f2a", phase: "await-jobs", visits: {}, startedAt: waitRead.at, state: "awaiting", watcher: null, sessions: [], totalCost: 0, wait: failing.wait }).includes("\ncheck failing: 3 in a row since 2026-10-21T15:05:00.000Z\n"));
  const timedOut = { ...awaitBlock, checkOutput: "", wait: { ...waitRead, lastExit: -1, lastError: "timed out after 300 s" } };
  assert.equal(render("check", timedOut).split("\n")[2], "── check ── $ tool jobs tick --current   (exit -1: timed out after 300 s, polled 2026-10-21T15:15:00.000Z)");
});

test("a ready block prints the check, show, evidence, requires and decide with, in §7.7's order", () => {
  const decideWith = decideWithLine({ rider: "lemmaria", multiRider: false, instance: "a", declared: true, key: "3f2a.5", labels: awaitBlock.labels.map((l) => l.label) });
  const ready = {
    ...awaitBlock, state: "ready", checkOutput: "3/3 jobs settled: 2 succeeded, 1 failed (job 2: out of memory at step 1840)",
    wait: { ...waitRead, lastExit: 0, readyAt: "2026-10-21T15:15:00.000Z" },
    branchDrift: { branch: "elsewhere", at: "2026-10-21T09:00:00.000Z" },
    show: "job 1 succeeded\njob 2 failed", evidence: done.evidence,
    requires: [{ label: "settled", to: "review", ok: true, cmd: null, status: null, firstLine: null }, { label: "jobs failed", to: "implement", ok: true, cmd: null, status: null, firstLine: null }],
    decideWith,
  };
  assert.deepEqual(render("check", ready).replace(/^── evidence ─+$/m, "── evidence ──").split("\n"), [
    AWAIT_HEAD,
    "state: ready",
    "drift: the shared working tree left main for elsewhere (first seen 2026-10-21T09:00:00.000Z) — the executor does not switch back",
    "── check ── $ tool jobs tick --current   (exit 0, polled 2026-10-21T15:15:00.000Z)",
    "  3/3 jobs settled: 2 succeeded, 1 failed (job 2: out of memory at step 1840)",
    "── show ── $ tool jobs status --current",
    "  job 1 succeeded",
    "  job 2 failed",
    "── evidence ──",
    "  $ git status --porcelain",
    "  $ git log --oneline main..HEAD",
    "  a1b2c3d feat(review): x",
    "── requires ── settled → review ✓ · jobs failed → implement ✓",
    'decide with:  rider next <label> --instance a --on 3f2a.5 --because "…"     (labels: settled · jobs failed · timed out · operator)',
  ]);
  // The evidence section is renderCheck's, line for line.
  const evidence = (out) => out.split("\n").filter((l) => /^── evidence|^ {2}\$ |^ {2}a1b2c3d/.test(l));
  assert.deepEqual(evidence(render("check", ready)), evidence(renderCheck(done)));
  // A timed-out wait reads the same; a phase with no show prints no show section, and the deadline line is the awaiting block's alone.
  const late = render("check", { ...ready, state: "timed-out", showCmd: null, show: null, wait: { ...ready.wait, readyAt: null, timedOutAt: "2026-10-24T01:12:00.000Z" } });
  assert.match(late, /^state: timed-out$/m);
  assert.doesNotMatch(late, /── show ──|^deadline:/m);
  assert.equal(late.split("\n").at(-1), decideWith);
});

test("a stored output of 2 KB, of binary bytes, or empty renders without a throw", () => {
  const big = "x".repeat(2047) + "\n";
  const binary = Buffer.from([0x00, 0xff, 0xfe, 0x1b, 0x5b, 0x32, 0x4a, 0x0a, 0x80, 0x0d, 0x07, 0xc3]).toString("utf8");
  for (const [what, checkOutput] of [["2 KB", big], ["binary", binary], ["empty", ""], ["never polled", null]]) {
    for (const state of ["awaiting", "ready"]) {
      let out;
      assert.doesNotThrow(() => { out = render("check", { ...awaitBlock, state, checkOutput }); }, `${what} at ${state}`);
      assert.equal(out.split("\n")[0], AWAIT_HEAD, `${what} at ${state}`);
    }
  }
  assert.ok(render("check", { ...awaitBlock, checkOutput: big }).includes(`\n  ${"x".repeat(2047)}\n`));
  // Nothing stored, nothing printed: the check line is followed by the deadline.
  assert.equal(render("check", { ...awaitBlock, checkOutput: "" }).split("\n")[3], "deadline: 2026-10-24T01:12:00.000Z");
});
