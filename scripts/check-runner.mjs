// scripts/check-runner.mjs
// One run of an await check, for `runCheckProcess` (§7.3.1): node check-runner.mjs '{ cmd, cwd, shell, timeoutMs, graceMs,
// outFile, pidFile, key }'. It prints one JSON line, { status, timedOut, output, error }, and exits 0.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { capText } from "./lib/shell.mjs";
import { writeJsonAtomic } from "./lib/store.mjs";

const { cmd, cwd, shell, timeoutMs, graceMs, outFile, pidFile, key } = JSON.parse(process.argv[2]);

const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const signalGroup = (pgid, signal) => { try { process.kill(-pgid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; } };
/** Only the head is read: 2 KB of it are kept, and a chatty tick may have written far more than fits in memory. */
const HEAD_BYTES = 64 * 1024;
function readOutput() {
  let head;
  try { head = openSync(outFile, "r"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; }
  try { const buf = Buffer.alloc(HEAD_BYTES); return buf.subarray(0, readSync(head, buf, 0, HEAD_BYTES, 0)).toString("utf8").trim(); } finally { closeSync(head); }
}
const ownsPidFile = (pgid) => { try { return JSON.parse(readFileSync(pidFile, "utf8")).pgid === pgid; } catch { return false; } };

let finished = false;
/** Once, whichever of exit, error and the timeout's kill gets here first. The output file goes before the pid file: a
 *  runner waiting on this check starts once the pid file is gone, and must not lose its own output file to this one.
 *  Both go before the answer is printed, which a killed watcher can no longer read. */
function finish({ status, timedOut = false, error = null }, pgid = null) {
  if (finished) return;
  finished = true;
  const output = capText(readOutput(), 2048);
  rmSync(outFile, { force: true });
  if (pgid && ownsPidFile(pgid)) rmSync(pidFile, { force: true });
  process.stdout.on("error", () => process.exit(0));
  process.stdout.write(`${JSON.stringify({ status, timedOut, output, error })}\n`, () => process.exit(0));
}

mkdirSync(dirname(outFile), { recursive: true });
// A file, not a pipe: a child the check leaves running would hold a pipe open, and the poll with it.
const fd = openSync(outFile, "w");
let child;
try {
  child = spawn(shell, ["-c", cmd], { cwd, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
} catch (e) {
  finish({ status: -1, error: e.message });
}
closeSync(fd);
if (child) {
  const pgid = child.pid ?? null;
  // A spawn that fails (no such shell or cwd) has no pid and reports by its error event alone.
  child.on("error", (e) => { if (!pgid) finish({ status: -1, error: e.message }); });
  if (pgid) {
    writeJsonAtomic(pidFile, { pgid, key, at: new Date().toISOString(), runner: process.pid });
    let timingOut = false;
    let exited = false;
    let killed = false;
    // A timeout is reported once the whole group is gone, or once SIGKILL has gone to what outlived SIGTERM's grace.
    const timer = setTimeout(() => {
      timingOut = true;
      signalGroup(pgid, "SIGTERM");
      const deadline = Date.now() + graceMs;
      const poll = setInterval(() => {
        if (groupAlive(pgid) && Date.now() < deadline) return;
        if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
        clearInterval(poll);
        killed = true;
        if (exited) finish({ status: -1, timedOut: true }, pgid);
      }, 100);
    }, timeoutMs);
    // The shell's exit, not its output's close: a child it left running keeps the output open, and is not killed.
    child.on("exit", (code, signal) => {
      exited = true;
      if (timingOut) { if (killed) finish({ status: -1, timedOut: true }, pgid); return; }
      clearTimeout(timer);
      finish(code === null ? { status: -1, error: `the check was killed by ${signal}` } : { status: code }, pgid);
    });
  }
}
