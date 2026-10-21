// scripts/lib/preflight.mjs
import { sh } from "./shell.mjs";

/** `locate` and each `requires` command get evidence's cap (§4): each is a quick look, and one that hangs past it is a
 *  refusal, never a pass. */
export const REQUIRES_CAP = { timeoutMs: 10_000, capBytes: 2048 };

/** The phase kinds `start` may enter: any declared phase, a gate (§6.2) and a wait (§7.5) included, so a fresh run after a
 *  reset or a reboot goes straight back to the wait. The one place a kind is admitted. */
const STARTABLE = new Set(["session", "human", "await"]);

/** The first non-empty line of a command's output, trimmed (a `\r` with it): what a one-line answer, or one entry of a
 *  readout, has room for. */
export const firstLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** One command under that cap, with its exit in words. `sh` reads a timeout as exit -1, as it does a spawn failure; only
 *  its error says which, so `exit` names a timeout. `local.requiresTimeoutMs` lowers the timeout for the tests only: it
 *  is no setting. */
function capped(ctx, cmd, opts) {
  const timeoutMs = ctx.local?.requiresTimeoutMs ?? REQUIRES_CAP.timeoutMs;
  const r = sh(cmd, { ...opts, timeoutMs, capBytes: REQUIRES_CAP.capBytes });
  const timedOut = r.status !== 0 && /\bETIMEDOUT\b/.test(r.error ?? "");
  return { ...r, timedOut, exit: timedOut ? `exit -1: timed out after ${timeoutMs / 1000} s` : `exit ${r.status}` };
}

/** The target's entry preconditions (§5.1), in order, stopping at the first that fails. Run before the verb takes the
 *  lock, so a slow one never holds it; the hold re-validates what they were computed for, never their answer. Besides
 *  `error`, a failure names its `cmd`, `status`, `output` and whether it `timedOut`, for a readout that shows them
 *  apart. */
export function requiresFor(ctx, { run, to, from = "", label = "" }) {
  for (const cmd of ctx.rider.phases[to]?.requires ?? []) {
    const r = capped(ctx, cmd, ctx.shellOpts(run, { phase: to, fromPhase: from, label }));
    if (r.status === 0) continue;
    return { ok: false, cause: "requires", error: `requires check failed for ${to} (${r.exit}): ${cmd}${r.output ? `\n${r.output}` : ""}`, cmd, status: r.status, output: r.output, timedOut: r.timedOut };
  }
  return { ok: true };
}

/** What `next` and `overrule` check before the lock (§4): the requires of the phase `label` leads to from `run`'s phase.
 *  Only a declared edge to a phase has any: `resume` re-enters a phase already admitted (§5.2), and `operator` is no
 *  phase. Null when `label` names no edge to a declared phase; the hold then refuses any target that has requires. A
 *  target with no requires gets a passing result, with no command run. */
export function edgePreflight(ctx, run, { on, label }) {
  const edges = ctx.rider.phases[run.phase]?.edges;
  // Own keys only: a label like "toString" must not read through Object.prototype.
  const to = edges && typeof label === "string" && Object.hasOwn(edges, label) ? edges[label] : null;
  if (!to || !Object.hasOwn(ctx.rider.phases, to)) return null;
  return { on, label, from: run.phase, to, result: requiresFor(ctx, { run, to, from: run.phase, label }) };
}

/** Where `locate` says a fresh run enters (§6.2). It is asked which phase, so it runs with `RIDER_PHASE` empty, and its
 *  answer is the first line of stdout alone: a warning on stderr is no part of a phase name. `phase` is null unless that
 *  line names a declared phase; then `why` says what it did instead, and `error` is the refusal when nothing overrides it. */
function locate(ctx, baseBranch) {
  const cmd = ctx.rider.locate;
  const r = capped(ctx, cmd, ctx.shellOpts({ baseBranch }, { phase: "" }));
  if (r.status !== 0) return { phase: null, why: `locate failed (${r.exit})`, error: `locate failed (${r.exit}): ${cmd}${r.output ? `\n${r.output}` : ""}` };
  const line = firstLine(r.stdout);
  // Own keys only: a line like "toString" names no phase.
  if (line && Object.hasOwn(ctx.rider.phases, line)) return { phase: line };
  const why = line ? `locate printed "${line}", which is not a declared phase` : "locate printed nothing";
  return { phase: null, why, error: why };
}

/** What `start` checks before it takes the lock (§4), in its order: the target (the operator's phase, else `locate`'s,
 *  else `start:`), then intake, then the target's own door, so a slow entry command never holds the lock. It reads no
 *  state: the verb's hold re-checks that no run is active. `entry` records how the target was chosen, `note` a `locate`
 *  the operator's word overrode, and `gate` a gate's failed check, `{ status, output }`. A refusal's `cause` names the
 *  entry command that refused; a usage error (an unknown phase, a phase `start` cannot enter) has none. */
export function startPreflight(ctx, { phase = null } = {}) {
  const refused = (error, cause = null, target = null) => ({ ok: false, error, cause, target });
  // Own keys only, as for an edge's label. A usage error runs nothing, `locate` included.
  if (phase != null && !Object.hasOwn(ctx.rider.phases, phase)) return refused(`no phase "${phase}" — phases: ${Object.keys(ctx.rider.phases).join(", ")}`, null, phase);
  // The run does not exist yet, so its entry commands are told about the branch it is about to be recorded on.
  const baseBranch = ctx.branch();
  // Run even when the operator names the phase: their word wins, and a disagreement is only noted (§6.2).
  const found = ctx.rider.locate ? locate(ctx, baseBranch) : null;
  let entry, note = null;
  if (phase != null) {
    entry = { by: "operator", located: found?.phase ?? null, phase };
    if (found && found.phase !== phase) note = `${found.phase ? `located ${found.phase}` : found.why}; entering ${phase} on the operator's word`;
  } else if (found) {
    // Never `start:` instead: a locate that answers nothing usable is how a rider says there is nothing to start.
    if (!found.phase) return refused(found.error, "locate");
    entry = { by: "locate", located: found.phase, phase: found.phase };
  } else entry = { by: "start", located: null, phase: ctx.rider.start };
  const target = entry.phase;
  const def = ctx.rider.phases[target];
  if (!STARTABLE.has(def.kind)) return refused(`start cannot enter "${target}", a phase of kind ${def.kind}`, null, target);
  for (const cmd of ctx.rider.intake) {
    const r = sh(cmd, ctx.shellOpts({ phase: target, baseBranch }));
    if (r.status !== 0) return refused(`intake check failed (exit ${r.status}): ${cmd}${r.output ? `\n${r.output}` : ""}`, "intake", target);
  }
  let gate = null;
  if (def.kind === "human") {
    // A gate has no requires; its check is its door, and it must fail. A passed gate would end the run on the first
    // check, and a locate that keeps naming it would loop the judge (§6.2). It runs as `check` runs it, with `sh`'s 30 s.
    const r = sh(def.check, ctx.shellOpts({ phase: target, baseBranch }));
    if (r.status === 0) return refused(`${target}'s check already passes; nothing waits on the operator there`, "gate", target);
    // The block `start` prints reports this run of the check, as `rider check`'s would.
    gate = { status: r.status, output: r.output };
  } else {
    // A session phase or a wait. The run's door first, then the phase's: a fresh run leaves no phase and takes no label.
    const req = requiresFor(ctx, { run: { phase: target, baseBranch }, to: target });
    if (!req.ok) return refused(req.error, req.cause, target);
  }
  return { ok: true, target, baseBranch, entry, note, gate };
}
