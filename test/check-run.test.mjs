// test/check-run.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { checkGroupAlive, killCheckGroup, runCheckProcess } from "../scripts/lib/check-run.mjs";
import { createContext } from "../scripts/lib/context.mjs";
import { isAlive, sleepSync } from "../scripts/lib/proc.mjs";
import { instancePaths, writeJsonAtomic } from "../scripts/lib/store.mjs";
import { reset, start } from "../scripts/lib/verbs.mjs";
import { killWatcher } from "../scripts/lib/watcher-spawn.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { AWAIT_PROMPTS, AWAIT_RIDER_MD, makeCtx, tmpProject } from "./helpers.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/check-runner.mjs", import.meta.url));
const SHELL = "/bin/sh";
const CAP_NOTE = "\n… capped at 2048 bytes";

const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const quietly = (fn) => { try { fn(); } catch { /* already gone */ } };

/** A fresh project root whose `t.after` kills every process and group the test registered before it removes the root,
 *  whatever the test's outcome: these tests start real processes, and none may outlive the suite. */
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "rider-check-"));
  const pids = [];
  const groups = [];
  t.after(() => {
    for (const g of groups) if (Number.isInteger(g) && g > 1) quietly(() => process.kill(-g, "SIGKILL"));
    for (const p of pids) if (Number.isInteger(p) && p > 1) quietly(() => process.kill(p, "SIGKILL"));
    rmSync(root, { recursive: true, force: true });
  });
  const paths = (id = "default") => { const p = instancePaths(root, "lemmaria", id); mkdirSync(p.dir, { recursive: true }); return p; };
  return { root, paths, killPid: (p) => pids.push(p), killGroup: (g) => groups.push(g) };
}

/** A live process group whose leader is not this process's child: the shell that made it has exited and been reaped,
 *  and its one member is an orphan that init reaps. A group this process spawned itself would linger as a zombie while
 *  a sync sleep blocks the event loop, and a zombie keeps its group alive. Returns the group and its member's pid. */
function orphan(box, seconds) {
  const r = spawnSync(SHELL, ["-c", `sleep ${seconds} >/dev/null 2>&1 & echo $!`], { detached: true, encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  box.killGroup(r.pid);
  box.killPid(pid);
  assert.ok(groupAlive(r.pid), "the group is alive");
  return { pgid: r.pid, pid };
}
const liveGroup = (box, seconds) => orphan(box, seconds).pgid;

/** Pids no process can have: above Linux's largest pid_max (2^22) and macOS's. A real signal that slipped past a stub
 *  would find no process. */
const FAKE_PGID = 4_194_401;
const FAKE_RUNNER = 4_194_402;
/** A check.pid record as the runner writes it, `at` on the real clock. */
const record = ({ pgid = FAKE_PGID, runner = FAKE_RUNNER, at = Date.now(), timeoutMs = 10_000 } = {}) => ({ pgid, key: "old", at: new Date(at).toISOString(), runner, timeoutMs });
const probe = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code; } };
/** A signaller that sends no real signal. It records each call and answers it with `answer(pid, signal)`: true, or the
 *  code it throws. By default a probe (signal 0) asks the real process table, and any other signal is only recorded. */
function stubKill(answer = (pid, signal) => (signal === 0 ? probe(pid) : true)) {
  const calls = [];
  const kill = (pid, signal = "SIGTERM") => {
    calls.push([pid, signal]);
    const a = answer(pid, signal);
    if (a === true) return true;
    throw Object.assign(new Error(`kill ${a}`), { code: a });
  };
  kill.calls = calls;
  kill.sent = () => calls.filter(([, signal]) => signal !== 0);
  return kill;
}

/** The runner started as the watcher would, but asynchronously, so the test can look at check.pid while it runs. */
function startRunner(box, paths, cmd, { key = "k1", timeoutMs = 10_000 } = {}) {
  const spec = { cmd, cwd: box.root, shell: SHELL, timeoutMs, graceMs: 2000, outFile: paths.checkOut, pidFile: paths.checkPid, key };
  const child = spawn(process.execPath, [RUNNER, JSON.stringify(spec)], { stdio: ["ignore", "pipe", "pipe"] });
  box.killPid(child.pid);
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.resume();
  const closed = new Promise((resolve) => child.on("close", () => resolve(stdout)));
  return { child, closed };
}

async function until(predicate, { ms = 3000, what = "the condition" } = {}) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`${what} did not hold within ${ms} ms`);
    await delay(25);
  }
}

async function runningGroup(box, paths) {
  await until(() => existsSync(paths.checkPid), { what: "check.pid exists" });
  const rec = JSON.parse(readFileSync(paths.checkPid, "utf8"));
  box.killGroup(rec.pgid);
  return rec;
}

