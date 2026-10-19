// scripts/lib/watcher-spawn.mjs
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAlive } from "./proc.mjs";

const RIDER_SCRIPT = fileURLToPath(new URL("../rider.mjs", import.meta.url));

function readPid(path) {
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function watcherAlive(paths, alive = isAlive) {
  const pid = readPid(paths.watchPid);
  return pid && alive(pid) ? pid : null;
}

/** One watcher per instance with a live phase, detached from the invoking process tree (§4.6, §13). The caller holds
 *  the instance's lock: the liveness test and the pid write must not interleave with another writer's. Returns true when it spawned. */
export function ensureWatcher(paths, { riderName, instance, root, script = RIDER_SCRIPT, alive = isAlive, spawn = nodeSpawn }) {
  if (watcherAlive(paths, alive)) return false;
  mkdirSync(paths.logs, { recursive: true });
  const out = openSync(paths.watchLog, "a");
  const child = spawn(process.execPath, [script, "watch", "--rider", riderName, "--instance", instance], { cwd: root, detached: true, stdio: ["ignore", out, out], windowsHide: true });
  child.unref();
  writeFileSync(paths.watchPid, String(child.pid));
  return true;
}

export function killWatcher(paths, alive = isAlive) {
  const pid = watcherAlive(paths, alive);
  if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  rmSync(paths.watchPid, { force: true });
}
