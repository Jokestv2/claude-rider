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
import { killWatcher } from "../scripts/lib/watcher-spawn.mjs";
import { makeCtx, tmpProject } from "./helpers.mjs";

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
 *  a sync sleep blocks the event loop, and a zombie keeps its group alive. */
function liveGroup(box, seconds) {
  const r = spawnSync(SHELL, ["-c", `sleep ${seconds} >/dev/null 2>&1 & echo $!`], { detached: true, encoding: "utf8" });
  box.killGroup(r.pid);
  box.killPid(Number(r.stdout.trim()));
  assert.ok(groupAlive(r.pid), "the group is alive");
  return r.pid;
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
  const { closed } = startRunner(box, paths, "sleep 2", { key: "k7" });
  const rec = await runningGroup(box, paths);
  assert.ok(Number.isInteger(rec.pgid) && rec.pgid > 1, `pgid ${rec.pgid}`);
  assert.equal(rec.key, "k7");
  assert.ok(Number.isFinite(Date.parse(rec.at)));
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
  writeJsonAtomic(paths.checkPid, { pgid, key: "old", at: new Date().toISOString(), runner: pgid });
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

test("a live group whose runner died is killed once it is older than the check could run", (t) => {
  const box = sandbox(t);
  const paths = box.paths();
  const pgid = liveGroup(box, 30);
  writeJsonAtomic(paths.checkPid, { pgid, key: "old", at: new Date(Date.now() - 120_000).toISOString(), runner: pgid });
  const r = check(box, paths, "exit 75", { timeoutMs: 1000 });
  assert.equal(r.status, 75);
  assert.equal(groupAlive(pgid), false);
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
