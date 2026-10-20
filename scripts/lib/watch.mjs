// scripts/lib/watch.mjs
import { pollAwait } from "./await.mjs";
import { check, respawnWatcher, RUN } from "./check.mjs";
import { currentKey } from "./keys.mjs";
import { fmtDuration } from "./markers.mjs";
import { awaitsReset, consecutiveRateLimitResumes, currentSession, isLive, keyOf } from "./state.mjs";
import { WAKE_KINDS } from "./store.mjs";
import { resume } from "./verbs.mjs";

/** One wake event is one short locked write: the watcher never holds the instance across a sleep (§13). It re-reads
 *  the run first: a judge reading the stored block may have decided since this watcher's check, and an event for a
 *  stretch the run has moved past would wake the await armed on the next one. False, and nothing written, when it moved on. */
const emit = (ctx, r, kind, text = "") => ctx.update(() => {
  if (!r.key || currentKey(ctx.loadRun()) !== r.key) return false;
  ctx.event(kind, { runId: r.runId, phase: r.phase, key: r.key, text });
  return true;
});
/** A result with no key can never emit: going round again would spin on it, so it ends the watch. */
const MOVED_ON = "the run moved on; exiting";
/** A decision landed between the check and its emit, and its new stretch has no watcher but this one. It cannot spin:
 *  with a key, emit is false only once the run's current key is another, so the next pass classifies another stretch,
 *  or finds nothing live and returns. */
const MOVED_ON_WATCHING = "the run moved on; watching its current stretch";
const MOVED_ON_WAITING = "the run moved on while waiting; watching its current stretch";

/** The give-up event when `check` keeps throwing. Reads the run defensively: a corrupt state.json is the
 *  likeliest reason check threw at all, and `loadRun` would then throw again here. */
function emitCheckFailure(ctx, message) {
  return ctx.update(() => {
    let run = null;
    let sess = null;
    try { run = ctx.loadRun(); sess = run && currentSession(run); } catch { /* the record is why we are here */ }
    return ctx.event("watcher-stopped", { runId: run?.runId ?? null, phase: run?.phase ?? null, key: sess ? keyOf(run, sess) : null, text: `watcher giving up: ${message}` });
  });
}

/** The detached watcher's loop (§4.5, §4.6, §13): polls `check`, owns the rate-limit wait, appends wake events.
 *  Every check and every emission is its own locked write; the sleeps between them hold nothing. At an await phase it
 *  polls the wait's check instead (§7.5), at that phase's `pollSeconds`: the one watcher spans both kinds, and picks its
 *  interval from the kind of whatever the run now runs. `failuresBeforeWake` is `local.json`'s `awaitCheckFailures`. */
