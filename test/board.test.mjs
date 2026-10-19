// test/board.test.mjs — every instance of every rider, needs-you first (§10); orphaned instances (§9)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { categorize, collectBoard } from "../scripts/lib/board.mjs";
import { check } from "../scripts/lib/check.mjs";
import { render } from "../scripts/lib/render.mjs";
import { loadRider } from "../scripts/lib/rider-md.mjs";
import { emptyState, endedRunPath, instancePaths, writeJsonAtomic, writeState } from "../scripts/lib/store.mjs";
import { start } from "../scripts/lib/verbs.mjs";
import { resolveInstance } from "../scripts/rider.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, INSTANCE_RIDER_MD, TEST_RIDER_MD, makeCtx, tmpProject } from "./helpers.mjs";

const RIDER = fileURLToPath(new URL("../scripts/rider.mjs", import.meta.url));
const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (min, now = NOW) => new Date(now.getTime() - min * 60_000).toISOString();
/** The one pid the injected liveness test calls alive: no row depends on a real process. */
const LIVE = 4242;
const alive = (pid) => pid === LIVE;

const stretch = (outcome, extra = {}) => ({ phase: "build", model: "opus", id: "sid-1", shortId: "s1", resumedFrom: null, resumeReason: null, at: ago(60), outcome, baselineTurns: 0, watcherSpawns: 1, ...extra });
const active = (sessions, extra = {}) => ({
  rider: "lemmaria", runId: "3f2a", startedAt: ago(120), baseBranch: "main", phase: "build", visits: { plan: 1, build: 1 },
  transitions: [{ at: ago(61), from: "plan", label: "planned", to: "build", because: "the plan holds", by: "judge" }], sessions, notes: [], ...extra,
});
const ended = (endedBy, extra = {}) => ({ runId: "9c1d", phase: "close", startedAt: ago(300), endedAt: ago(10), endedBy, reason: endedBy === "operator" ? "blocked: a design question" : "merge: check passed", totalCost: 2, overrulable: [], ...extra });

