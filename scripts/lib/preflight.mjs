// scripts/lib/preflight.mjs
import { sh } from "./shell.mjs";

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
  return { ok: true, target, baseBranch };
}
