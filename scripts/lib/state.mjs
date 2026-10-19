// scripts/lib/state.mjs
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./store.mjs";

/** Machine facts and overrides (§4.2), one file per rider (`riderPaths(...).local`). Keys not listed here are kept but unused. */
export function loadLocal(rp) {
  return { maxWaitHours: 6, pollSeconds: 30, models: {}, advisor: null, launchArgs: [], claudePath: null, shell: null, permissionMode: "auto", ...readJson(rp.local, {}) };
}
export function newRun({ rider, phase, baseBranch, now }) {
  return { rider, runId: randomBytes(2).toString("hex"), startedAt: now.toISOString(), baseBranch: baseBranch ?? null, phase, visits: {}, transitions: [], sessions: [], notes: [] };
}
/** What a RIDER.md-declared command (intake, check, show, evidence) is told about the run. */
export function riderEnv(rider, run) {
  return {
    RIDER_NAME: rider?.name ?? "",
    RIDER_RUN_ID: run?.runId ?? "",
    RIDER_PHASE: run?.phase ?? "",
    RIDER_BASE_BRANCH: run?.baseBranch ?? "",
    RIDER_WORK_BRANCH: run?.workBranch ?? "",
    RIDER_WORK_TIP: run?.workTip ?? "",
  };
}
export function writeLog(paths, name, data) { const p = join(paths.logs, name); writeJsonAtomic(p, data); return p; }
/** The decision key of a stretch (§8): the run, then the stretch's 1-based place in `sessions`. */
export const keyOf = (run, sess) => `${run.runId}.${run.sessions.indexOf(sess) + 1}`;
/** Whether something is running that a watcher must observe. Asked of the phase kind, not of "has a session": rider
 *  0.2's await phase is live with no session at all, and adds its case here (§13). */
export function isLive(run, rider) {
  if (!run || rider.phases[run.phase]?.kind !== "session") return false;
  const sess = currentSession(run);
  return sess?.outcome === "running" || sess?.outcome === "waiting";
}
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