const check = (box, paths, cmd, opts = {}) => runCheckProcess(paths, { cmd, cwd: box.root, shell: SHELL, timeoutMs: 10_000, key: "k1", ...opts });

test("a timeout kills the check's grandchildren, not only its shell", async (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const r = check(box, paths, "sleep 30 & echo $! > gc.pid; wait", { timeoutMs: 500 });
  const gc = Number(readFileSync(join(box.root, "gc.pid"), "utf8").trim());
  box.killPid(gc);
  assert.equal(r.timedOut, true);
  assert.equal(r.status, -1);
  await until(() => !isAlive(gc), { what: "the grandchild is dead" });
  assert.equal(existsSync(paths.checkPid), false);
  assert.equal(existsSync(paths.checkOut), false);
});

test("what ignores SIGTERM is killed after the grace, on a timeout and on a reset", async (t) => {
  // The shell dies of SIGTERM, so the runner removes check.pid, while the grandchild ignores it: an ignored signal
  // stays ignored across exec. What is still in the group must be found by its pgid, not by the file.
  const box = sandbox(t);
  const paths = box.paths();
  const stubborn = "(trap '' TERM; : > armed; exec sleep 30) & echo $! > gc.pid; wait";
  const gcFile = join(box.root, "gc.pid");
  const armed = join(box.root, "armed");
  let t0 = Date.now();
  const r = check(box, paths, stubborn, { timeoutMs: 300, graceMs: 300 });
  const gc = Number(readFileSync(gcFile, "utf8").trim());
  box.killPid(gc);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 >= 600, `answered after ${Date.now() - t0} ms, before the grace ran out`);
  await until(() => !isAlive(gc), { what: "the timed-out grandchild is dead" });
  rmSync(gcFile);
  rmSync(armed);
  startRunner(box, paths, stubborn);
  const { pgid } = await runningGroup(box, paths);
  await until(() => existsSync(armed), { what: "the grandchild ignores SIGTERM" });
  t0 = Date.now();
  assert.equal(killCheckGroup(paths, { graceMs: 300 }), true);
  assert.ok(Date.now() - t0 >= 300, `killed after ${Date.now() - t0} ms, before the grace ran out`);
  await until(() => !groupAlive(pgid), { what: "the reset group is gone" });
});

test("a background child does not hold the poll", (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const t0 = Date.now();
  const r = check(box, paths, "sleep 5 & echo $! > bg.pid; exit 75");
  box.killPid(Number(readFileSync(join(box.root, "bg.pid"), "utf8").trim()));
  assert.equal(r.status, 75);
  assert.equal(r.timedOut, false);
  assert.ok(Date.now() - t0 < 2000, `returned in ${Date.now() - t0} ms`);
});

test("output is captured from the file and capped at 2 KB", (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const big = check(box, paths, "head -c 5000 /dev/zero | tr '\\0' x; exit 75");
  assert.equal(big.status, 75);
  assert.ok(big.output.length <= 2048 + CAP_NOTE.length, `output is ${big.output.length} chars`);
  assert.equal(big.output, `${"x".repeat(2048)}${CAP_NOTE}`);
  const binary = check(box, paths, "printf '\\377\\376'; exit 75");
  assert.equal(binary.status, 75);
  assert.equal(typeof binary.output, "string");
  const empty = check(box, paths, "exit 75");
  assert.deepEqual(empty, { status: 75, timedOut: false, output: "", error: null });
  const both = check(box, paths, "echo out; echo err >&2; exit 0");
  assert.deepEqual(both, { status: 0, timedOut: false, output: "out\nerr", error: null });
});

test("a check that cannot spawn is an error, not a hang", (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const r = check(box, paths, "exit 0", { cwd: join(box.root, "missing") });
  assert.equal(r.status, -1);
  assert.equal(r.timedOut, false);
  assert.match(r.error, /ENOENT/);
  assert.equal(existsSync(paths.checkPid), false);
});

test("check.pid names the group while the check runs, and is gone after", async (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const { child, closed } = startRunner(box, paths, "sleep 2", { key: "k7" });
  const rec = await runningGroup(box, paths);
  assert.ok(Number.isInteger(rec.pgid) && rec.pgid > 1, `pgid ${rec.pgid}`);
  assert.equal(rec.key, "k7");
  assert.ok(Number.isFinite(Date.parse(rec.at)));
  assert.deepEqual([rec.runner, rec.timeoutMs], [child.pid, 10_000], "the runner and the timeout it enforces");
  assert.equal(checkGroupAlive(paths), rec.pgid);
  const answer = JSON.parse((await closed).trim().split("\n").at(-1));
  assert.deepEqual(answer, { status: 0, timedOut: false, output: "", error: null });
  assert.equal(existsSync(paths.checkPid), false);
  assert.equal(checkGroupAlive(paths), null);
});

