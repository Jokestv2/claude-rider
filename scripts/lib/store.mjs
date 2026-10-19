// scripts/lib/store.mjs
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isAlive, sleepSync } from "./proc.mjs";

/** The events the watcher appends and `await` wakes on; every other kind is a record of a committed write (§6.2). */
export const WAKE_KINDS = ["done", "gone", "waiting", "intervened", "rate-limited", "watcher-stopped"];

/** Rider-level files: what all of a rider's instances share, and where v3 kept its one run. */
export function riderPaths(root, rider) {
  const dir = join(root, ".rider", rider);
  return { dir, local: join(dir, "local.json"), v3Run: join(dir, "run.json") };
}
/** One directory per instance (§6); `rider` and `instance` ride along so an event can name its source. */
export function instancePaths(root, rider, instance) {
  const dir = join(root, ".rider", rider, instance);
  const logs = join(dir, "logs");
  return { rider, instance, dir, state: join(dir, "state.json"), events: join(dir, "events.jsonl"), runs: join(dir, "runs"), logs, watchPid: join(dir, "watch.pid"), watchLog: join(logs, "watch.log"), lock: join(dir, "lock") };
}

/** A corrupt state or local file is undiagnosable from the judge's side unless the throw names it. */
export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, "utf8");
  try { return JSON.parse(text); } catch (e) { throw new Error(`${path}: ${e.message}`); }
}
const RETRYABLE = new Set(["EPERM", "EBUSY"]);
/** Readers take no lock, so a file must change by rename or not at all. EPERM/EBUSY on rename is Windows' known
 *  transient (a scanner or indexer holding the target); retry it as graceful-fs does. */
export function writeJsonAtomic(path, value, { rename = renameSync, sleep = sleepSync } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  for (let i = 0; ; i++) {
    try { rename(tmp, path); return; } catch (e) {
      if (RETRYABLE.has(e.code) && i < 5) { sleep(50 * 2 ** i); continue; }
      rmSync(tmp, { force: true });
      throw e;
    }
  }
}

export function emptyState({ rider, instance, scope }) {
  return { schema: 4, rider, instance, scope, version: 0, updatedAt: null, run: null, lastRun: null };
}
/** There is no migration (§16): a file of any other schema is refused rather than half-read. */
export function readState(paths) {
  const state = readJson(paths.state, null);
  if (state === null) return null;
  if (state?.schema !== 4) throw new Error(`${paths.state}: schema ${JSON.stringify(state?.schema) ?? "missing"}, but this executor reads schema 4`);
  return state;
}
/** `version` lets a polling reader tell that the file changed; it is not a decision key (§8). */
export function writeState(paths, state, now) {
  state.version = (state.version ?? 0) + 1;
  state.updatedAt = now.toISOString();
  writeJsonAtomic(paths.state, state);
  return state;
}

/** A crash mid-append leaves a torn last line; skipping what does not parse keeps every reader going. */
export function readEvents(paths) { return parseEvents(existsSync(paths.events) ? readFileSync(paths.events, "utf8") : ""); }
function parseEvents(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === "object") out.push(e); } catch { /* torn or foreign line */ }
  }
  return out;
}
/** Called under the lock, so the highest seq on file is the last one assigned. One appendFileSync of one whole
 *  line keeps a concurrent lock-free reader from seeing half an event; a torn line before it is closed off first. */
export function appendEvent(paths, { runId = null, kind, phase = null, key = null, text = "" }, now) {
  mkdirSync(paths.dir, { recursive: true });
  const prior = existsSync(paths.events) ? readFileSync(paths.events, "utf8") : "";
  const seq = parseEvents(prior).reduce((max, e) => (Number.isInteger(e.seq) && e.seq > max ? e.seq : max), 0) + 1;
  const event = { seq, at: now.toISOString(), rider: paths.rider, instance: paths.instance, runId, kind, phase, key, text };
  appendFileSync(paths.events, `${prior && !prior.endsWith("\n") ? "\n" : ""}${JSON.stringify(event)}\n`);
  return event;
}
export const endedRunPath = (paths, run) => join(paths.runs, `${run.startedAt.replace(/[:.]/g, "-")}-${run.runId}.json`);

