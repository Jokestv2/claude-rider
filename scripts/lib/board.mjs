// scripts/lib/board.mjs — every instance of every rider, needs-you first (§10). Reads only: no lock, no binding.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { currentKey, decideWithLine, targetFlags } from "./keys.mjs";
import { isAlive } from "./proc.mjs";
import { discoverRiders, legalLabels, listInstances, loadRider, RESERVED_IDS, SAFE_ID } from "./rider-md.mjs";
import { currentSession, loadLocal, scopeOf, totalCost } from "./state.mjs";
import { emptyState, instancePaths, readJson, readState, riderPaths, v3Refusal } from "./store.mjs";
import { watcherAlive } from "./watcher-spawn.mjs";

/** The board's groups, in display order: what needs the operator comes first. */
export const CATEGORIES = ["needs you", "orphaned", "needs its judge", "running", "idle"];

/** Whether `id` names a state directory of `rider`. The id becomes a path under `.rider/`, so only a safe token that
 *  no rider-level file uses is ever looked up: `--instance ../x` must not reach another rider's state. */
export function hasState(root, rider, id) {
  return typeof id === "string" && SAFE_ID.test(id) && !RESERVED_IDS.includes(id) && existsSync(instancePaths(root, rider, id).state);
}

const minutes = (ms) => Math.floor(ms / 60_000);
const firstQuestion = (q) => q?.questions?.[0]?.question ?? "asked in prose";

/** Which group an instance's row goes in, what it waits on and since when (§10). Pure: the clock, the stale line and
 *  the watcher's liveness come in, so a test can place a row in every group. Branch drift (§11.1) annotates the row
 *  rather than replacing it: the tree is shared, so one line would otherwise hide every instance's own question or
 *  undecided stretch. It still makes the row the operator's. */
export function categorize(state, rider, opts) {
  const c = ownCategory(state, rider, opts);
  const drift = state?.run?.branchDrift;
  if (!drift) return { ...c, drift: null };
  // `at` is the first sighting: no check rewrites it while the tree stays put, so the board, which never calls git,
  // knows only that the instance's last check still found it there.
  const left = `the shared working tree left ${state.run.baseBranch ?? "?"} for ${drift.branch} (first seen ${drift.at}, as of the instance's last check)`;
  return { ...c, category: "needs you", waitsOn: `${c.waitsOn} · ${left}`, drift: { branch: drift.branch, at: drift.at } };
}

/** The row as if the tree were on its base. The first rule that matches wins. `key` is the active run's latest
 *  stretch; `labels` come only with a stretch that waits on a decision. */
function ownCategory(state, rider, { now, staleMs, watcherAlive: live }) {
  const row = (category, waitsOn, since, key = null, labels = null) => ({ category, waitsOn, since: since ?? null, key, labels });
  const run = state?.run;
  if (!run) {
    const last = state?.lastRun;
    if (last?.endedBy === "operator") return row("needs you", `stopped at operator: ${last.reason ?? "no reason given"}`, last.endedAt);
    return row("idle", last ? `last run ended ${last.endedBy}` : "never run", last?.endedAt);
  }
  const key = currentKey(run);
  const def = rider.phases[run.phase];
  // A run that started at the gate records no handoff (§6.2): it has waited on the operator since it started.
  if (def?.kind === "human") return row("needs you", `human check: ${def.check}`, run.handoff?.at ?? run.startedAt, key);
  const sess = currentSession(run);
  if (!sess) return row("needs you", `no session for phase ${run.phase}`, run.transitions.at(-1)?.at ?? run.startedAt, key);
  // Stopped at: a crash between classification and harvest leaves an outcome with no stop time (Review Focus 4).
  const stopped = sess.stoppedAt ?? sess.at;
  if (sess.outcome === "waiting") return row("needs you", `question: ${firstQuestion(sess.question)}`, sess.at, key);
  // "Running" is what the watcher last recorded, not a fresh poll; with the watcher dead nothing will update it.
  if (sess.outcome === "running") return live ? row("running", `session ${sess.shortId ?? sess.id ?? "?"} running`, sess.at, key) : row("needs you", "watcher not alive", sess.at, key);
  // Before the rate limit: check counts a rate-limited stretch as stopped, so a human turn makes it intervened there and
  // the watcher does not wait on it. The board gives the same reason check does.
  if (sess.intervened) return row("needs you", "intervened: a human turn reached the session", stopped, key);
  if (sess.outcome === "rate-limited") {
    const at = sess.rateLimit?.at ?? stopped;
    return live ? row("running", `rate-limited; resumes after ${sess.rateLimit?.resetAt ?? "?"}`, at, key) : row("needs you", "rate-limited; the watcher gave up or died", at, key);
  }
  if (sess.outcome === "done" || sess.outcome === "gone") {
    const labels = legalLabels(rider, run.phase).map((l) => l.label);
    const age = now.getTime() - new Date(stopped).getTime();
    // A live judge's await wakes within seconds of the stop, so a stretch this old has lost its judge (decision 9).
    if (age > staleMs) return row("needs you", `undecided for ${minutes(age)} min — its judge has most likely died`, stopped, key, labels);
    return row("needs its judge", `its judge's decision on the ${sess.outcome} stretch`, stopped, key, labels);
  }
  return row("needs you", `stretch outcome ${sess.outcome}`, stopped, key);
}

