// scripts/lib/await.mjs — an await phase's wait: the watcher's poll of its check (§7.2, §7.3)
import { noteBranchDrift } from "./check.mjs";
import { currentKey } from "./keys.mjs";
import { firstLine } from "./preflight.mjs";
import { currentSession, keyOf } from "./state.mjs";

/** A poll's output on one line, as the requires readout shows a refusal: the await block and the board read a poll by it too. */
export { firstLine };

/** An await check's answers (§7.2). `EX_TEMPFAIL`, not 1: a traceback or a `set -e` script exits 1, and a broken check
 *  read as "not yet" would wait out its deadline with no signal. */
const READY = 0;
const NOT_YET = 75;

/** One poll of the current wait (§7.3): the check runs with nothing held, since it may act and may take minutes, and its
 *  answer is committed in one short locked write, only while the wait it ran for is still current and still awaits. A
 *  run that moved on meanwhile gets nothing: the tick was left to finish, and the caller watches whatever runs now. A poll
 *  appends no event (§7.6) unless it settles the wait or a failing streak reaches `threshold`. `failing` is an awaiting
 *  wait at the threshold, as status and the board read it (§7.5). */
export function pollAwait(ctx, { threshold }) {
  const seen = ctx.loadRun();
  const def = seen && ctx.rider.phases[seen.phase];
  if (def?.kind !== "await") return { moved: true };
  const wait = currentSession(seen);
  // Every entry to an await phase records its wait (`enterWait`): a missing one is a corrupt record, never a moved run.
  if (wait?.kind !== "await") throw new Error(`run ${seen.runId} has no wait record for await phase ${seen.phase}`);
  const key = keyOf(seen, wait);
  if (wait.outcome !== "awaiting") return { outcome: wait.outcome, key, phase: seen.phase, failing: false };
  const r = ctx.runCheck(def.check, { timeoutMs: def.checkTimeoutSeconds * 1000, env: ctx.shellOpts(seen).env, key });
  return ctx.update(() => {
    const run = ctx.loadRun();
    if (currentKey(run) !== key) return { moved: true };
    const w = currentSession(run);
    if (w.outcome !== "awaiting") return { moved: true };
    // A multi-day wait would otherwise record no drift: no `check` classifies it (§7.5).
    if (ctx.instance.declared) noteBranchDrift(ctx, run);
    const now = ctx.now();
    const at = now.toISOString();
    const event = (kind, text) => ctx.event(kind, { runId: run.runId, phase: run.phase, key, text });
    Object.assign(w, { polls: (w.polls ?? 0) + 1, lastPollAt: at, lastExit: r.status, lastError: r.timedOut ? `timed out after ${def.checkTimeoutSeconds} s` : r.error ?? null, lastOutput: r.output ?? "" });
    // A check cut off at its cap answered nothing, whatever its shell's status: a timeout is an error (§7.3). A 0 or a 75
    // is an answer, and ends any failing streak (§7.2).
    const answered = !r.timedOut && (r.status === READY || r.status === NOT_YET);
    if (answered) Object.assign(w, { failures: 0, failingSince: null, failingEmitted: false });
    if (answered && r.status === READY) {
      Object.assign(w, { outcome: "ready", readyAt: at });
      event("ready", firstLine(w.lastOutput) || "check passed");
    } else if (!answered) {
      w.failures = (w.failures ?? 0) + 1;
      w.failingSince ??= at;
      // One wake per streak, and the watcher keeps polling until a 0 or a 75 ends it.
      if (w.failures >= threshold && !w.failingEmitted) {
        w.failingEmitted = true;
        event("check-failing", `exit ${r.status}, ${w.failures} in a row: ${firstLine(w.lastOutput) || w.lastError || "no output"}`);
      }
    }
    // The check first, the deadline second: a laptop that slept through the deadline wakes to ready if the work finished (§7.2).
    if (w.outcome === "awaiting" && w.deadline && now.getTime() >= Date.parse(w.deadline)) {
      Object.assign(w, { outcome: "timed-out", timedOutAt: at });
      event("timed-out", `deadline ${w.deadline} passed; last exit ${r.status}`);
    }
    ctx.saveRun(run);
    return { outcome: w.outcome, key, phase: run.phase, failing: w.outcome === "awaiting" && w.failures >= threshold };
  });
}