test("killWatcher kills a running check's group", async (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const { closed } = startRunner(box, paths, "sleep 30");
  const { pgid } = await runningGroup(box, paths);
  killWatcher(paths);
  await until(() => !groupAlive(pgid), { what: "the check's group is gone" });
  assert.equal(checkGroupAlive(paths), null);
  const answer = JSON.parse((await closed).trim().split("\n").at(-1));
  assert.equal(answer.status, -1);
  assert.equal(answer.timedOut, false);
  assert.match(answer.error, /SIG/);
});

test("killCheckGroup with no check running returns at once", (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const slept = [];
  killCheckGroup(paths, { sleep: (ms) => slept.push(ms) });
  // A check.pid whose group has exited is no check running either.
  const gone = spawnSync(SHELL, ["-c", "exit 0"], { detached: true }).pid;
  writeJsonAtomic(paths.checkPid, { pgid: gone, key: "k1", at: new Date().toISOString(), runner: gone });
  killCheckGroup(paths, { sleep: (ms) => slept.push(ms) });
  assert.deepEqual(slept, []);
});

test("a check.pid that names no group reads as dead", (t) => {
  // A pgid of 0 or 1 would signal this process's own group, or every process it may signal.
  const box = sandbox(t);
  const paths = box.paths();
  const at = new Date().toISOString();
  for (const pgid of [0, 1, -5, "12", null]) {
    writeJsonAtomic(paths.checkPid, { pgid, key: "k1", at, runner: 1 });
    assert.equal(checkGroupAlive(paths), null, `pgid ${JSON.stringify(pgid)}`);
  }
  writeJsonAtomic(paths.checkPid, { pgid: process.pid, key: "k1", at: "not a time", runner: 1 });
  assert.equal(checkGroupAlive(paths), null, "an unreadable time");
  writeFileSync(paths.checkPid, "{ torn");
  assert.equal(checkGroupAlive(paths), null, "a torn file");
});

test("a live group in check.pid is waited for before the next check", (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const pgid = liveGroup(box, 1);
  // Its runner (the leader's pid, long reaped) is dead, but the tick is still within its own timeout: case (b).
  writeJsonAtomic(paths.checkPid, record({ pgid, runner: pgid }));
  const slept = [];
  const t0 = Date.now();
  const r = check(box, paths, "exit 75", { sleep: (ms) => { slept.push(ms); sleepSync(ms); } });
  assert.equal(r.status, 75);
  assert.ok(Date.now() - t0 >= 900, `returned after ${Date.now() - t0} ms`);
  assert.ok(slept.length >= 1 && slept.every((ms) => ms === 500), `slept ${slept}`);
});

test("a check.pid written before the boot is not waited for", (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const pgid = liveGroup(box, 30);
  writeJsonAtomic(paths.checkPid, { pgid, key: "old", at: new Date(Date.now() - 3_600_000).toISOString(), runner: pgid });
  const slept = [];
  const r = check(box, paths, "exit 75", { sleep: (ms) => slept.push(ms), bootMs: Date.now() - 60_000 });
  assert.equal(r.status, 75);
  assert.deepEqual(slept, []);
  // Its pid may now name an unrelated process: it is neither waited for nor killed.
  assert.ok(groupAlive(pgid), "the group the file names is left alone");
});

test("a live group whose runner died is killed once it has overrun its own timeout", (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const pgid = liveGroup(box, 30);
  // Its deadline (at + timeoutMs + grace) passed 27 s ago, within the window in which its pgid is still taken for its own.
  writeJsonAtomic(paths.checkPid, record({ pgid, runner: pgid, at: Date.now() - 30_000, timeoutMs: 1000 }));
  const slept = [];
  const r = check(box, paths, "exit 75", { sleep: (ms) => { slept.push(ms); sleepSync(ms); } });
  assert.equal(r.status, 75);
  assert.equal(slept.includes(500), false, `killed, not waited for: slept ${slept}`);
  assert.equal(groupAlive(pgid), false);
  assert.equal(existsSync(paths.checkPid), false);
});