export function watchLoop(ctx, { maxWaitHours = 6, pollMs = 30_000, maxResumes = 3, maxCheckFailures = 5, failuresBeforeWake = 3, log = () => {} } = {}) {
  let failures = 0;
  for (;;) {
    // A throw here (a transient registry read, a malformed transcript line, a corrupt state.json) must not kill the
    // watcher silently: retry a bounded number of times, then leave an event the judge will see.
    let r;
    let polled = null;
    try {
      // Decided from the stored run, before `check`, which classifies sessions in one locked hold: a wait's check runs with nothing held (§7.3).
      const stored = ctx.loadRun();
      if (stored && ctx.rider.phases[stored.phase]?.kind === "await") polled = pollAwait(ctx, { threshold: failuresBeforeWake });
      else r = check(ctx, { readouts: false });
      failures = 0;
    } catch (e) {
      failures++;
      log(`check failed (${failures}/${maxCheckFailures}): ${e.message}`);
      if (failures >= maxCheckFailures) {
        const event = emitCheckFailure(ctx, e.message);
        log(`giving up after ${failures} consecutive check failures`);
        return { ok: false, state: "watcher-stopped", error: e.message, event };
      }
      ctx.sleep(pollMs);
      continue;
    }
    if (polled) {
      // A tick whose run moved on is left to finish, and its poll is not committed (§7.3.1): watch what the run now runs.
      if (polled.moved) { log(MOVED_ON_WATCHING); continue; }
      if (polled.outcome === "ready" || polled.outcome === "timed-out") { log(`${polled.outcome}: ${polled.key}`); return { ok: true, state: polled.outcome, key: polled.key, phase: polled.phase }; }
      ctx.sleep(ctx.rider.phases[polled.phase].pollSeconds * 1000);
      continue;
    }
    // A decision entered a wait between the stored read and `check`, which reports a wait and never polls it: go round.
    if (r.kind === "await") { log(MOVED_ON_WATCHING); continue; }
    if (r.state === "none" || r.state === "human") { log(`nothing to watch (${r.state})`); return r; }
    if (r.state === "running") { ctx.sleep(pollMs); continue; }
    if (r.state === "waiting") {
      // The mark and the event are one write, on the run as it is now: one that moved on since the check gets neither.
      const emitted = ctx.update(() => {
        const run = ctx.loadRun();
        const sess = run && currentSession(run);
        if (sess?.outcome !== "waiting") return false;
        const key = JSON.stringify([sess.id, sess.turns ?? null, sess.question ?? null]);
        if (sess.waitingEmittedKey === key) return false;
        sess.waitingEmittedKey = key;
        ctx.saveRun(run);
        ctx.event("waiting", { runId: run.runId, phase: run.phase, key: keyOf(run, sess), text: sess.question ? "asked with AskUserQuestion" : "stopped to ask in prose" });
        return true;
      });
      if (emitted) log(`waiting: ${r.attach}`);
      ctx.sleep(pollMs);
      continue;
    }
    if (r.outcome === "rate-limited" && r.state === "rate-limited") {
      // The run this check committed, not a fresh read: a reset since would leave no run to count resumes on.
      const run = r[RUN];
      const consecutive = consecutiveRateLimitResumes(run.sessions, run.phase);
      const resetAt = r.rateLimit?.resetAt ? new Date(r.rateLimit.resetAt) : null;
      const waitMs = resetAt ? resetAt.getTime() - ctx.now().getTime() : null;
      let giveUp = null;
      if (!resetAt) giveUp = "no reset time could be parsed from the rate-limit message";
      else if (consecutive >= maxResumes) giveUp = `resumed after a rate limit ${consecutive} times and the limit keeps returning`;
      else if (waitMs > maxWaitHours * 3600_000) giveUp = `reset is ${fmtDuration(waitMs)} away, past the ${maxWaitHours}h cap (maxWaitHours in local.json)`;
      if (giveUp) {
        if (!emit(ctx, r, "rate-limited", giveUp)) { if (!r.key) { log(MOVED_ON); return null; } log(MOVED_ON_WATCHING); continue; }
        log(`rate limited; giving up: ${giveUp}`);
        return r;
      }
      const until = resetAt.getTime() + 60_000;
      log(`rate limited; waiting ${fmtDuration(until - ctx.now().getTime())} for the reset, then resuming ${r.session.id}`);
      // The key of the stretch it waits on: its resume is a decision like any other (§8), refused if anyone else moved first.
      // A decision during the wait launches its stretch while this watcher is alive, so none is spawned for it: the wait
      // ticks at pollMs, one state read each, and on a moved key goes back to watching whatever the run now runs.
      const waited = r.key;
      let moved = false;
      while (!moved && ctx.now().getTime() < until) {
        ctx.sleep(Math.min(pollMs, until - ctx.now().getTime()));
        moved = currentKey(ctx.loadRun()) !== waited;
      }
      if (moved) { log(MOVED_ON_WAITING); continue; }
      const res = resume(ctx, { on: waited, by: "executor", reason: "rate-limit" });
      if (!res.ok) {
        if (res.stale) { log(MOVED_ON_WAITING); continue; }
        if (!emit(ctx, r, "rate-limited", `resume failed: ${res.error}`)) { if (!r.key) { log(MOVED_ON); return null; } log(MOVED_ON_WATCHING); continue; }
        return r;
      }
      log(`resumed as ${res.session.shortId}`);
      continue;
    }
    if (!emit(ctx, r, r.state, r.statusHint ?? r.doneReason ?? "")) { if (!r.key) { log(MOVED_ON); return null; } log(MOVED_ON_WATCHING); continue; }
    log(`${r.state}: ${r.statusHint ?? r.doneReason ?? ""}`);
    return r;
  }
}

/** A rate-limited stretch whose watcher is alive is waiting for the reset, and reads as running (spec decision 15). The
 *  watcher resumes it on its own, or emits `rate-limited` when it gives up: either way an event comes. */
function waitsOnReset(ctx, run) {
  return awaitsReset(run && currentSession(run)) && !!ctx.watcherAlive();
}

/** What the judge backgrounds (§3.3, §13): block until the watcher's next wake event, or until the phase is past
 *  running. It reads without the lock; only a respawn writes. An await that returned at once on a reset the watcher
 *  waits for would be re-armed and return again, with no event in between. With no `maxMinutes`, the heartbeat is the
 *  phase kind's (§16 C13): a wait may last days, and an hourly heartbeat would re-arm the judge dozens of times. */
export function awaitEvent(ctx, { maxMinutes = null, pollMs = 10_000 } = {}) {
  const baseline = ctx.readEvents().reduce((max, e) => (Number.isInteger(e.seq) && e.seq > max ? e.seq : max), 0);
  const seen = ctx.loadRun();
  const minutes = maxMinutes ?? (seen && ctx.rider.phases[seen.phase]?.kind === "await" ? 360 : 60);
  const deadline = ctx.now().getTime() + minutes * 60_000;
  for (;;) {
    const events = ctx.readEvents().filter((e) => e.seq > baseline && WAKE_KINDS.includes(e.kind));
    if (events.length) return { ok: true, state: "event", events };
    const run = ctx.loadRun();
    if (!isLive(run, ctx.rider) && !waitsOnReset(ctx, run)) {
      const sess = run && currentSession(run);
      const kind = run ? ctx.rider.phases[run.phase].kind : null;
      return { ok: true, state: "event", events: [], reason: run ? `phase ${run.phase} is ${kind === "human" ? "a human phase" : sess?.outcome ?? "unlaunched"}` : "no active run" };
    }
    // A watcher that died (crash, reboot, killed node) would otherwise leave the paid session unobserved
    // while this await heart-beats forever: respawn it here exactly as `check` does, under the lock and on
    // the run as it is once the lock is held.
    if (!ctx.watcherAlive()) ctx.update(() => { const fresh = ctx.loadRun(); if (isLive(fresh, ctx.rider)) respawnWatcher(ctx, fresh, currentSession(fresh)); });
    if (ctx.now().getTime() >= deadline) return { ok: false, state: "timeout", minutes };
    ctx.sleep(pollMs);
  }
}
