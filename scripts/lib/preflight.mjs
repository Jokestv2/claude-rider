// scripts/lib/preflight.mjs
import { sh } from "./shell.mjs";

/** Each `requires` command gets evidence's cap (§4): a precondition is a quick look, and one that hangs past it is a
 *  refusal, never a pass. */
export const REQUIRES_CAP = { timeoutMs: 10_000, capBytes: 2048 };

/** The target's entry preconditions (§5.1), in order, stopping at the first that fails. Run before the verb takes the
 *  lock, so a slow one never holds it; the hold re-validates what they were computed for, never their answer. Besides
 *  `error`, a failure names its `cmd`, `status` and `output`, for a readout that shows them apart. `local.requiresTimeoutMs`
 *  lowers the timeout for the tests only: it is no setting. */
export function requiresFor(ctx, { run, to, from = "", label = "" }) {
  const timeoutMs = ctx.local?.requiresTimeoutMs ?? REQUIRES_CAP.timeoutMs;
  for (const cmd of ctx.rider.phases[to]?.requires ?? []) {
    const r = sh(cmd, { ...ctx.shellOpts(run, { phase: to, fromPhase: from, label }), timeoutMs, capBytes: REQUIRES_CAP.capBytes });
    if (r.status === 0) continue;
    // `sh` reads a timeout as exit -1, as it does a spawn failure; only its error says which.
    const exit = /\bETIMEDOUT\b/.test(r.error ?? "") ? `exit -1: timed out after ${timeoutMs / 1000} s` : `exit ${r.status}`;
    return { ok: false, cause: "requires", error: `requires check failed for ${to} (${exit}): ${cmd}${r.output ? `\n${r.output}` : ""}`, cmd, status: r.status, output: r.output };
  }
  return { ok: true };
}

/** What `next` and `overrule` check before the lock (§4): the requires of the phase `label` leads to from `run`'s phase.
 *  Only a declared edge to a phase has any: `resume` re-enters a phase already admitted (§5.2), and `operator` is no
 *  phase. Null when no command ran; the hold then refuses any target that has requires. */
export function edgePreflight(ctx, run, { on, label }) {
  const edges = ctx.rider.phases[run.phase]?.edges;
  // Own keys only: a label like "toString" must not read through Object.prototype.
  const to = edges && typeof label === "string" && Object.hasOwn(edges, label) ? edges[label] : null;
  if (!to || !Object.hasOwn(ctx.rider.phases, to)) return null;
  return { on, label, from: run.phase, to, result: requiresFor(ctx, { run, to, from: run.phase, label }) };
}

/** What `start` checks before it takes the lock (§4), so a slow entry command never holds it. It reads no state: the
 *  verb's hold re-checks that no run is active. A refusal's `cause` names the entry command that refused; a usage
 *  error (an unknown phase, a phase `start` cannot enter) has none. */
export function startPreflight(ctx, { phase = null } = {}) {
  const target = phase ?? ctx.rider.start;
  const def = ctx.rider.phases[target];
  const refused = (error, cause = null) => ({ ok: false, error, cause, target });
  if (!def) return refused(`no phase "${target}" — phases: ${Object.keys(ctx.rider.phases).join(", ")}`);
  if (def.kind !== "session") return refused(`"${target}" is a human phase; start names a session phase`);
  // The run does not exist yet, so intake is told about the branch it is about to be recorded on.
  const baseBranch = ctx.branch();
  for (const cmd of ctx.rider.intake) {
    const r = sh(cmd, ctx.shellOpts({ phase: target, baseBranch }));
    if (r.status !== 0) return refused(`intake check failed (exit ${r.status}): ${cmd}${r.output ? `\n${r.output}` : ""}`, "intake");
  }
  // The run's door first, then the phase's: a fresh run leaves no phase and takes no label.
  const req = requiresFor(ctx, { run: { phase: target, baseBranch }, to: target });
  if (!req.ok) return refused(req.error, req.cause);
  return { ok: true, target, baseBranch };
}
