// scripts/lib/check.mjs
import { signedOff, statusHint, waitingIsDone } from "./markers.mjs";
import { legalLabels } from "./rider-md.mjs";
import { sh } from "./shell.mjs";
import { chainCost, chainResumes, currentSession, readJson, totalCost } from "./state.mjs";

const SETTLE_MS = 1000;
const DONE_GRACE_MS = 10 * 60_000;
const EVIDENCE_CAP = 2048;
const STOPPED = new Set(["done", "gone", "rate-limited"]);

/** One watcher per live session: respawn a dead one and count the spawn on the session record.
 *  Idempotent — `ensureWatcher` returns false while the pid file names a living process. */
export function respawnWatcher(ctx, run, sess) {
  if (ctx.watcherAlive() || !ctx.ensureWatcher()) return false;
  sess.watcherSpawns = (sess.watcherSpawns ?? 0) + 1;
  ctx.saveRun(run);
  return true;
}

/** One classification pass over the active run (§4.4). Idempotent; never blocks longer than ~20 s. */
export function check(ctx) {
  const run = ctx.loadRun();
  if (!run) return { state: "none", lastRun: ctx.lastEndedRun() };
  const def = ctx.rider.phases[run.phase];
  if (def.kind === "human") return checkHuman(ctx, run, def);
  const sess = currentSession(run);
  if (!sess) return { state: "none", error: `run ${run.runId} has no session for phase ${run.phase}` };
  if (STOPPED.has(sess.outcome)) return result(ctx, run, sess, sess.outcome, readJson(sess.log, {})?.lastText ?? "");

  const ids = { shortId: sess.shortId, sessionId: sess.id };
  const st = ctx.binding.status(ids);
  let kind = st.kind;
  let h = ctx.binding.read(ids);
  const elapsed = ctx.now().getTime() - new Date(sess.at).getTime();
  let note = null;

  // A failing `claude agents` reads as `gone` on every session at once, and two such polls would fork a
  // paid session on the next `rider resume`. The transcript is the tie-breaker: one still writing turns
  // is not gone. A session with no recorded turns yet (never seen running) keeps the two-sighting rule.
  if (kind === "gone" && sess.turns != null && h.turns > sess.turns) {
    kind = "running";
    sess.goneSightings = 0;
    note = "not listed, but the transcript advanced";
  } else if (kind === "gone") {
    sess.goneSightings = (sess.goneSightings ?? 0) + 1;
    if (sess.goneSightings < 2) { kind = "running"; note = "not listed once; confirming on the next check"; }
  } else sess.goneSightings = 0;

  if (kind === "done" && h.turns <= (sess.baselineTurns ?? 0) && elapsed < DONE_GRACE_MS) kind = "running";

  if (kind === "waiting") {
    for (let i = 0; i < 10 && !h.question; i++) { ctx.sleep(SETTLE_MS); h = ctx.binding.read(ids); }
    if (waitingIsDone(h)) { kind = "done"; sess.doneReason = "wrote its STATUS line, then asked in prose"; }
  }

  if (kind === "running" && note === null) {
    // A sign-off counts only when THIS stretch wrote it: after a resume the transcript still ends with the
    // previous stretch's green text, and turns have not moved past the resume baseline yet.
    if (signedOff(h.lastText) && h.turns > (sess.baselineTurns ?? 0)) {
      if (sess.signedOffTurns === h.turns) { kind = "done"; sess.doneReason = "signed off; something it left running holds the process open"; }
      else sess.signedOffTurns = h.turns;
    } else sess.signedOffTurns = null;
  }

  if (kind === "running" || kind === "waiting") {
    sess.outcome = kind;
    sess.turns = h.turns;
    sess.question = h.question ?? null;
    sess.humanTurns = humanTurns(run, sess, h);
    sess.humanTurnDetails = humanTurnDetails(run, sess, h);
    sess.intervened = sess.humanTurns > 0;
    if (kind === "waiting") sess.questionRelayed = true;
    ctx.saveRun(run);
    respawnWatcher(ctx, run, sess);
    return result(ctx, run, sess, kind, h.lastText ?? "", note);
  }

  if (kind === "done" && st.entry?.pid) {
    const before = h.costEntries;
    ctx.binding.stop(ids);
    for (let i = 0; i < 8 && h.costEntries <= before; i++) { ctx.sleep(SETTLE_MS); h = ctx.binding.read(ids); }
  }
  let resetAt = null;
  sess.statusHint = statusHint(h.lastText);
  if (kind === "done" && !sess.statusHint) {
    // Anchor the reset at the session's last turn, not at this check: the judge may have been down.
    const lastAt = h.lastAt ? new Date(h.lastAt) : null;
    const anchor = lastAt && !Number.isNaN(lastAt.getTime()) ? lastAt : ctx.now();
    const f = ctx.binding.heuristics.classifyNoMarker(null, `${h.signal}\n${h.lastText ?? ""}`, anchor);
    if (f.kind === "rate-limited") {
      kind = "rate-limited";
      resetAt = f.resetAt ? f.resetAt.toISOString() : null;
      sess.rateLimit = { at: ctx.now().toISOString(), resetAt };
    } else if (f.kind === "api-error") sess.doneReason = `ended on an API error (HTTP ${f.status ?? "?"}) with no STATUS line`;
    else sess.doneReason ??= "no STATUS line in the final message";
  }
  sess.outcome = kind;
  sess.stoppedAt = ctx.now().toISOString();
  sess.turns = h.turns;
  sess.elapsedMs = elapsed;
  sess.question = h.question ?? null;
  sess.cost = h.cost == null ? null : Math.max(0, h.cost - chainCost(run.sessions, sess));
  sess.humanTurns = humanTurns(run, sess, h);
  sess.humanTurnDetails = humanTurnDetails(run, sess, h);
  sess.intervened = sess.humanTurns > 0;
  sess.log = ctx.writeLog(`${sess.stoppedAt.replace(/[:.]/g, "-")}-${run.phase}-${sess.shortId ?? "id"}.json`, {
    runId: run.runId, phase: run.phase, ...ids, outcome: kind, entry: st.entry ?? null, resetAt,
    cost: h.cost, turns: h.turns, userTurns: h.userTurns, question: h.question, lastText: h.lastText, lastAt: h.lastAt ?? null, signal: h.signal, transcript: h.transcript, tail: h.tail,
  });
  ctx.saveRun(run);
  return result(ctx, run, sess, kind, h.lastText ?? "");
}