test("a tick whose runner lives is waited for past this call's own timeout, and never signalled", (t) => {
  // A watcher died mid-tick at a phase whose check may take an hour; the run moved to one whose check takes a minute.
  // This call's own timeout would call the tick stale after about 2 min; its runner, alive, still enforces its hour.
  const box = sandbox(t);
  const paths = box.paths();
  const pgid = liveGroup(box, 30);
  const runner = orphan(box, 30);
  writeJsonAtomic(paths.checkPid, record({ pgid, runner: runner.pid, at: Date.now() - 200_000, timeoutMs: 3_600_000 }));
  const kill = stubKill();
  const slept = [];
  const sleep = (ms) => {
    slept.push(ms);
    assert.ok(groupAlive(pgid), "the tick runs on while it is waited for");
    if (slept.length < 3) return;
    // The tick ends: its group and its runner exit, as a runner whose check finished does.
    for (const g of [pgid, runner.pgid]) quietly(() => process.kill(-g, "SIGKILL"));
    for (let i = 0; i < 150 && (groupAlive(pgid) || isAlive(runner.pid)); i++) sleepSync(20);
  };
  const r = check(box, paths, "exit 75", { timeoutMs: 60_000, kill, sleep });
  assert.equal(r.status, 75);
  assert.deepEqual(kill.sent(), [], "no signal: its runner enforces its own timeout");
  assert.deepEqual(slept, [500, 500, 500]);
});

test("the next check waits for the old runner too, not only its group", (t) => {
  // The group is gone and the runner is finishing: it removes the output file before check.pid, and the next runner
  // must not open check.out before that removal.
  const box = sandbox(t);
  const paths = box.paths();
  writeJsonAtomic(paths.checkPid, record());
  let runnerUp = 2;
  const kill = stubKill((pid) => (pid === FAKE_RUNNER && runnerUp > 0 ? true : "ESRCH"));
  const slept = [];
  const r = check(box, paths, "exit 75", { kill, sleep: (ms) => { slept.push(ms); runnerUp--; } });
  assert.equal(r.status, 75);
  assert.deepEqual(slept, [500, 500]);
  assert.deepEqual(kill.sent(), []);
});

test("an overrun tick whose runner died is killed through the signaller, and its check.pid removed", (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  writeJsonAtomic(paths.checkPid, record({ at: Date.now() - 30_000, timeoutMs: 1000 }));
  let groupUp = true;
  const kill = stubKill((pid, signal) => {
    if (pid !== -FAKE_PGID) return "ESRCH";
    if (signal === "SIGTERM") groupUp = false;
    return groupUp || signal !== 0 || "ESRCH";
  });
  const r = check(box, paths, "exit 75", { kill, sleep: () => {} });
  assert.equal(r.status, 75);
  assert.deepEqual(kill.sent(), [[-FAKE_PGID, "SIGTERM"]]);
  assert.equal(existsSync(paths.checkPid), false);
});

test("a record past its deadline and the window, or with no runner or timeout, is dropped and never signalled", (t) => {
  // Its pgid can no longer be told from a reused one: here it names a live group of this test's own, standing in for
  // an unrelated one. Neither the next check nor a reset may signal it.
  const box = sandbox(t);
  const paths = box.paths();
  const pgid = liveGroup(box, 30);
  const old = record({ pgid, runner: pgid, at: Date.now() - 600_000, timeoutMs: 1000 });
  const kill = stubKill();
  writeJsonAtomic(paths.checkPid, old);
  assert.equal(check(box, paths, "exit 75", { kill, sleep: () => assert.fail("nothing to wait for") }).status, 75);
  assert.deepEqual(kill.calls, [], "not even a probe");
  for (const rec of [old, { pgid, key: "old", at: new Date().toISOString() }, { ...record({ pgid }), runner: 0 }, { ...record({ pgid }), timeoutMs: "10000" }]) {
    writeJsonAtomic(paths.checkPid, rec);
    assert.equal(killCheckGroup(paths, { kill, sleep: () => assert.fail("nothing to wait for") }), false, JSON.stringify(rec));
    assert.equal(existsSync(paths.checkPid), false, JSON.stringify(rec));
  }
  assert.deepEqual(kill.calls, [], "not even a probe");
  assert.ok(groupAlive(pgid), "the group the file names is left alone");
});

test("EPERM is no throw: killCheckGroup returns, check.pid is gone, and no grace is waited", (t) => {
  // kill(-pgid) answers EPERM when every process left in the group is another user's: a reused pgid, or a setuid helper.
  const box = sandbox(t);
  const paths = box.paths();
  writeJsonAtomic(paths.checkPid, record());
  const kill = stubKill(() => "EPERM");
  assert.equal(killCheckGroup(paths, { kill, sleep: () => assert.fail("no grace for a group nothing can reach") }), false);
  assert.deepEqual(kill.sent(), [[-FAKE_PGID, "SIGTERM"]], "it tried, and nothing it may signal is left");
  assert.equal(existsSync(paths.checkPid), false);
  // The wait loop's stale path alike: an overrun record whose group answers EPERM is dropped, and the check runs.
  writeJsonAtomic(paths.checkPid, record({ at: Date.now() - 30_000, timeoutMs: 1000 }));
  const stale = stubKill((pid) => (pid === -FAKE_PGID ? "EPERM" : "ESRCH"));
  assert.equal(check(box, paths, "exit 75", { kill: stale, sleep: () => {} }).status, 75);
  assert.deepEqual(stale.sent(), [[-FAKE_PGID, "SIGTERM"]]);
});