/** A state file written the way the store writes one, for instance `id` of `rider`. */
function put(root, id, { run = null, lastRun = null, watcher = null, rider = "lemmaria", scope = `nodes/${id}` } = {}) {
  const paths = instancePaths(root, rider, id);
  writeState(paths, { ...emptyState({ rider, instance: id, scope }), run, lastRun }, NOW);
  if (watcher) writeFileSync(paths.watchPid, String(watcher));
  return paths;
}
/** A second rider beside lemmaria: the test rider under another directory and name. */
function addRider(root, name, md = TEST_RIDER_MD.replace("name: lemmaria\n", `name: ${name}\n`)) {
  const dir = join(root, "riders", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "RIDER.md"), md);
  for (const phase of ["plan", "build", "close"]) writeFileSync(join(dir, `${phase}.md`), `${phase.toUpperCase()} PROMPT`);
}
const byInstance = (board) => Object.fromEntries(board.rows.map((r) => [r.instance, r]));
const cli = (root) => (...args) => {
  const r = spawnSync(process.execPath, [RIDER, ...args], { cwd: root, env: { ...process.env, RIDER_NO_WATCHER: "1" }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const CASES = {
  human: { run: active([stretch("done", { phase: "close", stoppedAt: ago(40) })], { phase: "merge", handoff: { phase: "merge", at: ago(30), tip: null } }) },
  stopped: { lastRun: ended("operator") },
  waiting: { run: active([stretch("waiting", { question: { questions: [{ question: "Which schema?" }] } })]), watcher: LIVE },
  intervened: { run: active([stretch("done", { stoppedAt: ago(2), intervened: true, humanTurns: 1 })]), watcher: LIVE },
  running: { run: active([stretch("running")]), watcher: LIVE },
  dead: { run: active([stretch("running")]), watcher: 999_999 },
  limited: { run: active([stretch("rate-limited", { stoppedAt: ago(5), rateLimit: { at: ago(5), resetAt: "2026-10-01T13:00:00.000Z" } })]), watcher: LIVE },
  gaveup: { run: active([stretch("rate-limited", { stoppedAt: ago(5), rateLimit: { at: ago(5), resetAt: null } })]) },
  drift: { run: active([stretch("running")], { branchDrift: { branch: "feature/x", at: ago(3) } }), watcher: LIVE },
  fresh: { run: active([stretch("done", { stoppedAt: ago(5.5) })]) },
  stale: { run: active([stretch("done", { stoppedAt: ago(25) })]) },
  never: null,
  over: { lastRun: ended("done") },
};
function everyCase(t, cases = CASES) {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: Object.keys(cases) });
  t.after(p.cleanup);
  for (const [id, c] of Object.entries(cases)) if (c) put(p.root, id, c);
  return p;
}

test("every category is produced", (t) => {
  const p = everyCase(t);
  const board = collectBoard(p.root, { now: NOW, alive });
  const rows = byInstance(board);
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, r.category])), {
    human: "needs you", stopped: "needs you", waiting: "needs you", intervened: "needs you", running: "running", dead: "needs you",
    limited: "running", gaveup: "needs you", drift: "needs you", fresh: "needs its judge", stale: "needs you", never: "idle", over: "idle",
  });
  const waits = (id) => rows[id].waitsOn;
  assert.equal(waits("human"), "human check: test -f merged.flag");
  assert.equal(waits("stopped"), "stopped at operator: blocked: a design question");
  assert.equal(waits("waiting"), "question: Which schema?");
  assert.equal(waits("intervened"), "intervened: a human turn reached the session");
  assert.equal(waits("dead"), "watcher not alive");
  assert.equal(waits("limited"), "rate-limited; resumes after 2026-10-01T13:00:00.000Z");
  assert.equal(waits("gaveup"), "rate-limited; the watcher gave up or died");
  assert.equal(waits("drift"), "the shared working tree left main for feature/x");
  assert.match(waits("stale"), /^undecided for 25 min — its judge has most likely died$/);
  assert.equal(waits("never"), "never run");
  assert.equal(waits("over"), "last run ended done");
  assert.deepEqual([rows.human.since, rows.stopped.since, rows.stale.since, rows.drift.since], [ago(30), ago(10), ago(25), ago(3)]);

  // Only a stretch that waits on a decision carries the line to make it, verbatim as `check` prints it.
  const decide = 'decide with:  rider next <label> --instance stale --on 3f2a.1 --because "…"     (labels: code green · blocked · resume · operator)';
  assert.equal(rows.stale.decideWith, decide);
  assert.equal(rows.fresh.decideWith, decide.replace("--instance stale", "--instance fresh"));
  assert.deepEqual(Object.values(rows).filter((r) => r.decideWith).map((r) => r.instance).sort(), ["fresh", "stale"]);
  assert.deepEqual([rows.stale.key, rows.running.key, rows.human.key, rows.never.key], ["3f2a.1", "3f2a.1", null, null]);
  assert.deepEqual([rows.running.watcher, rows.dead.watcher], [LIVE, null]);
  assert.deepEqual(rows.running.decision, { label: "planned", because: "the plan holds", by: "judge" });
  assert.deepEqual([rows.running.scope, rows.running.phase, rows.running.updatedAt], ["nodes/running", "build", NOW.toISOString()]);

  const text = render("board", board);
  const heads = text.split("\n").filter((l) => l.startsWith("── "));
  assert.deepEqual(heads.map((l) => l.replace(/ ─+$/, "")), ["── needs you (8)", "── needs its judge (1)", "── running (2)", "── idle (2)"]);
  assert.ok(text.split("\n").some((l) => l.trim() === decide), "the decide-with line, unchanged");
  assert.match(text, /lemmaria\/stale\b[^\n]*undecided for 25 min/);
});