/** Human-origin user turns beyond the launch prompt and the nudges the rider itself typed. */
function humanTurns(run, sess, h) { return Math.max(0, (h.userTurns ?? 0) - 1 - chainResumes(run.sessions, sess)); }

/** The same turns `humanTurns` counts: the launch prompt (always the first counted turn) dropped, then
 *  every nudge the rider typed. The nudges go by identity, not by position — a nudge follows whatever
 *  the operator typed in the previous stretch, so dropping a fixed prefix would hide that turn and show
 *  the nudge as the intervention. `humanTurns` stays arithmetic: a count is right in any order. */
function humanTurnDetails(run, sess, h) { return (h.userTurnDetails ?? []).slice(1).filter((t) => !t.nudge); }

function checkHuman(ctx, run, def) {
  const r = sh(def.check, ctx.shellOpts());
  if (r.status === 0) {
    const reason = `${run.phase}: check passed (${def.check})`;
    ctx.endRun(run, { endedBy: "done", reason });
    return { state: "none", ended: { runId: run.runId, phase: run.phase, reason }, lastRun: run };
  }
  const show = def.show ? sh(def.show, ctx.shellOpts()).output : null;
  return { state: "human", rider: run.rider, runId: run.runId, phase: run.phase, check: def.check, checkExit: r.status, checkOutput: r.output, show, notes: run.notes, totalCost: totalCost(run) };
}

export function runEvidence(ctx) {
  return ctx.rider.evidence.map((cmd) => ({ cmd, ...sh(cmd, { ...ctx.shellOpts(), capBytes: EVIDENCE_CAP, timeoutMs: 10_000 }) }));
}

function result(ctx, run, sess, outcome, finalText, note = null) {
  const ids = { shortId: sess.shortId, sessionId: sess.id };
  // `intervened` overrides only a STOPPED outcome: a live (running/waiting) session the operator once
  // typed into would otherwise read intervened on every check, and the watcher would loop on it.
  const state = sess.intervened && STOPPED.has(outcome) ? "intervened" : outcome;
  return {
    state, outcome, note,
    rider: run.rider, runId: run.runId, phase: run.phase, visit: run.visits[run.phase] ?? 1,
    session: { id: sess.id, shortId: sess.shortId, model: sess.model, at: sess.at, resumedFrom: sess.resumedFrom ?? null },
    attach: ctx.binding.attachHint(ids),
    statusHint: sess.statusHint ?? statusHint(finalText),
    doneReason: sess.doneReason ?? null,
    resumes: chainResumes(run.sessions, sess),
    lastResume: sess.resumedFrom ? { reason: sess.resumeReason, at: sess.at } : null,
    rateLimit: sess.rateLimit ?? null,
    humanTurns: sess.humanTurns ?? 0, humanTurnDetails: sess.humanTurnDetails ?? [], cost: sess.cost ?? null, turns: sess.turns ?? null, elapsedMs: sess.elapsedMs ?? null,
    question: sess.question ?? null, finalText,
    evidence: state === "running" ? [] : runEvidence(ctx),
    labels: legalLabels(ctx.rider, run.phase), log: sess.log ?? null,
  };
}
