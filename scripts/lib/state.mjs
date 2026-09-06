// scripts/lib/state.mjs
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function statePaths(root, name) {
  const dir = join(root, ".rider", name);
  return { dir, run: join(dir, "run.json"), runs: join(dir, "runs"), logs: join(dir, "logs"), events: join(dir, "events.log"), watchPid: join(dir, "watch.pid"), watchLog: join(dir, "logs", "watch.log"), local: join(dir, "local.json") };
}
export function ensureDirs(paths) { for (const d of [paths.dir, paths.runs, paths.logs]) mkdirSync(d, { recursive: true }); }
/** A corrupt run.json or local.json is undiagnosable from the judge's side unless the throw names it. */
export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, "utf8");
  try { return JSON.parse(text); } catch (e) { throw new Error(`${path}: ${e.message}`); }
}
export function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
export function loadRun(paths) { return readJson(paths.run, null); }
export function saveRun(paths, run) { writeJson(paths.run, run); }
/** Machine facts and overrides (§4.2). Keys not listed here are kept but unused. */
export function loadLocal(paths) {
  return { maxWaitHours: 6, pollSeconds: 30, models: {}, advisor: null, claudePath: null, shell: null, permissionMode: "auto", ...readJson(paths.local, {}) };
}
export function newRun({ rider, phase, branch, now }) {
  // `branch` is a legacy mirror of `baseBranch`: the npm-installed CLI and the plugin copy read the
  // same run.json and may differ in version, so a run written by the newer one must still render in
  // the older. Read the pair everywhere as `run.baseBranch ?? run.branch`.
  return { rider, runId: randomBytes(2).toString("hex"), startedAt: now.toISOString(), baseBranch: branch ?? null, branch: branch ?? null, phase, visits: {}, transitions: [], sessions: [], notes: [] };
}
/** What a RIDER.md-declared command (intake, check, show, evidence) is told about the run. */
export function riderEnv(rider, run) {
  return {
    RIDER_NAME: rider?.name ?? "",
    RIDER_RUN_ID: run?.runId ?? "",
    RIDER_PHASE: run?.phase ?? "",
    RIDER_BASE_BRANCH: run?.baseBranch ?? run?.branch ?? "",
    RIDER_WORK_BRANCH: run?.workBranch ?? "",
  };
}
/** A run ends by a passing human check (`done`), at `operator`, or by `reset`; its record moves to runs/. */
export function endRun(paths, run, { endedBy, reason = null, now }) {
  run.endedAt = now.toISOString();
  run.endedBy = endedBy;
  run.reason = reason;
  ensureDirs(paths);
  writeJson(join(paths.runs, `${run.startedAt.replace(/[:.]/g, "-")}-${run.runId}.json`), run);
  rmSync(paths.run, { force: true });
  return run;
}
export function lastEndedRun(paths) {
  if (!existsSync(paths.runs)) return null;
  const files = readdirSync(paths.runs).filter((f) => f.endsWith(".json")).sort();
  return files.length ? readJson(join(paths.runs, files[files.length - 1])) : null;
}
export function appendEvent(paths, fields, now = new Date()) {
  const line = [now.toISOString(), ...fields.filter((f) => f !== null && f !== undefined && f !== "")].join(" ").replace(/\r?\n/g, " ");
  ensureDirs(paths);
  appendFileSync(paths.events, `${line}\n`);
  return line;
}
export function readEvents(paths) { return existsSync(paths.events) ? readFileSync(paths.events, "utf8").split(/\r?\n/).filter(Boolean) : []; }
export function writeLog(paths, name, data) { ensureDirs(paths); const p = join(paths.logs, name); writeJson(p, data); return p; }
export function currentSession(run) {
  for (let i = run.sessions.length - 1; i >= 0; i--) if (run.sessions[i].phase === run.phase) return run.sessions[i];
  return null;
}
/** The records that share one transcript with `rec`: the earlier stretches it resumed, then rec itself (or its stored
 *  twin, matched by id and start time when the caller holds a copy) — rec is always the LAST element. Throws when the
 *  record is not in `sessions` at all: a silent empty chain would charge a resumed stretch the whole transcript's cost. */
export function chainRecords(sessions, rec) {
  let idx = sessions.indexOf(rec);
  if (idx < 0) idx = sessions.findIndex((x) => x.id === rec.id && x.at === rec.at);
  if (idx < 0) throw new Error("chainRecords: the record is not in run.sessions");
  const ids = new Set([rec.id, rec.resumedFrom].filter(Boolean));
  const out = [];
  for (let i = idx; i >= 0; i--) {
    const x = sessions[i];
    if (i === idx || (x.id && ids.has(x.id))) {
      out.unshift(x);
      if (x.id) ids.add(x.id);
      if (x.resumedFrom) ids.add(x.resumedFrom);
    }
  }
  return out;
}
/** Claude Code's cost line is cumulative per session: a record is charged only its own stretch. */
export function chainCost(sessions, rec) { return chainRecords(sessions, rec).slice(0, -1).reduce((a, x) => a + (x.cost ?? 0), 0); }
/** Nudges the rider itself typed into this transcript — subtracted from human-origin user turns. */
export function chainResumes(sessions, rec) { return chainRecords(sessions, rec).filter((x) => x.resumedFrom).length; }
export function consecutiveRateLimitResumes(sessions, phase) {
  let n = 0;
  for (let i = sessions.length - 1; i >= 0; i--) {
    const x = sessions[i];
    if (x.phase !== phase) break;
    if (x.resumeReason === "rate-limit") n++;
    else break;
  }
  return n;
}
export function totalCost(run) { return (run?.sessions ?? []).reduce((a, s) => a + (s.cost ?? 0), 0); }