test("a rate-limited stretch a human turn reached reads intervened, as check reads it", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["x"] });
  t.after(p.cleanup);
  // check counts a rate limit as a stop, so a human turn makes the stretch intervened and the watcher does not wait on it.
  const run = active([stretch("rate-limited", { stoppedAt: ago(5), rateLimit: { at: ago(5), resetAt: "2026-10-01T13:00:00.000Z" }, intervened: true, humanTurns: 1 })]);
  const state = { ...emptyState({ rider: "lemmaria", instance: "x", scope: "nodes/x" }), run };
  for (const live of [true, false]) {
    const c = categorize(state, loadRider(p.file), { now: NOW, staleMs: 20 * 60_000, watcherAlive: live });
    assert.deepEqual([c.category, c.waitsOn], ["needs you", "intervened: a human turn reached the session"], `watcher ${live ? "alive" : "dead"}`);
  }
});

test("staleDecisionMinutes in local.json moves the line", (t) => {
  const p = everyCase(t, { fresh: CASES.fresh, edge: { run: active([stretch("done", { stoppedAt: ago(5) })]) } });
  assert.equal(byInstance(collectBoard(p.root, { now: NOW, alive })).fresh.category, "needs its judge", "the default is 20");
  writeFileSync(join(p.root, ".rider", "lemmaria", "local.json"), JSON.stringify({ staleDecisionMinutes: 5 }));
  const rows = byInstance(collectBoard(p.root, { now: NOW, alive }));
  assert.deepEqual([rows.fresh.category, rows.fresh.waitsOn], ["needs you", "undecided for 5 min — its judge has most likely died"]);
  assert.ok(rows.fresh.decideWith);
  // Stale means finished more than the line ago (§10): a stretch exactly at it still waits on its judge.
  assert.equal(rows.edge.category, "needs its judge");
});

test("a stopped stretch with no stoppedAt is aged from its start", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["old", "young"] });
  t.after(p.cleanup);
  // A crash between classification and harvest: the outcome is on file, the stop time is not.
  const old = active([stretch("gone", { at: ago(30) })]);
  const young = active([stretch("done", { at: ago(10) })]);
  const rider = loadRider(p.file);
  const opts = { now: NOW, staleMs: 20 * 60_000, watcherAlive: false };
  const c = categorize({ ...emptyState({ rider: "lemmaria", instance: "old", scope: "nodes/old" }), run: old }, rider, opts);
  assert.deepEqual([c.category, c.waitsOn, c.since, c.key], ["needs you", "undecided for 30 min — its judge has most likely died", ago(30), "3f2a.1"]);
  assert.deepEqual(c.labels, ["code green", "blocked", "resume", "operator"]);
  assert.equal(categorize({ ...emptyState({ rider: "lemmaria", instance: "young", scope: "nodes/young" }), run: young }, rider, opts).category, "needs its judge");
  put(p.root, "old", { run: old });
  put(p.root, "young", { run: young });
  const rows = byInstance(collectBoard(p.root, { now: NOW, alive }));
  assert.deepEqual([rows.old.category, rows.young.category], ["needs you", "needs its judge"]);
});

test("a never-run instance and an orphaned state directory both appear", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["c", "a+b"] });
  t.after(p.cleanup);
  put(p.root, "gone", { lastRun: ended("done") });
  assert.equal(existsSync(join(p.root, "nodes", "gone")), false);
  const board = collectBoard(p.root, { now: NOW, alive });
  const rows = byInstance(board);
  assert.deepEqual(Object.keys(rows).sort(), ["c", "gone"]);
  assert.deepEqual([rows.c.category, rows.c.waitsOn, rows.c.updatedAt, rows.c.runCost, rows.c.instanceCost], ["idle", "never run", null, null, 0]);
  assert.deepEqual([rows.gone.category, rows.gone.waitsOn, rows.gone.scope], ["orphaned", "no directory matches — rider status/reset --instance gone", "nodes/gone"]);
  // A matching directory whose name is not a safe id is reported, with the reason (§5.1).
  assert.equal(board.skipped.length, 1);
  assert.deepEqual([board.skipped[0].rider, board.skipped[0].path], ["lemmaria", "nodes/a+b"]);
  assert.match(board.skipped[0].reason, /not a safe id/);
  assert.match(render("board", board), /── orphaned \(1\) ─[\s\S]*── idle \(1\) ─[\s\S]*── skipped \(1\) ─+\n.*nodes\/a\+b/);
});

