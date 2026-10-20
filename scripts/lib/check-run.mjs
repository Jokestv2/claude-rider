// scripts/lib/check-run.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootTime, sleepSync, writtenBeforeBoot } from "./proc.mjs";
import { capText } from "./shell.mjs";

const RUNNER = fileURLToPath(new URL("../check-runner.mjs", import.meta.url));

/** check.pid as `{ pgid, at }`, or null. A pgid of 0 or 1 would signal this process's own group or every process it may
 *  signal, so a file that names no real group, or no readable time, names nothing. */
function readCheckPid(paths) {
  let rec;
  try { rec = JSON.parse(readFileSync(paths.checkPid, "utf8")); } catch { return null; }
  const at = Date.parse(rec?.at);
  return Number.isInteger(rec?.pgid) && rec.pgid > 1 && Number.isFinite(at) ? { pgid: rec.pgid, at } : null;
}
/** The group, not its leader: the shell may have exited while a child it started still runs. */
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; }
}
/** Polls the pgid itself, not check.pid: the runner removes the file once its shell dies, while a child that ignores SIGTERM may live on. */
function killGroup(pgid, { graceMs, sleep }) {
  signalGroup(pgid, "SIGTERM");
  for (let waited = 0; waited < graceMs && groupAlive(pgid); waited += 100) sleep(100);
  if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
}

/** check.pid while it names a live group. One written before the boot names none, whatever its pgid now is (§7.10);
 *  `at` is real time, since the runner is its own process on the real clock. */
function liveCheck(paths, bootMs) {
  const rec = readCheckPid(paths);
  return rec && !writtenBeforeBoot(rec.at, bootMs) && groupAlive(rec.pgid) ? rec : null;
}
/** The pgid of the await check now running in this instance, or null. */
export function checkGroupAlive(paths, { bootMs = bootTime() } = {}) { return liveCheck(paths, bootMs)?.pgid ?? null; }

/** For `reset`, through `killWatcher`, under the instance lock: with no check running it returns at once and never sleeps there. */
export function killCheckGroup(paths, { graceMs = 2000, sleep = sleepSync } = {}) {
  const pgid = checkGroupAlive(paths);
  if (!pgid) return false;
  killGroup(pgid, { graceMs, sleep });
  rmSync(paths.checkPid, { force: true });
  return true;
}

/** One run of an await check, in its own process group through the runner (§7.3.1); the watcher stays synchronous. A
 *  live group in check.pid is a tick still running, so it is waited for: two ticks never run at once. One older than any
 *  check could run lost its runner, so nothing enforces its timeout, and it is killed. */
export function runCheckProcess(paths, { cmd, cwd, shell, env, timeoutMs, key, graceMs = 2000, sleep = sleepSync, bootMs = bootTime() }) {
  const staleMs = timeoutMs + graceMs + 60_000;
  for (let rec = liveCheck(paths, bootMs); rec; rec = liveCheck(paths, bootMs)) {
    if (Date.now() - rec.at > staleMs) { killGroup(rec.pgid, { graceMs, sleep }); rmSync(paths.checkPid, { force: true }); } else sleep(500);
  }
  const spec = { cmd, cwd, shell, timeoutMs, graceMs, outFile: paths.checkOut, pidFile: paths.checkPid, key };
  const r = spawnSync(process.execPath, [RUNNER, JSON.stringify(spec)], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs + graceMs + 10_000, windowsHide: true });
  let answer = null;
  try { answer = JSON.parse((r.stdout ?? "").trim().split("\n").at(-1)); } catch { /* no answer */ }
  if (answer && typeof answer === "object" && "status" in answer) return { status: answer.status, timedOut: answer.timedOut === true, output: answer.output ?? "", error: answer.error ?? null };
  return { status: -1, timedOut: false, output: capText((r.stderr ?? "").trim(), 2048), error: r.error?.message ?? `the check runner gave no answer (exit ${r.status ?? r.signal})` };
}
