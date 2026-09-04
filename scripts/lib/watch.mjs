// scripts/lib/watch.mjs
import { check, respawnWatcher } from "./check.mjs";
import { fmtDuration } from "./markers.mjs";
import { consecutiveRateLimitResumes, currentSession } from "./state.mjs";
import { resume } from "./verbs.mjs";

const emit = (ctx, r, state, reason = "") => ctx.appendEvent([state, `${r.rider}/${r.runId}`, r.phase, r.session?.shortId ?? r.session?.id ?? "?", reason]);

/** The give-up line when `check` keeps throwing. Reads the run defensively: a corrupt run.json is the
 *  likeliest reason check threw at all, and `loadRun` would then throw again here. */
function emitCheckFailure(ctx, message) {
  let run = null;
  let sess = null;
  try { run = ctx.loadRun(); sess = run && currentSession(run); } catch { /* the record is why we are here */ }
  return ctx.appendEvent([sess?.outcome ?? "unknown", `${run?.rider ?? ctx.rider.name}/${run?.runId ?? "?"}`, run?.phase ?? "?", sess?.shortId ?? sess?.id ?? "?", `watcher giving up: ${message}`]);
}

/** The detached watcher's loop (§4.5, §4.6): polls `check`, owns the rate-limit wait, appends events. */
export function watchLoop(ctx, { maxWaitHours = 6, pollMs = 30_000, maxResumes = 3, maxCheckFailures = 5, log = () => {} } = {}) {
  let failures = 0;
  for (;;) {
    // A throw here (a transient registry read, a malformed transcript line) must not kill the watcher
    // silently: retry a bounded number of times, then leave a line the judge will see.
    let r;
    try {
      r = check(ctx);
      failures = 0;
    } catch (e) {
      failures++;
      log(`check failed (${failures}/${maxCheckFailures}): ${e.message}`);
      if (failures >= maxCheckFailures) {
        const line = emitCheckFailure(ctx, e.message);
        log(`giving up after ${failures} consecutive check failures`);
        return { ok: false, state: "watcher-stopped", error: e.message, event: line };
      }
      ctx.sleep(pollMs);
      continue;
    }
    if (r.state === "none" || r.state === "human") { log(`nothing to watch (${r.state})`); return r; }
    if (r.state === "running") { ctx.sleep(pollMs); continue; }
    if (r.state === "waiting") {
      const run = ctx.loadRun();
      const sess = currentSession(run);
      const key = JSON.stringify([sess.id, sess.turns ?? null, sess.question ?? null]);
      if (sess.waitingEmittedKey !== key) {
        sess.waitingEmittedKey = key;
        ctx.saveRun(run);
        emit(ctx, r, "waiting", r.question ? "asked with AskUserQuestion" : "stopped to ask in prose");
        log(`waiting: ${r.attach}`);
      }
      ctx.sleep(pollMs);
      continue;
    }
    if (r.outcome === "rate-limited" && r.state === "rate-limited") {
      const run = ctx.loadRun();
      const consecutive = consecutiveRateLimitResumes(run.sessions, run.phase);
      const resetAt = r.rateLimit?.resetAt ? new Date(r.rateLimit.resetAt) : null;
      const waitMs = resetAt ? resetAt.getTime() - ctx.now().getTime() : null;
      let giveUp = null;
      if (!resetAt) giveUp = "no reset time could be parsed from the rate-limit message";
      else if (consecutive >= maxResumes) giveUp = `resumed after a rate limit ${consecutive} times and the limit keeps returning`;
      else if (waitMs > maxWaitHours * 3600_000) giveUp = `reset is ${fmtDuration(waitMs)} away, past the ${maxWaitHours}h cap (maxWaitHours in local.json)`;
      if (giveUp) { emit(ctx, r, "rate-limited", giveUp); log(`rate limited; giving up: ${giveUp}`); return r; }
      const until = resetAt.getTime() + 60_000;
      log(`rate limited; waiting ${fmtDuration(until - ctx.now().getTime())} for the reset, then resuming ${r.session.id}`);
      const sessAt = r.session.at;
      while (ctx.now().getTime() < until) {
        ctx.sleep(Math.min(15 * 60_000, until - ctx.now().getTime()));
        const fresh = ctx.loadRun();
        if (!fresh || fresh.runId !== r.runId || fresh.phase !== r.phase || currentSession(fresh)?.at !== sessAt) { log("the run moved on while waiting; exiting"); return null; }
      }
      const res = resume(ctx, { reason: "rate-limit" });
      if (!res.ok) { emit(ctx, r, "rate-limited", `resume failed: ${res.error}`); return r; }
      log(`resumed as ${res.session.shortId}`);
      continue;
    }
    emit(ctx, r, r.state, r.statusHint ?? r.doneReason ?? "");
    log(`${r.state}: ${r.statusHint ?? r.doneReason ?? ""}`);
    return r;
  }
}

/** What the judge backgrounds (§3.3): block until the next event line, or until the phase is past running. */
export function awaitEvent(ctx, { maxMinutes = 60, pollMs = 10_000 } = {}) {
  const baseline = ctx.readEvents().length;
  const deadline = ctx.now().getTime() + maxMinutes * 60_000;
  for (;;) {
    const events = ctx.readEvents();
    if (events.length > baseline) return { ok: true, state: "event", events: events.slice(baseline) };
    const run = ctx.loadRun();
    const sess = run && currentSession(run);
    const kind = run ? ctx.rider.phases[run.phase].kind : null;
    const live = kind === "session" && sess && (sess.outcome === "running" || sess.outcome === "waiting");
    if (!live) return { ok: true, state: "event", events: [], reason: run ? `phase ${run.phase} is ${kind === "human" ? "a human phase" : sess?.outcome ?? "unlaunched"}` : "no active run" };
    // A watcher that died (crash, reboot, killed node) would otherwise leave the paid session unobserved
    // while this await heart-beats forever: respawn it here exactly as `check` does.
    respawnWatcher(ctx, run, sess);
    if (ctx.now().getTime() >= deadline) return { ok: false, state: "timeout", minutes: maxMinutes };
    ctx.sleep(pollMs);
  }
}
