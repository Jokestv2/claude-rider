// scripts/lib/verbs.mjs
import { readFileSync } from "node:fs";
import { legalLabels, onwardEdges, overrulable } from "./rider-md.mjs";
import { sh } from "./shell.mjs";
import { baseOf, currentSession, newRun, totalCost } from "./state.mjs";

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
  // The run does not exist yet, so intake is told about the branch it is about to be recorded on.
  const baseBranch = ctx.branch();
  for (const cmd of ctx.rider.intake) {
    const r = sh(cmd, ctx.shellOpts({ phase: target, baseBranch }));
    if (r.status !== 0) return refuse(`intake check failed (exit ${r.status}): ${cmd}${r.output ? `\n${r.output}` : ""}`);
  }
  const run = newRun({ rider: ctx.rider.name, phase: target, branch: baseBranch, now: ctx.now() });
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
    // `by: "executor"`: nobody judged this stop, so there is no call for `overrule` to overrule.
    run.transitions.push({ at, from: phase, label: "operator", to: "operator", because, by: "executor" });
    if (!dryRun) ctx.endRun(run, { endedBy: "operator", reason: because });
    return { ok: true, state: "operator", runId: run.runId, reason: because, totalCost: totalCost(run) };
  }
  if (def.kind === "human") {
    if (dryRun) return { ok: true, state: "dry-run", phase, human: true, check: def.check };
    // What the sessions handed over: the commits the work branch gains past this tip are the human
    // phase's own, and `check` records them when the phase's check passes (the gate-precision record).
    // A run recorded before `workTip` existed (or revived by `overrule`) has a branch and no tip: read it now.
    if (!run.workTip && run.workBranch) { const tip = ctx.tip(`refs/heads/${run.workBranch}`); if (tip) run.workTip = tip; }
    run.handoff = { phase, at, tip: run.workTip ?? null };
    ctx.saveRun(run);
    const show = def.show ? sh(def.show, ctx.shellOpts(run)).output : null;
    // No `checkExit`: the check has not run yet, and `rider check` is what runs it.
    return { ok: true, state: "human", rider: run.rider, runId: run.runId, phase, check: def.check, show, notes: run.notes, totalCost: totalCost(run) };
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
    run.transitions.push({ at, from: phase, label: "operator", to: "operator", because, by: "executor" });
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
  // Only the declared labels: a label like "toString" must not read through Object.prototype on def.edges.
  const to = legalLabels(ctx.rider, run.phase).find((l) => l.label === label)?.to ?? null;
  if (!to) return refuse(`"${label}" is not an edge of ${run.phase} — legal: ${labelList(ctx, run.phase)}`);
  if (dryRun) return to === "operator" ? { ok: true, state: "dry-run", to: "operator" } : enterPhase(ctx, run, to, { dryRun: true });
  run.transitions.push({ at: ctx.now().toISOString(), from: run.phase, label, to, because });
  if (to === "operator") {
    const reason = because ?? `${label} from ${run.phase}`;
    ctx.endRun(run, { endedBy: "operator", reason });
    return { ok: true, state: "operator", runId: run.runId, reason, overrule: overrulable(ctx.rider, run), totalCost: totalCost(run) };
  }
  return enterPhase(ctx, run, to, { dryRun });
}

/** The operator's ruling on a stop the judge routed to `operator`: revive that run and take a declared
 *  edge of the phase it stopped at. Without it an `operator` stop is a dead end — `next` needs an active
 *  run, and `start` cannot enter a human phase — so a ruling of "the phase's outcome stands" had no verb
 *  to carry it. The judge's stop stays in `transitions` and the ruling lands beside it as
 *  `by: "operator"`: the pair is one judge call and its review, which is what the record is read for. */
