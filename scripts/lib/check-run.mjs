// scripts/lib/check-run.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootTime, sleepSync, writtenBeforeBoot } from "./proc.mjs";
import { capText } from "./shell.mjs";

const RUNNER = fileURLToPath(new URL("../check-runner.mjs", import.meta.url));
/** How long past a tick's own deadline its pgid is still taken for the tick's: a group whose runner died is killed
 *  within it, and past it the pgid may name a reused group, so it is never signalled. */
const WINDOW_MS = 60_000;

/** check.pid as `{ pgid, at, runner, timeoutMs }`, or null. A pgid of 0 or 1 would signal this process's own group or
 *  every process it may signal, so a file that names no real group, or no readable time, names nothing. A `runner` or
 *  `timeoutMs` that is missing or malformed is null: a runner of 0 would probe this process's own group, and such a
 *  record can be dropped but never trusted. */
function readCheckPid(paths) {
  let rec;
  try { rec = JSON.parse(readFileSync(paths.checkPid, "utf8")); } catch { return null; }
  const at = Date.parse(rec?.at);
  if (!Number.isInteger(rec?.pgid) || rec.pgid <= 1 || !Number.isFinite(at)) return null;
  const runner = Number.isInteger(rec.runner) && rec.runner > 1 ? rec.runner : null;
  const timeoutMs = typeof rec.timeoutMs === "number" && Number.isFinite(rec.timeoutMs) && rec.timeoutMs > 0 ? rec.timeoutMs : null;
  return { pgid: rec.pgid, at, runner, timeoutMs };
}
/** A pid, or a group as a negative pid, exists: EPERM says it does, under another user. `kill` is the seam tests stub. */
const exists = (pid, kill) => { try { kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** The group, not its leader: the shell may have exited while a child it started still runs. */
export function groupAlive(pgid, kill = process.kill) { return exists(-pgid, kill); }
/** True when the signal reached the group. A group that is gone (ESRCH) and one whose every process is another user's
 *  (EPERM: a reused pgid, or a setuid helper) are alike: there is nothing more to do, so neither throws. */
export function signalGroup(pgid, signal, kill = process.kill) {
  try { kill(-pgid, signal); return true; } catch (e) { if (e.code === "ESRCH" || e.code === "EPERM") return false; throw e; }
}
/** Polls the pgid itself, not check.pid: the runner removes the file once its shell dies, while a child that ignores
 *  SIGTERM may live on. A group SIGTERM could not reach, SIGKILL cannot either, so no grace is waited for it. */
function killGroup(pgid, { graceMs, sleep, kill }) {
  if (!signalGroup(pgid, "SIGTERM", kill)) return false;
  for (let waited = 0; waited < graceMs && groupAlive(pgid, kill); waited += 100) sleep(100);
  if (groupAlive(pgid, kill)) signalGroup(pgid, "SIGKILL", kill);
  return true;
}

/** The ownership rule: what a check.pid record lets this process do with the group it names, where the tick's
 *  `deadline` is its own `at + timeoutMs + graceMs`. "wait": the tick is ours and running, either its runner lives and
 *  enforces its timeout (a), or nothing does but the tick is within its own budget (b). "kill": its runner is dead and
 *  it has overrun, so nobody else will stop it (c). "drop": nothing is running, or the pgid can no longer be told apart
 *  from a reused one, written before the boot (§7.10), past its deadline and the window, or in a record with no runner
 *  or timeout (d). The cheap tests come first, so a dropped record is never even probed. */
function ownership(rec, { now, graceMs, bootMs, kill }) {
  if (writtenBeforeBoot(rec.at, bootMs) || rec.runner == null || rec.timeoutMs == null) return "drop";
  const deadline = rec.at + rec.timeoutMs + graceMs;
  if (now >= deadline + WINDOW_MS) return "drop";
  if (exists(rec.runner, kill)) return "wait";
  if (!groupAlive(rec.pgid, kill)) return "drop";
  return now < deadline ? "wait" : "kill";
}

/** check.pid while it names a live group. One written before the boot names none, whatever its pgid now is (§7.10);
 *  `at` is real time, since the runner is its own process on the real clock. */
function liveCheck(paths, bootMs, kill) {
  const rec = readCheckPid(paths);
  return rec && !writtenBeforeBoot(rec.at, bootMs) && groupAlive(rec.pgid, kill) ? rec : null;
}
/** The pgid of the await check now running in this instance, or null. */
export function checkGroupAlive(paths, { bootMs = bootTime(), kill = process.kill } = {}) { return liveCheck(paths, bootMs, kill)?.pgid ?? null; }

/** For `reset`, through `killWatcher`, under the instance lock. It kills the group of any tick the ownership rule calls
 *  ours, its runner alive or not, and signals nothing else. check.pid is removed whatever the kill did, so a reset never
 *  fails on a signal, and a record nobody can act on is not left behind. With no check running it returns at once and
 *  never sleeps there. True when a signal reached the group. */
export function killCheckGroup(paths, { graceMs = 2000, sleep = sleepSync, kill = process.kill, now = Date.now, bootMs = bootTime() } = {}) {
  const rec = readCheckPid(paths);
  const killed = !!rec && ownership(rec, { now: now(), graceMs, bootMs, kill }) !== "drop" && killGroup(rec.pgid, { graceMs, sleep, kill });
  rmSync(paths.checkPid, { force: true });
  return killed;
}

/** One run of an await check, in its own process group through the runner (§7.3.1); the watcher stays synchronous.
 *  Before it, a tick named in check.pid is dealt with by the ownership rule: waited for while its group or its runner
 *  lives, so two ticks never run at once and the old runner has removed its output file before the next one opens it;
 *  killed once it has overrun with nobody to stop it; dropped without a signal once its pgid may be another's. */
export function runCheckProcess(paths, { cmd, cwd, shell, env, timeoutMs, key, graceMs = 2000, sleep = sleepSync, bootMs = bootTime(), kill = process.kill, now = Date.now }) {
  for (let rec = readCheckPid(paths); rec; rec = readCheckPid(paths)) {
    const verdict = ownership(rec, { now: now(), graceMs, bootMs, kill });
    if (verdict === "wait") { sleep(500); continue; }
    if (verdict === "kill") killGroup(rec.pgid, { graceMs, sleep, kill });
    rmSync(paths.checkPid, { force: true });
    break;
  }
  const spec = { cmd, cwd, shell, timeoutMs, graceMs, outFile: paths.checkOut, pidFile: paths.checkPid, key };
  const r = spawnSync(process.execPath, [RUNNER, JSON.stringify(spec)], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs + graceMs + 10_000, windowsHide: true });
  let answer = null;
  try { answer = JSON.parse((r.stdout ?? "").trim().split("\n").at(-1)); } catch { /* no answer */ }
  if (answer && typeof answer === "object" && "status" in answer) return { status: answer.status, timedOut: answer.timedOut === true, output: answer.output ?? "", error: answer.error ?? null };
  return { status: -1, timedOut: false, output: capText((r.stderr ?? "").trim(), 2048), error: r.error?.message ?? `the check runner gave no answer (exit ${r.status ?? r.signal})` };
}
