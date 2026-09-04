// scripts/lib/state.mjs
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function statePaths(root, name) {
  const dir = join(root, ".rider", name);
  return { dir, run: join(dir, "run.json"), runs: join(dir, "runs"), logs: join(dir, "logs"), events: join(dir, "events.log"), watchPid: join(dir, "watch.pid"), watchLog: join(dir, "logs", "watch.log"), local: join(dir, "local.json") };
}
export function ensureDirs(paths) { for (const d of [paths.dir, paths.runs, paths.logs]) mkdirSync(d, { recursive: true }); }
export function readJson(path, fallback = null) { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback; }
export function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
export function loadRun(paths) { return readJson(paths.run, null); }
export function saveRun(paths, run) { writeJson(paths.run, run); }
/** Machine facts and overrides (§4.2). Keys not listed here are kept but unused. */
export function loadLocal(paths) {
  return { maxWaitHours: 6, pollSeconds: 30, models: {}, advisor: null, claudePath: null, shell: null, permissionMode: "auto", ...readJson(paths.local, {}) };
}
export function newRun({ rider, phase, branch, now }) {
  return { rider, runId: randomBytes(2).toString("hex"), startedAt: now.toISOString(), branch: branch ?? null, phase, visits: {}, transitions: [], sessions: [], notes: [] };
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
/** The records that share one transcript with `rec`: rec and the earlier stretches it resumed, in order. */
export function chainRecords(sessions, rec) {
  const idx = sessions.indexOf(rec);
  const ids = new Set([rec.id, rec.resumedFrom].filter(Boolean));
  const out = [];
  for (let i = idx; i >= 0; i--) {
    const x = sessions[i];
    if (x === rec || (x.id && ids.has(x.id))) {
      out.unshift(x);
      if (x.id) ids.add(x.id);
      if (x.resumedFrom) ids.add(x.resumedFrom);
    }
  }
  return out;
}
/** Claude Code's cost line is cumulative per session: a record is charged only its own stretch. */
export function chainCost(sessions, rec) { return chainRecords(sessions, rec).filter((x) => x !== rec).reduce((a, x) => a + (x.cost ?? 0), 0); }
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