test("the order is needs you first, then orphaned, needs its judge, running, idle", (t) => {
  const p = everyCase(t, { r: CASES.running, j: CASES.fresh, c: null, b: CASES.stopped, a: CASES.dead });
  addRider(p.root, "alpha");
  put(p.root, "o", { run: active([stretch("running")]) });
  const board = collectBoard(p.root, { now: NOW, alive });
  assert.deepEqual(board.rows.map((r) => [r.category, r.rider, r.instance]), [
    ["needs you", "lemmaria", "a"], ["needs you", "lemmaria", "b"], ["orphaned", "lemmaria", "o"], ["needs its judge", "lemmaria", "j"],
    ["running", "lemmaria", "r"], ["idle", "alpha", "default"], ["idle", "lemmaria", "c"],
  ]);
  // Two riders: a decide-with line names its rider, so it runs as printed.
  assert.match(byInstance(board).j.decideWith, /rider next <label> --rider lemmaria --instance j --on 3f2a\.1 /);
  // An orphan keeps its run's phase and key, but no decide-with line: next refuses its id.
  assert.deepEqual([byInstance(board).o.phase, byInstance(board).o.key, byInstance(board).o.decideWith], ["build", "3f2a.1", null]);
  // Its hint names the rider too: with two riders, status and reset need --rider.
  assert.equal(byInstance(board).o.waitsOn, "no directory matches — rider status/reset --rider lemmaria --instance o");
});

test("one invalid RIDER.md is an error row; the other riders are listed", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a"] });
  t.after(p.cleanup);
  addRider(p.root, "broken", TEST_RIDER_MD); // its frontmatter still says lemmaria
  addRider(p.root, "zulu");
  put(p.root, "a", { run: active([stretch("done", { stoppedAt: ago(1) })]) });
  const board = collectBoard(p.root, { now: NOW, alive });
  assert.equal(board.errors.length, 1);
  assert.equal(board.errors[0].rider, "broken");
  assert.match(board.errors[0].error, /name "lemmaria" must equal its directory name "broken"/);
  assert.deepEqual(board.rows.map((r) => [`${r.rider}/${r.instance}`, r.category]), [["lemmaria/a", "needs its judge"], ["zulu/default", "idle"]]);
  // The CLI counts the invalid rider too (it still asks for --rider), so the printed line names its rider.
  assert.match(board.rows[0].decideWith, / --rider lemmaria --instance a /);
  assert.match(render("board", board), /── errors \(1\) ─+\n  broken: /);
});

test("v3 state, an unreadable state.json and a broken local.json are errors; the rest is listed", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a", "torn"] });
  t.after(p.cleanup);
  addRider(p.root, "old");
  addRider(p.root, "odd");
  mkdirSync(join(p.root, ".rider", "old"), { recursive: true });
  writeFileSync(join(p.root, ".rider", "old", "run.json"), "{}");
  mkdirSync(join(p.root, ".rider", "odd"), { recursive: true });
  writeFileSync(join(p.root, ".rider", "odd", "local.json"), "]");
  const torn = put(p.root, "torn", {});
  writeFileSync(torn.state, "{ not json");
  const board = collectBoard(p.root, { now: NOW, alive });
  assert.deepEqual(board.errors.map((e) => [e.rider, e.instance ?? null]), [["lemmaria", "torn"], ["odd", null], ["old", null]]);
  const why = Object.fromEntries(board.errors.map((e) => [e.instance ?? e.rider, e.error]));
  assert.match(why.torn, /state\.json/);
  assert.match(why.odd, /local\.json/);
  assert.match(why.old, /state from an older claude-rider[\s\S]*Finish or reset that run with the old version first/);
  assert.deepEqual(board.rows.map((r) => `${r.rider}/${r.instance}`), ["lemmaria/a"]);
});

