// scripts/lib/check.mjs
import { decideWithLine } from "./keys.mjs";
import { signedOff, statusHint, waitingIsDone } from "./markers.mjs";
import { legalLabels } from "./rider-md.mjs";
import { sh } from "./shell.mjs";
import { chainCost, chainResumes, currentSession, keyOf, totalCost } from "./state.mjs";
import { readJson } from "./store.mjs";

const SETTLE_MS = 1000;
const DONE_GRACE_MS = 10 * 60_000;
const EVIDENCE_CAP = 2048;
const STOPPED = new Set(["done", "gone", "rate-limited"]);
/** The states a judge decides on, so the ones `check` prints a decide-with line for. */
const DECIDABLE = new Set([...STOPPED, "intervened"]);
/** The run a locked write committed, carried on its result for the readouts that run after the lock is released.
 *  A symbol key, so `--json` never prints it. */
export const RUN = Symbol("run");

/** One watcher per live session: respawn a dead one and count the spawn on the session record.
 *  Idempotent — `ensureWatcher` returns false while the pid file names a living process. */
export function respawnWatcher(ctx, run, sess) {
  if (ctx.watcherAlive() || !ctx.ensureWatcher()) return false;
  sess.watcherSpawns = (sess.watcherSpawns ?? 0) + 1;
  ctx.saveRun(run);
  return true;
}

/** One classification pass over the active run (§4.4). Idempotent; never blocks longer than ~20 s. The whole pass
 *  is one locked write, so a check queued behind another reads the outcome that one stored (§7.3). The watcher passes
 *  `readouts: false`: it acts on the classification and prints neither evidence nor show. */
export function check(ctx, { readouts: withReadouts = true } = {}) {
  const r = ctx.update(() => classify(ctx));
  return withReadouts ? readouts(ctx, r) : r;
}

/** What informs the judge but decides nothing runs after the lock is released, against the state just committed (§7.1):
 *  a stopped or waiting session's evidence, and a human phase's show. Each command may take seconds; no writer waits on them. */
export function readouts(ctx, r) {
  const run = r?.[RUN];
  if (!run) return r;
  if (r.state === "human") {
    const show = ctx.rider.phases[r.phase]?.show;
    r.show = show ? sh(show, ctx.shellOpts(run)).output : null;
  } else if (r.session && r.state !== "running") r.evidence = runEvidence(ctx, run);
  return r;
}