export function overrule(ctx, label, { because = null, dryRun = false } = {}) {
  const active = ctx.loadRun();
  if (active) return refuse(`run ${active.runId} is active at phase ${active.phase} — overrule revives a run that stopped at operator`);
  const run = ctx.lastEndedRun();
  if (!run) return refuse("no ended run — nothing to overrule");
  const stop = run.transitions.at(-1);
  if (run.endedBy !== "operator" || stop?.to !== "operator") return refuse(`the last run (${run.runId}) ended by ${run.endedBy}, not at operator — nothing to overrule`);
  if (stop.by === "executor") return refuse(`run ${run.runId} was stopped by the executor, not by a judge's call (${stop.because}) — nothing to overrule; rider start [phase]`);
  const onward = onwardEdges(ctx.rider, run.phase);
  const legal = onward.map((l) => l.label).join(" · ") || "none";
  if (!label) return refuse(`overrule needs a label — edges of ${run.phase}: ${legal}`);
  const to = onward.find((l) => l.label === label)?.to ?? null;
  if (!to) return refuse(`"${label}" is not an edge of ${run.phase} that leaves for another phase — legal: ${legal}`);
  if (!because?.trim()) return refuse("overrule needs --because: the operator's ruling, in their words, is the record");
  if (dryRun) return enterPhase(ctx, run, to, { dryRun: true });
  // The ruling first, then the revival that writes it: no run.json ever exists for this run without it.
  run.transitions.push({ at: ctx.now().toISOString(), from: run.phase, label, to, because: because.trim(), by: "operator" });
  ctx.reviveRun(run);
  return enterPhase(ctx, run, to);
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
    return { ok: true, state: "none", rider: ctx.rider.name, watcher, lastEvent, lastRun: last && { runId: last.runId, phase: last.phase, endedBy: last.endedBy, reason: last.reason, endedAt: last.endedAt, overrule: overrulable(ctx.rider, last), totalCost: totalCost(last) } };
  }
  const def = ctx.rider.phases[run.phase];
  const sess = currentSession(run);
  const state = def.kind === "human" ? "human" : !sess ? "none" : sess.outcome === "running" ? "running" : sess.outcome === "waiting" ? "waiting" : "finished";
  return {
    ok: true, state, rider: run.rider, runId: run.runId, phase: run.phase, visits: run.visits, branch: run.branch, baseBranch: baseOf(run), workBranch: run.workBranch ?? null, workTip: run.workTip ?? null, startedAt: run.startedAt, watcher, lastEvent,
    totalCost: totalCost(run),
    sessions: run.sessions.map((s) => ({ phase: s.phase, model: s.model, shortId: s.shortId, id: s.id, outcome: s.outcome, cost: s.cost ?? null, turns: s.turns ?? null, at: s.at, resumedFrom: s.resumedFrom ?? null })),
    transitions: run.transitions, notes: run.notes,
    attach: sess?.shortId ? ctx.binding.attachHint({ shortId: sess.shortId, sessionId: sess.id }) : null,
  };
}

/** A note lands on the active run, or on the last ended one: what the operator found at the gate is
 *  usually said after the merge, and the merge is what ended the run. */
export function note(ctx, text) {
  if (!text?.trim()) return refuse("note needs text");
  const active = ctx.loadRun();
  const run = active ?? ctx.lastEndedRun();
  if (!run) return refuse("no run, active or ended — nothing to note on");
  (run.notes ??= []).push({ at: ctx.now().toISOString(), text: text.trim(), ...(active ? {} : { afterEnd: true }) });
  if (active) ctx.saveRun(run);
  else ctx.saveEndedRun(run);
  return { ok: true, state: "noted", runId: run.runId, notes: run.notes.length, ended: !active };
}

/** Forget the active run (its record is kept under runs/); the project's own state is the truth. */
export function reset(ctx) {
  const run = ctx.loadRun();
  ctx.killWatcher();
  if (!run) return { ok: true, state: "none", message: "no active run; nothing to reset" };
  // Forgetting a live phase leaves a paid session running with nothing tracking it: name it, and say
  // how to stop it. The harness-shaped stop line comes from the binding (§5), never from here.
  const sess = currentSession(run);
  const live = sess && (sess.outcome === "running" || sess.outcome === "waiting");
  const paid = live ? ` — session ${sess.shortId ?? sess.id} is still ${sess.outcome} and still paying: ${ctx.binding.stopHint({ shortId: sess.shortId, sessionId: sess.id })}` : "";
  ctx.endRun(run, { endedBy: "reset", reason: `rider reset${paid}` });
  return { ok: true, state: "none", message: `run ${run.runId} forgotten; its record is under runs/${paid}` };
}
