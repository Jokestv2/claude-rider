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

/** How far either boot rule leans to "written since the boot": uptime and the clock are read at different moments, and are coarse. */
export const BOOT_SLACK_MS = 2000;
/** When the machine booted, on the real clock: a file's mtime is real time, so it is compared with this (§7.10). */
export function bootTime(nowMs = Date.now(), uptimeS = osUptime()) { return nowMs - uptimeS * 1000; }
/** A pid file written before the boot names no live process, whatever its pid now is; one written in the first seconds after it is not misread. */
export function writtenBeforeBoot(writtenAtMs, bootMs) { return writtenAtMs < bootMs - BOOT_SLACK_MS; }
/** The machine's uptime is smaller now than when `upS` was recorded, so it rebooted in between. Needs no clock, so an injected one cannot trip it. */
export function rebootedSince(upS, uptimeS = osUptime()) { return upS != null && uptimeS < upS - BOOT_SLACK_MS / 1000; }