function classify(ctx) {
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

  // A `done` is followed by a destructive `stop`, and one registry sample is not proof the session
  // stopped: run 7cb5's close session was sampled idle in the two seconds between its subagent
  // finishing and the harness waking it, and was stopped mid-hand-back. A STATUS line corroborates the
  // registry in the session's own words; a bare `done` has only the registry, so it is confirmed first.
  // `sightings` counts consecutive bare-done checks over an unchanged transcript.
  if (kind === "done" && statusHint(h.lastText) === null) {
    const sightings = sess.bareDone?.turns === h.turns ? sess.bareDone.sightings + 1 : 1;
    sess.bareDone = { turns: h.turns, sightings };
    if (!bareDoneConfirmed({ sightings, entry: st.entry, h })) { kind = "running"; note = "idle with no STATUS line; confirming on the next check"; }
  } else sess.bareDone = null;

  if (kind === "waiting") {
    for (let i = 0; i < 10 && !h.question; i++) { ctx.sleep(SETTLE_MS); h = ctx.binding.read(ids); }
    // Only what is known. That the session "asked in prose" was an inference, and a wrong one five
    // times in six: whether the final message asks for anything is the judge's to read.
    if (waitingIsDone(h)) { kind = "done"; sess.doneReason = "registry reports the session waiting for input; no AskUserQuestion is pending and its final message carries a STATUS line"; }
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
    noteWorkBranch(ctx, run);
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
  noteWorkBranch(ctx, run);
  sess.outcome = kind;
  sess.stoppedAt = ctx.now().toISOString();
  sess.turns = h.turns;
  sess.elapsedMs = elapsed;
  sess.question = h.question ?? null;
  sess.cost = h.cost == null ? null : Math.max(0, h.cost - chainCost(run.sessions, sess));
  sess.humanTurns = humanTurns(run, sess, h);
  sess.humanTurnDetails = humanTurnDetails(run, sess, h);
  sess.intervened = sess.humanTurns > 0;
  // What the session actually ran under. The rider sets a model and a permission mode; everything else
  // is the operator's ambient setup, and cost compared across runs is confounded by settings nobody recorded.
  sess.harness = h.harness ?? null;
  sess.log = ctx.writeLog(`${sess.stoppedAt.replace(/[:.]/g, "-")}-${run.phase}-${sess.shortId ?? "id"}.json`, {
    runId: run.runId, phase: run.phase, ...ids, outcome: kind, entry: st.entry ?? null, resetAt, harness: sess.harness,
    cost: h.cost, turns: h.turns, userTurns: h.userTurns, question: h.question, lastText: h.lastText, lastAt: h.lastAt ?? null, signal: h.signal, transcript: h.transcript, tail: h.tail,
  });
  ctx.saveRun(run);
  return result(ctx, run, sess, kind, h.lastText ?? "");
}

/** Sticky: the branch the work went to. Not cleared when the operator checks out the base for the
 *  merge — that is exactly when the terminal check needs the feature branch's name. Its tip is kept
 *  beside it because a name does not survive the branch being deleted after the merge, and a sha does. */
function noteWorkBranch(ctx, run) {
  const now = ctx.branch();
  if (!now || now === run.baseBranch) return;
  run.workBranch = now;
  const tip = ctx.tip("HEAD");
  if (tip) run.workTip = tip;
}

/** The one policy decision in confirming a bare `done` (see its call site): may `check` act on it now?
 *  `sightings` — consecutive bare-done checks over an unchanged transcript, this one included (>= 1).
 *  The call site also offers the registry `entry` and the transcript read `h`, unused on purpose.
 *  Returning false costs one poll interval before the stop is acted on; returning true on a sample
 *  taken mid-hand-back stops a live, paid session. */
function bareDoneConfirmed({ sightings }) {
  // Two looks over an unchanged transcript, the rule `gone` already lives by. Deliberately blind to
  // `entry.state`: it read `done` on every real stop in the first 21 harvests and `working` on 7cb5's
  // false one, but it also read `working` on two real stops, and nothing documents what it means — the
  // field that would let a stop skip the second look is the same kind of sample that caused the bug.
  // A rate limit or an API error waits one poll like the rest: nothing is running, so nothing is lost.
  return sightings >= 2;
}

/** Human-origin user turns beyond the launch prompt and the nudges the rider itself typed. */
function humanTurns(run, sess, h) { return Math.max(0, (h.userTurns ?? 0) - 1 - chainResumes(run.sessions, sess)); }

/** The same turns `humanTurns` counts: the launch prompt (always the first counted turn) dropped, then
 *  every nudge the rider typed. The nudges go by identity, not by position — a nudge follows whatever
 *  the operator typed in the previous stretch, so dropping a fixed prefix would hide that turn and show
 *  the nudge as the intervention. `humanTurns` stays arithmetic: a count is right in any order. */
function humanTurnDetails(run, sess, h) { return (h.userTurnDetails ?? []).slice(1).filter((t) => !t.nudge); }

function checkHuman(ctx, run, def) {
  // The work branch keeps moving at a human phase — the operator's gate-review fixes land on it. Follow
  // it while it resolves, so `$RIDER_WORK_TIP` is the tip that has to reach the base; once the branch is
  // deleted the last sighting stands, which is exactly when a check by name could no longer answer.
  const tip = run.workBranch ? ctx.tip(`refs/heads/${run.workBranch}`) : null;
  if (tip && tip !== run.workTip) { run.workTip = tip; ctx.saveRun(run); }
  const r = sh(def.check, ctx.shellOpts(run));
  if (r.status === 0) {
    noteAfterHandoff(ctx, run, tip);
    const reason = `${run.phase}: check passed (${def.check})`;
    ctx.endRun(run, { endedBy: "done", reason });
    return { state: "none", ended: { runId: run.runId, phase: run.phase, reason }, lastRun: run };
  }
  // The check runs inside the hold, since its exit decides whether the run ends; `show` only informs (`readouts`).
  return { state: "human", rider: run.rider, runId: run.runId, key: null, phase: run.phase, check: def.check, checkExit: r.status, checkOutput: r.output, show: null, notes: run.notes, totalCost: totalCost(run), [RUN]: run };
}

/** Gate precision, mechanically: the commits that landed after the sessions handed over — every one is
 *  something the last session phase called finished and the human phase did not. Read from the work
 *  branch while it exists, and from the base once it is deleted (the merge put them there; `ref` says
 *  which was read, since the base can also carry commits that are not this run's). */
function noteAfterHandoff(ctx, run, branchTip) {
  if (!run.handoff?.tip) return;
  const ref = branchTip ? run.workBranch : run.baseBranch;
  const commits = ref ? ctx.commitsBetween(run.handoff.tip, ref) : null;
  if (commits) run.handoff.after = { ref, commits };
}

export function runEvidence(ctx, run) {
  return ctx.rider.evidence.map((cmd) => ({ cmd, ...sh(cmd, { ...ctx.shellOpts(run), capBytes: EVIDENCE_CAP, timeoutMs: 10_000 }) }));
}

function result(ctx, run, sess, outcome, finalText, note = null) {
  const ids = { shortId: sess.shortId, sessionId: sess.id };
  // `intervened` overrides only a STOPPED outcome: a live (running/waiting) session the operator once
  // typed into would otherwise read intervened on every check, and the watcher would loop on it.
  const state = sess.intervened && STOPPED.has(outcome) ? "intervened" : outcome;
  const key = keyOf(run, sess);
  const labels = legalLabels(ctx.rider, run.phase);
  return {
    state, outcome, note,
    rider: run.rider, runId: run.runId, key, phase: run.phase, visit: run.visits[run.phase] ?? 1,
    session: { id: sess.id, shortId: sess.shortId, model: sess.model, at: sess.at, resumedFrom: sess.resumedFrom ?? null },
    attach: ctx.binding.attachHint(ids),
    statusHint: sess.statusHint ?? statusHint(finalText),
    doneReason: sess.doneReason ?? null,
    resumes: chainResumes(run.sessions, sess),
    lastResume: sess.resumedFrom ? { reason: sess.resumeReason, at: sess.at } : null,
    rateLimit: sess.rateLimit ?? null, harness: sess.harness ?? null,
    humanTurns: sess.humanTurns ?? 0, humanTurnDetails: sess.humanTurnDetails ?? [], cost: sess.cost ?? null, turns: sess.turns ?? null, elapsedMs: sess.elapsedMs ?? null,
    question: sess.question ?? null, finalText,
    evidence: [], // `readouts` fills it once the lock is released
    labels, log: sess.log ?? null,
    decideWith: DECIDABLE.has(state) ? decideWithLine({ rider: ctx.rider.name, multiRider: ctx.riderCount > 1, instance: ctx.instance.id, declared: !!ctx.instance.declared, key, labels: labels.map((l) => l.label) }) : null,
    [RUN]: run,
  };
}
