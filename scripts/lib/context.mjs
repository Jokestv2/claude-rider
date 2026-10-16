// scripts/lib/context.mjs
import { appendEvent, endRun, lastEndedRun, loadRun, readEvents, reviveRun, riderEnv, saveEndedRun, saveRun, writeLog } from "./state.mjs";
import { resolveShell, sh } from "./shell.mjs";
import { ensureWatcher, killWatcher, watcherAlive } from "./watcher-spawn.mjs";
import { sleepSync } from "./proc.mjs";

/** Everything a verb needs, behind one object so tests can inject a clock, a sleep and a binding. */
export function createContext({ rider, root, paths, local, binding, now = () => new Date(), sleep = sleepSync, spawnWatcher = null, watcherAlive: aliveFn = null, killWatcher: killFn = null }) {
  const shell = resolveShell(local);
  return {
    rider, root, paths, local, binding, now, sleep,
    loadRun: () => loadRun(paths),
    saveRun: (run) => saveRun(paths, run),
    endRun: (run, o) => endRun(paths, run, { ...o, now: now() }),
    lastEndedRun: () => lastEndedRun(paths),
    saveEndedRun: (run) => saveEndedRun(paths, run),
    reviveRun: (run) => reviveRun(paths, run),
    writeLog: (name, data) => writeLog(paths, name, data),
    appendEvent: (fields) => appendEvent(paths, fields, now()),
    readEvents: () => readEvents(paths),
    shellOpts: (run = null) => ({ cwd: root, shell, env: { ...process.env, ...riderEnv(rider, run) } }),
    branch: () => { const r = sh("git branch --show-current", { cwd: root, shell }); return r.status === 0 && r.output ? r.output.split("\n")[0].trim() : null; },
    // The ref travels in the environment, never in the command text: a branch name is not shell-safe.
    tip: (ref) => { const r = sh('git rev-parse --verify --quiet "$RIDER_REF^{commit}"', { cwd: root, shell, env: { ...process.env, RIDER_REF: ref } }); return r.status === 0 && /^[0-9a-f]{40,64}$/.test(r.output) ? r.output : null; },
    /** `git log --oneline from..to`, as lines; null when git cannot answer (no repository, an unknown ref). */
    commitsBetween: (from, to) => { const r = sh('git log --oneline "$RIDER_FROM..$RIDER_TO"', { cwd: root, shell, capBytes: 8192, env: { ...process.env, RIDER_FROM: from, RIDER_TO: to } }); return r.status === 0 ? r.output.split("\n").filter(Boolean) : null; },
    ensureWatcher: () => (spawnWatcher ? spawnWatcher() : ensureWatcher(paths, { riderName: rider.name, root })),
    watcherAlive: () => (aliveFn ? aliveFn() : watcherAlive(paths)),
    killWatcher: () => (killFn ? killFn() : killWatcher(paths)),
  };
}
