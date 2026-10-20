// scripts/lib/proc.mjs
import { uptime as osUptime } from "node:os";

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
/** Block the process: everything in this runtime is spawnSync-shaped, so the wait is too. */
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How far the boot rule leans to "written since the boot": the clock and the uptime are read at different moments, and are coarse. */
export const BOOT_SLACK_MS = 2000;
/** When the machine booted, on the real clock: a file's mtime and a lock's `wallAt` are real time, so they are compared with this (§7.10). */
export function bootTime(nowMs = Date.now(), uptimeS = osUptime()) { return nowMs - uptimeS * 1000; }
/** A pid file or lock written before the boot names no live process, whatever its pid now is; one written in the first seconds after it is not misread. */
export function writtenBeforeBoot(writtenAtMs, bootMs) { return writtenAtMs < bootMs - BOOT_SLACK_MS; }