test("a rider whose instances glob matches nothing yet is told apart from no riders at all", (t) => {
  const none = tmpProject();
  t.after(none.cleanup);
  rmSync(join(none.root, "riders"), { recursive: true });
  const empty = collectBoard(none.root, { now: NOW, alive });
  assert.deepEqual([empty.rows, empty.riders], [[], []]);
  assert.match(render("board", empty), /^no riders\/\*\/RIDER\.md here/);
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD });
  t.after(p.cleanup);
  const board = collectBoard(p.root, { now: NOW, alive });
  assert.deepEqual([board.rows, board.riders], [[], ["lemmaria"]]);
  const text = render("board", board);
  assert.match(text, /no instances yet/);
  assert.match(text, /lemmaria/);
  assert.doesNotMatch(text, /no riders/);
});

test("a state directory that cannot be listed is an error; the rider's instances are still listed", (t) => {
  // Readable for a lookup by name, not for a listing: only the orphan scan lists .rider/<rider>/.
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions that bind the caller (not root)");
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a"] });
  put(p.root, "a", { lastRun: ended("done") });
  const dir = join(p.root, ".rider", "lemmaria");
  chmodSync(dir, 0o311);
  t.after(() => { chmodSync(dir, 0o755); p.cleanup(); });
  const board = collectBoard(p.root, { now: NOW, alive });
  assert.deepEqual(board.rows.map((r) => [r.instance, r.category]), [["a", "idle"]]);
  assert.equal(board.errors.length, 1);
  assert.deepEqual([board.errors[0].rider, board.errors[0].instance ?? null], ["lemmaria", null]);
  assert.match(board.errors[0].error, /EACCES/);
});

test("--json carries board: 1 and the state path", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a", "b"] });
  t.after(p.cleanup);
  addRider(p.root, "other");
  // The CLI reads the real clock: a stretch that stopped just now waits on its judge.
  const now = new Date();
  put(p.root, "a", { run: active([stretch("done", { at: ago(5, now), stoppedAt: now.toISOString() })]) });
  const run = cli(p.root);
  // Several riders, no --rider (and a wrong one ignored), no --instance: the board is all of them.
  for (const args of [["board", "--json"], ["board", "--json", "--rider", "nope"]]) {
    const r = run(...args);
    assert.equal(r.code, 0, r.err);
    const v = JSON.parse(r.out);
    assert.equal(v.board, 1);
    assert.match(v.generatedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(v.rows.map((x) => [x.rider, x.instance, x.category]), [["lemmaria", "a", "needs its judge"], ["lemmaria", "b", "idle"], ["other", "default", "idle"]]);
    assert.equal(v.rows[0].statePath, join(p.root, ".rider", "lemmaria", "a", "state.json"));
    assert.equal(v.rows[2].statePath, join(p.root, ".rider", "other", "default", "state.json"));
    assert.match(v.rows[0].decideWith, / --rider lemmaria --instance a --on 3f2a\.1 /);
    assert.deepEqual([v.skipped, v.errors], [[], []]);
  }
  const text = run("board");
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /── needs its judge \(1\) ─+\n  lemmaria\/a /);
  assert.match(text.out, /\n    decide with:  rider next <label> --rider lemmaria --instance a --on 3f2a\.1 --because "…"/);
  // A read: no v3 guard, no state directory for an instance that never ran.
  assert.equal(existsSync(join(p.root, ".rider", "lemmaria", "run.json")), false);
  assert.equal(existsSync(join(p.root, ".rider", "other")), false);
});

