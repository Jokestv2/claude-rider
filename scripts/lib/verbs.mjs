// scripts/lib/verbs.mjs
import { readFileSync } from "node:fs";
import { legalLabels } from "./rider-md.mjs";
import { sh } from "./shell.mjs";
import { currentSession, newRun, totalCost } from "./state.mjs";

export function refuse(error) { return { ok: false, error }; }

const labelList = (ctx, phase) => legalLabels(ctx.rider, phase).map((l) => l.label).join(" · ");
const sessionName = (run, phase) => `rider ${run.rider}/${run.runId} ${phase}`;

/** A fresh run: intake (the one mechanical refusal before spend, §4.3), run.json, the start phase. */
export function start(ctx, { phase = null, dryRun = false } = {}) {
  const active = ctx.loadRun();
  if (active) return refuse(`run ${active.runId} is active at phase ${active.phase} — rider check, next, or reset first`);
  const target = phase ?? ctx.rider.start;
  const def = ctx.rider.phases[target];
  if (!def) return refuse(`no phase "${target}" — phases: ${Object.keys(ctx.rider.phases).join(", ")}`);
  if (def.kind !== "session") return refuse(`"${target}" is a human phase; start names a session phase`);
  for (const cmd of ctx.rider.intake) {
    const r = sh(cmd, ctx.shellOpts());
    if (r.status !== 0) return refuse(`intake check failed (exit ${r.status}): ${cmd}${r.output ? `\n${r.output}` : ""}`);
  }
  const run = newRun({ rider: ctx.rider.name, phase: target, branch: ctx.branch(), now: ctx.now() });
  return enterPhase(ctx, run, target, { dryRun });
}

/** Enter `phase` on `run`: count the visit, stop at a human phase, or launch a session. */
export function enterPhase(ctx, run, phase, { dryRun = false } = {}) {
  const def = ctx.rider.phases[phase];
  const at = ctx.now().toISOString();
  run.phase = phase;
  run.visits[phase] = (run.visits[phase] ?? 0) + 1;
  if (run.visits[phase] > ctx.rider.limits.visits) {
    const because = `visit cap: ${phase} entered ${run.visits[phase]} times (limits.visits is ${ctx.rider.limits.visits})`;
    run.transitions.push({ at, from: phase, label: "operator", to: "operator", because });
    if (!dryRun) ctx.endRun(run, { endedBy: "operator", reason: because });
    return { ok: true, state: "operator", runId: run.runId, reason: because, totalCost: totalCost(run) };
  }
  if (def.kind === "human") {
    if (dryRun) return { ok: true, state: "dry-run", phase, human: true, check: def.check };
    ctx.saveRun(run);
    const show = def.show ? sh(def.show, ctx.shellOpts()).output : null;
    return { ok: true, state: "human", runId: run.runId, phase, check: def.check, show, totalCost: totalCost(run) };
  }
  const prompt = readFileSync(def.prompt, "utf8");
  const model = ctx.local.models?.[phase] ?? def.model;
  const name = sessionName(run, phase);
  if (dryRun) return { ok: true, state: "dry-run", phase, model, name, argv: ctx.binding.dryRun.launchArgv(prompt, { model, name }) };
  let ids;
  try {
    ids = ctx.binding.launch(prompt, { model, name, cwd: ctx.root });
  } catch (e) {
    const because = `launch failed: ${e.message}`;
    run.transitions.push({ at, from: phase, label: "operator", to: "operator", because });
    ctx.endRun(run, { endedBy: "operator", reason: because });
    return refuse(because);
  }
  const sess = { phase, model, id: ids.sessionId, shortId: ids.shortId, resumedFrom: null, resumeReason: null, at, outcome: "running", baselineTurns: 0, watcherSpawns: 0 };
  run.sessions.push(sess);
  ctx.saveRun(run);
  if (ctx.ensureWatcher()) { sess.watcherSpawns++; ctx.saveRun(run); }
  return { ok: true, state: "running", runId: run.runId, phase, visit: run.visits[phase], model, session: ids, attach: ctx.binding.attachHint(ids) };
}