/** The ended runs on file, oldest first. Each file is read on its own: one that does not parse goes to `onError` and
 *  is left out, so the instance's row still stands on the rest. */
function endedRuns(paths, onError) {
  let files = [];
  try { files = readdirSync(paths.runs); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return files.filter((f) => f.endsWith(".json")).sort().flatMap((f) => {
    try { return [readJson(join(paths.runs, f))]; } catch (e) { onError(e); return []; }
  });
}
const sameRun = (a, b) => !!a && !!b && a.runId === b.runId && a.startedAt === b.startedAt;

/** One instance's row. `orphaned` overrides the group and what it waits on, and keeps the run's phase and key. */
function rowOf(root, rider, { id, scope, orphaned, declared, multiRider, now, staleMs, alive, errors }) {
  const paths = instancePaths(root, rider.name, id);
  const state = readState(paths) ?? emptyState({ rider: rider.name, instance: id, scope });
  const { run, lastRun } = state;
  const watcher = watcherAlive(paths, alive);
  const c = categorize(state, rider, { now, staleMs, watcherAlive: !!watcher });
  // A crash inside an end or a revival leaves the active run in runs/ too (§6.3): state.json is the truth.
  const past = endedRuns(paths, (e) => errors.push({ rider: rider.name, instance: id, error: e.message })).filter((r) => !sameRun(r, run));
  // lastRun keeps no transitions: with no active run, the latest decision is in the ended run's record.
  const t = (run ?? past.find((r) => sameRun(r, lastRun)))?.transitions?.at(-1);
  return {
    rider: rider.name, instance: id, scope: orphaned ? scopeOf({ scope: state.scope }) : scope,
    category: orphaned ? "orphaned" : c.category,
    phase: run?.phase ?? lastRun?.phase ?? null, runId: run?.runId ?? lastRun?.runId ?? null,
    since: c.since,
    waitsOn: orphaned ? `no directory matches — rider status/reset ${targetFlags({ rider: rider.name, multiRider, instance: id, declared: true })}` : c.waitsOn,
    decision: t ? { label: t.label, because: t.because ?? null, by: t.by ?? null } : null,
    runCost: run ? totalCost(run) : lastRun?.totalCost ?? null,
    instanceCost: past.reduce((a, r) => a + totalCost(r), 0) + totalCost(run),
    key: c.key,
    // Not for an orphan: `next` refuses its id, so the line would not run as printed.
    decideWith: c.labels && !orphaned ? decideWithLine({ rider: rider.name, multiRider, instance: id, declared, key: c.key, labels: c.labels }) : null,
    drift: c.drift,
    watcher, updatedAt: state.updatedAt ?? null, statePath: paths.state,
  };
}

/** The state directories no current instance claims: renamed or deleted (§10). */
function orphanIds(root, rider, current) {
  let names = [];
  try { names = readdirSync(riderPaths(root, rider).dir); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return names.filter((n) => !current.has(n) && hasState(root, rider, n)).sort();
}

const order = (a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || (a.rider < b.rider ? -1 : a.rider > b.rider ? 1 : 0) || (a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0);

/** `rider board` (§10): derived from each rider's RIDER.md and its instances, not from `.rider/`, so an instance that
 *  never ran is listed too. It reads whole files and nothing else: no lock, no binding, no v3 guard written. A file
 *  it cannot read is an error entry, and every other rider and instance is still listed. */
export function collectBoard(root, { now = new Date(), alive = isAlive } = {}) {
  const riders = discoverRiders(root);
  // As the CLI counts them: an invalid rider still makes `--rider` necessary.
  const multiRider = riders.length > 1;
  const rows = [], skipped = [], errors = [];
  for (const found of riders) {
    let rider, listed, staleMs;
    try {
      rider = loadRider(found.file);
      const rp = riderPaths(root, rider.name);
      const v3 = v3Refusal(rp);
      if (v3) { errors.push({ rider: rider.name, error: v3 }); continue; }
      staleMs = loadLocal(rp).staleDecisionMinutes * 60_000;
      listed = listInstances(root, rider);
    } catch (e) { errors.push({ rider: found.name, error: e.message }); continue; }
    skipped.push(...listed.skipped.map((s) => ({ rider: rider.name, ...s })));
    const one = (id, scope, orphaned) => {
      try { rows.push(rowOf(root, rider, { id, scope, orphaned, declared: listed.declared, multiRider, now, staleMs, alive, errors })); } catch (e) { errors.push({ rider: rider.name, instance: id, error: e.message }); }
    };
    for (const i of listed.instances) one(i.id, i.scope, false);
    // Listing .rider/<rider>/ is the one read only the orphans need: when it fails, the instances above still stand.
    let orphans = [];
    try { orphans = orphanIds(root, rider.name, new Set(listed.instances.map((i) => i.id))); } catch (e) { errors.push({ rider: rider.name, error: e.message }); }
    for (const id of orphans) one(id, null, true);
  }
  // `riders` tells a project with no riders from one whose riders have no instances yet.
  return { board: 1, generatedAt: now.toISOString(), riders: riders.map((r) => r.name), rows: rows.sort(order), skipped, errors };
}