test("an orphan's id is accepted by status and reset, refused by next", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a"] });
  t.after(p.cleanup);
  put(p.root, "gone", { run: active([stretch("done", { stoppedAt: ago(1) })]) });
  const run = cli(p.root);
  const refusal = "instance gone has state but no directory (orphaned) — only status and reset accept it";
  const st = run("status", "--instance", "gone", "--json");
  assert.equal(st.code, 0, st.err);
  assert.deepEqual([JSON.parse(st.out).instance, JSON.parse(st.out).scope, JSON.parse(st.out).key], ["gone", "nodes/gone", "3f2a.1"]);
  for (const args of [["next", "code green", "--on", "3f2a.1", "--because", "x"], ["check"], ["resume", "--on", "3f2a.1"], ["note", "x"], ["await", "--max-minutes", "1"], ["watch"]]) {
    const r = run(...args, "--instance", "gone");
    assert.deepEqual([r.code, r.err.trim()], [2, refusal], args[0]);
  }
  const r = run("reset", "--instance", "gone", "--on", "3f2a", "--because", "its directory was renamed");
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(run("status", "--instance", "gone", "--json").out).lastRun.endedBy, "reset");
  // An id is a path under .rider/: one that is not a safe token never resolves, state or no state.
  put(p.root, "../escape", {});
  assert.equal(existsSync(join(p.root, ".rider", "escape", "state.json")), true);
  const esc = run("status", "--instance", "../escape");
  assert.equal(esc.code, 2);
  assert.match(esc.err, /no instance "\.\.\/escape"/);

  // A rider that stopped declaring instances: its old instances' state is orphaned too, and the board's hint works.
  const q = tmpProject();
  t.after(q.cleanup);
  put(q.root, "a", { lastRun: ended("done") });
  assert.deepEqual(collectBoard(q.root, { now: NOW, alive }).rows.map((r) => [r.instance, r.category]), [["a", "orphaned"], ["default", "idle"]]);
  assert.equal(cli(q.root)("status", "--instance", "a").code, 0);
  assert.equal(cli(q.root)("status", "--instance", "b").err.trim(), "lemmaria declares no instances — omit --instance");
});

test("an instance whose directory is deleted mid-run keeps working, and shows as orphaned with its run", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a"] });
  t.after(p.cleanup);
  const clock = new FakeClock();
  const ctxA = makeCtx({ root: p.root, instance: "a", clock, binding: new FakeBinding({ script: [{ statuses: ["running", "done"], read: { lastText: "STATUS: planned\n<promise>X</promise>" } }] }) });
  const { runId } = start(ctxA);
  rmSync(join(p.root, "nodes", "a"), { recursive: true });
  // The watcher's context was built before the deletion and never re-resolves: its state is under .rider/.
  assert.equal(check(ctxA).state, "running");
  assert.equal(check(ctxA).state, "done");
  const row = byInstance(collectBoard(p.root, { now: clock.now(), alive })).a;
  assert.deepEqual([row.category, row.phase, row.key, row.scope, row.decideWith], ["orphaned", "plan", `${runId}.1`, "nodes/a", null]);
  assert.deepEqual(resolveInstance(p.root, loadRider(p.file), "a"), { id: "a", scope: "nodes/a", declared: true, orphaned: true });
});

test("the instance's total cost sums its ended runs and its active run", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a", "b"] });
  t.after(p.cleanup);
  const run = active([stretch("done", { cost: 1, stoppedAt: ago(30) }), stretch("done", { id: "sid-2", cost: 2, stoppedAt: ago(2) })]);
  const paths = put(p.root, "a", { run });
  const record = (runId, startedAt, cost, extra = {}) => ({ ...active([stretch("done", { cost })], { runId, startedAt }), endedAt: ago(200), endedBy: "done", reason: "merge: check passed", ...extra });
  for (const r of [record("bbbb", ago(500), 1.5), record("cccc", ago(400), 0.25)]) writeJsonAtomic(endedRunPath(paths, r), r);
  // A crash between writing runs/ and state.json leaves the active run in both (§6.3): state.json is the truth.
  writeJsonAtomic(endedRunPath(paths, run), run);
  // With no active run, the latest decision is the ended run's last transition.
  const stop = { at: ago(11), from: "close", label: "blocked", to: "operator", because: "a design question", by: "judge" };
  const last = record("dddd", ago(100), 4, { endedBy: "operator", transitions: [stop] });
  const pb = put(p.root, "b", { lastRun: ended("operator", { runId: "dddd", startedAt: ago(100), totalCost: 4 }) });
  writeJsonAtomic(endedRunPath(pb, last), last);
  const rows = byInstance(collectBoard(p.root, { now: NOW, alive }));
  assert.deepEqual([rows.a.runCost, rows.a.instanceCost], [3, 4.75]);
  assert.deepEqual([rows.b.runCost, rows.b.instanceCost, rows.b.category], [4, 4, "needs you"]);
  assert.deepEqual(rows.b.decision, { label: "blocked", because: "a design question", by: "judge" });
});
