// scripts/lib/watcher-spawn.mjs
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { killCheckGroup } from "./check-run.mjs";
import { bootTime, isAlive, writtenBeforeBoot } from "./proc.mjs";
import { writeJsonAtomic } from "./store.mjs";

const RIDER_SCRIPT = fileURLToPath(new URL("../rider.mjs", import.meta.url));

function readPid(path) {
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Replaced whole by a rename: board, status and await read it with no lock, and must never find it empty. */
export function writeWatchPid(paths, pid) { writeJsonAtomic(paths.watchPid, pid); }

/** After a reboot the pid in a surviving watch.pid can name an unrelated process (§7.10); the file is replaced whole, so its mtime is when it was written.
 *  The rule rests on the wall clock and on a local filesystem: a clock stepped forward, or a network filesystem's own mtime clock, can misdate the file.
 *  The board and status read it with no lock, while `killWatcher` may be removing it. */
export function watcherAlive(paths, alive = isAlive, { bootMs = bootTime() } = {}) {
  const pid = readPid(paths.watchPid);
  if (!pid || !alive(pid)) return null;
  let mtimeMs;
  try { mtimeMs = statSync(paths.watchPid).mtimeMs; } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  return writtenBeforeBoot(mtimeMs, bootMs) ? null : pid;
}

/** One watcher per instance with a live phase, detached from the invoking process tree (§4.6, §13). The caller holds
 *  the instance's lock: the liveness test and the pid write must not interleave with another writer's. Returns true when it spawned. */
export function ensureWatcher(paths, { riderName, instance, root, script = RIDER_SCRIPT, alive = isAlive, spawn = nodeSpawn }) {
  if (watcherAlive(paths, alive)) return false;
  mkdirSync(paths.logs, { recursive: true });
  const out = openSync(paths.watchLog, "a");
  const child = spawn(process.execPath, [script, "watch", "--rider", riderName, "--instance", instance], { cwd: root, detached: true, stdio: ["ignore", out, out], windowsHide: true });
  child.unref();
  writeWatchPid(paths, child.pid);
  return true;
}

/** The watcher first, so it starts no further check; then the group of a check it left running, which the watcher's
 *  death does not end (§7.3.1). A reset then cannot overlap a tick from the run it forgets. Neither kill throws on a
 *  signal, so a reset always ends its run. `checkOpts` reaches `killCheckGroup`: the tests' signaller and sleep. */
export function killWatcher(paths, alive = isAlive, checkOpts = {}) {
  const pid = watcherAlive(paths, alive);
  if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  rmSync(paths.watchPid, { force: true });
  killCheckGroup(paths, checkOpts);
}
