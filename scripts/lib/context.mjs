// scripts/lib/context.mjs
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { overrulable } from "./rider-md.mjs";
import { resolveShell, sh } from "./shell.mjs";
import { riderEnv, scopeOf, totalCost, writeLog } from "./state.mjs";
import { acquireLock, appendEvent, emptyState, endedRunPath, instancePaths, readEvents, readJson, readState, writeJsonAtomic, writeState } from "./store.mjs";
import { ensureWatcher, killWatcher, watcherAlive } from "./watcher-spawn.mjs";
import { runCheckProcess } from "./check-run.mjs";
import { sleepSync } from "./proc.mjs";

/** Everything a verb needs for one instance, behind one object so tests can inject a clock, a sleep and a binding.
 *  It is also the instance's only writer (§7.1): every write asserts that `update` holds the instance's lock. */
export function createContext({ rider, instance, root, local, binding, now = () => new Date(), sleep = sleepSync, spawnWatcher = null, watcherAlive: aliveFn = null, killWatcher: killFn = null, runCheck: runCheckFn = null, lock = {}, riderCount = 1, rollRunId = undefined }) {
  const paths = instancePaths(root, rider.name, instance.id);
  const shell = resolveShell(local);
  let depth = 0;
  let release = null;
  let queue = [];
  /** A write outside `update` is an executor bug no user can reach by any verb, so it fails loudly instead of racing. */
  const locked = (what) => { if (depth === 0) throw new Error(`internal: ${what} outside the instance lock`); };
  const read = () => readState(paths) ?? emptyState({ rider: rider.name, instance: instance.id, scope: instance.scope });
  const write = (state) => writeState(paths, state, now());
  /** What state.json keeps of an ended run: enough to list it, and its start time and id, which name its record in runs/. */
  const summary = (run) => ({ runId: run.runId, phase: run.phase, startedAt: run.startedAt, endedAt: run.endedAt, endedBy: run.endedBy, reason: run.reason, totalCost: totalCost(run), overrulable: overrulable(rider, run) });
  /** The newest record in runs/ other than `except`: what `lastRun` falls back to when its run is revived. */
  const newestEnded = (except) => {
    let files = [];
    try { files = readdirSync(paths.runs); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const rest = files.filter((f) => f.endsWith(".json") && join(paths.runs, f) !== except).sort();
    return rest.length ? summary(readJson(join(paths.runs, rest.at(-1)))) : null;
  };
  const ctx = {
    rider, instance, root, paths, local, binding, now, sleep, riderCount, rollRunId,
    /** One hold per verb. Reentrant through the depth count: a verb that calls another (next → resume, start →
     *  enterPhase → ensureWatcher) must not wait on the lock it already holds. The hold's events are appended after
     *  `fn` returns and before the lock is let go, so they follow every write they record (§7.1); a throw drops them. */
    update(fn) {
      if (depth === 0) release = acquireLock(paths, { ...lock, now, sleep });
      depth++;
      let committed = false;
      try {
        const r = fn();
        committed = true;
        return r;
      } finally {
        if (--depth === 0) {
          const events = queue;
          const unlock = release;
          queue = [];
          release = null;
          // seq is assigned as each lands, into the object `event` returned, so its caller sees it once this returns.
          try { if (committed) for (const e of events) Object.assign(e, appendEvent(paths, e, new Date(e.at))); } finally { unlock(); }
        }
      }
    },
    holding: () => depth > 0,
    /** Readers take no lock: state.json only ever changes by rename (§7.2). */
    readState: read,
    loadRun: () => read().run,
    saveRun(run) { locked("saveRun"); const state = read(); state.run = run; write(state); },
    /** A run ends by a passing human check (`done`), at `operator`, or by `reset`. Its record goes to runs/ first and
     *  state.json lets go of it second (§6.3): a crash between the two leaves a duplicate that the next end overwrites. */
    endRun(run, { endedBy, reason = null }) {
      locked("endRun");
      run.endedAt = now().toISOString();
      run.endedBy = endedBy;
      run.reason = reason;
      writeJsonAtomic(endedRunPath(paths, run), run);
      const state = read();
      state.run = null;
      state.lastRun = summary(run);
      write(state);
      ctx.event("run-ended", { runId: run.runId, phase: run.phase, text: reason ? `${endedBy}: ${reason}` : endedBy });
      return run;
    },
    lastEndedRun() { const last = read().lastRun; return last ? readJson(endedRunPath(paths, last), null) : null; },
    /** Every run id the instance has used: the active run's, the last run's, and each record's in runs/, read from its
     *  file name (`endedRunPath`) so no record is parsed. */
    runIdsInUse() {
      const { run, lastRun } = read();
      let files = [];
      try { files = readdirSync(paths.runs); } catch (e) { if (e.code !== "ENOENT") throw e; }
      const named = files.map((f) => /-([0-9a-f]{4})\.json$/.exec(f)?.[1]);
      return new Set([run?.runId, lastRun?.runId, ...named].filter(Boolean));
    },
    /** Rewrite an ended run's record in place: a note that arrives after the run ended still belongs to it. */
    saveEndedRun(run) {
      locked("saveEndedRun");
      writeJsonAtomic(endedRunPath(paths, run), run);
      const state = read();
      if (state.lastRun?.runId === run.runId) { state.lastRun = summary(run); write(state); }
    },
    /** The inverse of `endRun`, for `overrule`: the record moves back into state.json and is a live run again.
     *  The ending it undoes is not erased — the transition that caused it stays in `transitions`. State is written
     *  before the record is removed, so a crash between the two leaves the same harmless duplicate as `endRun`. */
    reviveRun(run) {
      locked("reviveRun");
      delete run.endedAt;
      delete run.endedBy;
      delete run.reason;
      const own = endedRunPath(paths, run);
      const state = read();
      state.run = run;
      state.lastRun = newestEnded(own);
      write(state);
      rmSync(own, { force: true });
      return run;
    },
    /** Queued, in hold order, and written when the hold commits: a record event says a write happened (§6.2), so a
     *  hold that throws leaves none. Returns the event, whose `seq` is filled in when it lands. `by` and `cause` are
     *  carried only by the events that pass them (`refused`). */
    event(kind, { runId = null, phase = null, key = null, text = "", by = null, cause = null } = {}) {
      locked(`event ${kind}`);
      const e = { seq: null, at: now().toISOString(), rider: paths.rider, instance: paths.instance, runId, kind, phase, key, text, ...(by ? { by } : {}), ...(cause ? { cause } : {}) };
      queue.push(e);
      return e;
    },
    readEvents: () => readEvents(paths),
    writeLog: (name, data) => writeLog(paths, name, data),
    /** `entry` is what an entry command is told beyond the run (`riderEnv`): the phase about to be entered, and for `requires` the phase left and the label. */
    shellOpts: (run = null, entry = {}) => ({ cwd: root, shell, env: { ...process.env, ...riderEnv(rider, run, instance, entry) } }),
    branch: () => { const r = sh("git branch --show-current", { cwd: root, shell }); return r.status === 0 && r.output ? r.output.split("\n")[0].trim() : null; },
    // The ref travels in the environment, never in the command text: a branch name is not shell-safe.
    tip: (ref) => { const r = sh('git rev-parse --verify --quiet "$RIDER_REF^{commit}"', { cwd: root, shell, env: { ...process.env, RIDER_REF: ref } }); return r.status === 0 && /^[0-9a-f]{40,64}$/.test(r.output) ? r.output : null; },
    /** `git log --oneline from..to -- <scope>`, as lines; null when git cannot answer (no repository, an unknown ref).
     *  Path-limited to the instance's directory (§11), so instances sharing a branch do not count each other's work. */
    commitsBetween: (from, to) => { const r = sh('git log --oneline "$RIDER_FROM..$RIDER_TO" -- "$RIDER_SCOPE_PATH"', { cwd: root, shell, capBytes: 8192, env: { ...process.env, RIDER_FROM: from, RIDER_TO: to, RIDER_SCOPE_PATH: scopeOf(instance) } }); return r.status === 0 ? r.output.split("\n").filter(Boolean) : null; },
    /** Under the lock, so two writers cannot both find no watcher and both spawn one, nor race on watch.pid. */
    ensureWatcher() { locked("ensureWatcher"); return spawnWatcher ? spawnWatcher() : ensureWatcher(paths, { riderName: rider.name, instance: instance.id, root }); },
    watcherAlive: () => (aliveFn ? aliveFn() : watcherAlive(paths)),
    killWatcher() { locked("killWatcher"); return killFn ? killFn() : killWatcher(paths); },
    /** An await check runs in its own process group, through the runner, so a timeout or a reset kills all of it (§7.3.1). */
    runCheck: (cmd, { timeoutMs, env, key }) => (runCheckFn ? runCheckFn(cmd, { timeoutMs, env, key }) : runCheckProcess(paths, { cmd, cwd: root, shell, env, timeoutMs, key })),
  };
  return ctx;
}