test("reset ends the run when the check's group answers EPERM", (t) => {
  const p = tmpProject({ riderMd: AWAIT_RIDER_MD, prompts: AWAIT_PROMPTS });
  t.after(p.cleanup);
  const paths = instancePaths(p.root, "lemmaria", "default");
  const kill = stubKill(() => "EPERM");
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding(), killWatcher: () => killWatcher(paths, () => false, { kill, sleep: () => {} }) });
  const { runId } = start(ctx, { phase: "wait" });
  writeJsonAtomic(paths.checkPid, record());
  const r = reset(ctx, { on: runId });
  assert.deepEqual([r.ok, r.state], [true, "none"]);
  assert.equal(ctx.loadRun(), null);
  assert.equal(ctx.lastEndedRun().endedBy, "reset");
  assert.equal(existsSync(paths.checkPid), false);
  assert.deepEqual(kill.sent(), [[-FAKE_PGID, "SIGTERM"]]);
});

test("a runner whose check.pid a reset removed leaves check.out to the next runner", async (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const { closed } = startRunner(box, paths, "sleep 1");
  await runningGroup(box, paths);
  // A reset removed check.pid, and a fresh run's runner wrote its own and opened check.out, all before this one's
  // check exits.
  writeJsonAtomic(paths.checkPid, record());
  writeFileSync(paths.checkOut, "the next tick's output\n");
  await closed;
  assert.equal(readFileSync(paths.checkOut, "utf8"), "the next tick's output\n");
  assert.equal(JSON.parse(readFileSync(paths.checkPid, "utf8")).pgid, FAKE_PGID);
});

test("two instances' groups are their own", async (t) => {
  const box = sandbox(t);
  const a = box.paths("a");
  const b = box.paths("b");
  startRunner(box, a, "sleep 30");
  startRunner(box, b, "sleep 30");
  const ga = (await runningGroup(box, a)).pgid;
  const gb = (await runningGroup(box, b)).pgid;
  assert.notEqual(ga, gb);
  killCheckGroup(a);
  await until(() => !groupAlive(ga), { what: "a's group is gone" });
  assert.equal(checkGroupAlive(a), null);
  assert.equal(checkGroupAlive(b), gb);
  assert.ok(groupAlive(gb), "b's check runs on");
});

test("ctx.runCheck: the runner by default, an override when given; tests default to an in-process sh", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const rider = { name: "lemmaria" };
  const instance = { id: "default", scope: null, declared: false };
  const env = { ...process.env, RIDER_SEEN: "seen" };
  writeFileSync(join(p.root, "here.txt"), "here");
  const real = createContext({ rider, instance, root: p.root, local: {}, binding: null });
  assert.deepEqual(real.runCheck("echo $RIDER_SEEN; cat here.txt; exit 75", { timeoutMs: 10_000, env, key: "k1" }), { status: 75, timedOut: false, output: "seen\nhere", error: null });
  const calls = [];
  const scripted = createContext({ rider, instance, root: p.root, local: {}, binding: null, runCheck: (cmd, opts) => { calls.push([cmd, opts]); return { status: 0, timedOut: false, output: "ok", error: null }; } });
  assert.deepEqual(scripted.runCheck("tool tick", { timeoutMs: 1000, env, key: "k2" }), { status: 0, timedOut: false, output: "ok", error: null });
  assert.deepEqual(calls, [["tool tick", { timeoutMs: 1000, env, key: "k2" }]]);
  const ctx = makeCtx({ root: p.root });
  assert.equal(ctx.runCheck("test -f ready.flag || exit 75", { timeoutMs: 10_000, key: "k3" }).status, 75);
  writeFileSync(join(p.root, "ready.flag"), "");
  assert.deepEqual(ctx.runCheck("test -f ready.flag || exit 75", { timeoutMs: 10_000, key: "k3" }), { status: 0, timedOut: false, output: "", error: null });
  assert.equal(ctx.runCheck("exec sleep 5", { timeoutMs: 200, key: "k3" }).timedOut, true);
});