const readOrNull = (path) => { try { return readFileSync(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const parseOrNull = (text) => { try { return JSON.parse(text); } catch { return null; } };
/** One writer per instance (§7.1). Exclusive create is the lock; its content says who holds it, so a holder that
 *  died on this host can be told from a live one. A holder elsewhere cannot be checked, so it is never broken. */
export function acquireLock(paths, { timeoutMs = 60_000, retryMs = 200, now = () => new Date(), sleep = sleepSync, alive = isAlive, host = hostname() } = {}) {
  mkdirSync(paths.dir, { recursive: true });
  const nonce = randomBytes(8).toString("hex");
  const deadline = now().getTime() + timeoutMs;
  for (;;) {
    let fd = null;
    try { fd = openSync(paths.lock, "wx"); } catch (e) { if (e.code !== "EEXIST") throw e; }
    if (fd !== null) {
      // An empty lock is never broken, so a failed write must not leave one behind.
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host, at: now().toISOString(), nonce })); } catch (e) { closeSync(fd); rmSync(paths.lock, { force: true }); throw e; }
      closeSync(fd);
      return () => { const text = readOrNull(paths.lock); if (text !== null && parseOrNull(text)?.nonce === nonce) rmSync(paths.lock, { force: true }); };
    }
    const text = readOrNull(paths.lock);
    if (text === null) continue; // released since our create failed: try again at once
    // Empty or unparsable: a holder between its create and its write. Wait for it.
    const holder = parseOrNull(text);
    if (holder?.host === host && !alive(holder.pid) && breakStale(paths.lock, text)) continue;
    if (now().getTime() >= deadline) {
      if (!holder) throw new Error(`instance ${paths.instance} is locked by pid ? on ? since ? (${paths.lock} names no holder; remove it if no rider verb is running)`);
      throw new Error(`instance ${paths.instance} is locked by pid ${holder.pid} on ${holder.host} since ${holder.at ?? "?"}`);
    }
    sleep(retryMs);
  }
}
/** Two breakers can judge the same lock stale; the rename lets only one of them take it. The loser may have moved
 *  the winner's fresh lock aside instead, so it puts that back. True when the create should be retried at once. */
function breakStale(lock, judged) {
  const aside = `${lock}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  try { renameSync(lock, aside); } catch (e) { if (e.code === "ENOENT") return true; throw e; }
  if (readFileSync(aside, "utf8") === judged) { rmSync(aside, { force: true }); return true; }
  try { linkSync(aside, lock); } catch (e) { if (e.code !== "EEXIST") throw e; }
  rmSync(aside, { force: true });
  return false;
}

const GUARD_README = `This directory stands where an older claude-rider kept its state file, run.json.
Its presence makes that older executor fail on every verb instead of reporting no active run and launching a new session.
The current layout keeps each instance's state in <instance>/state.json next to this directory.
Do not remove it while an older executor might still be run against this project.
`;
/** v4 refuses v3 state (§16), and the directory it leaves at run.json makes a stale v3 executor fail on every verb
 *  with EISDIR instead of seeing no run and launching a paid session (§6.4). A directory there is that guard. */
export function guardV3(rp) {
  let st = null;
  try { st = statSync(rp.v3Run); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (st?.isDirectory()) return;
  if (st) throw new Error(`${rp.v3Run} is state from an older claude-rider, which this version does not read. Finish or reset that run with the old version first, then remove ${rp.dir}/ (move its runs/ aside first to keep the history).`);
  mkdirSync(rp.v3Run, { recursive: true });
  writeFileSync(join(rp.v3Run, "README"), GUARD_README);
}
