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

/** The judge's decision: a label from the current phase's edges (§4.3), or the two reserved ones. */
export function next(ctx, label, { because = null, dryRun = false } = {}) {
  const run = ctx.loadRun();
  if (!run) return refuse("no active run — rider start");
  const def = ctx.rider.phases[run.phase];
  if (def.kind === "human") return refuse(`${run.phase} is a human phase — rider check runs its check command`);
  if (!label) return refuse(`next needs a label — legal: ${labelList(ctx, run.phase)}`);
  const sess = currentSession(run);
  if (!sess || sess.outcome === "running" || sess.outcome === "waiting") return refuse(`${run.phase} is still ${sess?.outcome ?? "unlaunched"} — rider check first`);
  if (label === "resume") return resume(ctx, { reason: because ?? "judge", dryRun });
  const to = label === "operator" ? "operator" : def.edges[label];
  if (!to) return refuse(`"${label}" is not an edge of ${run.phase} — legal: ${labelList(ctx, run.phase)}`);
  if (dryRun) return to === "operator" ? { ok: true, state: "dry-run", to: "operator" } : enterPhase(ctx, run, to, { dryRun: true });
  run.transitions.push({ at: ctx.now().toISOString(), from: run.phase, label, to, because });
  if (to === "operator") {
    const reason = because ?? `${label} from ${run.phase}`;
    ctx.endRun(run, { endedBy: "operator", reason });
    return { ok: true, state: "operator", runId: run.runId, reason, totalCost: totalCost(run) };
  }
  return enterPhase(ctx, run, to, { dryRun });
}

/** The reflexive edge: re-enter the current session with the nudge (§2.2 `resume`). */
export function resume(ctx, { reason = "judge", dryRun = false } = {}) {
  const run = ctx.loadRun();
  if (!run) return refuse("no active run — rider start");
  const def = ctx.rider.phases[run.phase];
  if (def.kind !== "session") return refuse(`${run.phase} is a human phase; nothing to resume`);
  const prev = currentSession(run);
  if (!prev?.id) return refuse(`no session to resume for ${run.phase}`);
  if (prev.outcome === "running" || prev.outcome === "waiting") return refuse(`session ${prev.shortId} is ${prev.outcome} — rider check first`);
  const ids = { shortId: prev.shortId, sessionId: prev.id };
  const listed = ctx.binding.status(ids).listed;
  const baselineTurns = ctx.binding.read(ids).turns;
  const model = ctx.local.models?.[run.phase] ?? def.model;
  const name = sessionName(run, run.phase);
  if (dryRun) return { ok: true, state: "dry-run", phase: run.phase, model, name, argv: ctx.binding.dryRun.resumeArgv(prev.id, { listed, model, name }) };
  let got;
  try {
    got = ctx.binding.resume(prev.id, { listed, model, name, cwd: ctx.root });
  } catch (e) {
    return refuse(`resume failed: ${e.message}`);
  }
  const sess = { phase: run.phase, model, id: got.sessionId ?? prev.id, shortId: got.shortId, resumedFrom: prev.id, resumeReason: reason, at: ctx.now().toISOString(), outcome: "running", baselineTurns, watcherSpawns: 0 };
  run.sessions.push(sess);
  ctx.saveRun(run);
  if (ctx.ensureWatcher()) { sess.watcherSpawns++; ctx.saveRun(run); }
  const nids = { shortId: sess.shortId, sessionId: sess.id };
  return { ok: true, state: "running", runId: run.runId, phase: run.phase, resumed: prev.id, reason, session: nids, attach: ctx.binding.attachHint(nids) };
}

/** The run at a glance — the judge re-orients from this, never from chat memory (§3.1). */
export function status(ctx) {
  const run = ctx.loadRun();
  const watcher = ctx.watcherAlive();
  const lastEvent = ctx.readEvents().at(-1) ?? null;
  if (!run) {
    const last = ctx.lastEndedRun();
    return { ok: true, state: "none", rider: ctx.rider.name, watcher, lastEvent, lastRun: last && { runId: last.runId, phase: last.phase, endedBy: last.endedBy, reason: last.reason, endedAt: last.endedAt, totalCost: totalCost(last) } };
  }
  const def = ctx.rider.phases[run.phase];
  const sess = currentSession(run);
  const state = def.kind === "human" ? "human" : !sess ? "none" : sess.outcome === "running" ? "running" : sess.outcome === "waiting" ? "waiting" : "finished";
  return {
    ok: true, state, rider: run.rider, runId: run.runId, phase: run.phase, visits: run.visits, branch: run.branch, startedAt: run.startedAt, watcher, lastEvent,
    totalCost: totalCost(run),
    sessions: run.sessions.map((s) => ({ phase: s.phase, model: s.model, shortId: s.shortId, id: s.id, outcome: s.outcome, cost: s.cost ?? null, turns: s.turns ?? null, at: s.at, resumedFrom: s.resumedFrom ?? null })),
    transitions: run.transitions, notes: run.notes,
    attach: sess?.shortId ? ctx.binding.attachHint({ shortId: sess.shortId, sessionId: sess.id }) : null,
  };
}

export function note(ctx, text) {
  const run = ctx.loadRun();
  if (!run) return refuse("no active run — nothing to note on");
  if (!text?.trim()) return refuse("note needs text");
  run.notes.push({ at: ctx.now().toISOString(), text: text.trim() });
  ctx.saveRun(run);
  return { ok: true, state: "noted", runId: run.runId, notes: run.notes.length };
}

/** Forget the active run (its record is kept under runs/); the project's own state is the truth. */
export function reset(ctx) {
  const run = ctx.loadRun();
  ctx.killWatcher();
  if (!run) return { ok: true, state: "none", message: "no active run; nothing to reset" };
  ctx.endRun(run, { endedBy: "reset", reason: "rider reset" });
  return { ok: true, state: "none", message: `run ${run.runId} forgotten; its record is under runs/` };
}
