// scripts/lib/verbs.mjs
import { readFileSync } from "node:fs";
import { RUN, readouts } from "./check.mjs";
import { currentKey, nowLine, parseRunKey, parseStretchKey, snapshot, targetFlags } from "./keys.mjs";
import { legalLabels, onwardEdges, overrulable } from "./rider-md.mjs";
import { sh } from "./shell.mjs";
import { currentSession, keyOf, newRun, scopeOf, totalCost } from "./state.mjs";

export function refuse(error) { return { ok: false, error }; }

/** §8: a decision names what it judged, and that is checked inside the hold before anything else. A missing or malformed
 *  key is a usage error and leaves no trace. A stale one is refused with the state it missed and recorded as `refused`,
 *  naming who sent it (`by`), except under --dry-run, which runs nothing. Null when the key is the instance's current one. */
function keyRefusal(ctx, verb, on, { dryRun = false, by } = {}) {
  const stretch = verb === "next" || verb === "resume";
  const k = stretch ? parseStretchKey(on) : parseRunKey(on);
  if (!k) {
    const shape = stretch ? "<runId>.<n> (e.g. 3f2a.4), the stretch it judged — copy rider check's decide-with line" : "<runId> (e.g. 3f2a), the run it acts on — rider status names it";
    return refuse(on == null ? `${verb} needs --on ${shape}` : `--on "${on}" is not ${shape}`);
  }
  const state = ctx.readState();
  // Read in this hold, so it is the record `state.lastRun` names; only a refusal with no active run needs it.
  const ended = state.run ? null : ctx.lastEndedRun();
  const reason = stretch ? staleStretch(ctx, state.run, ended, on, k) : verb === "overrule" ? staleEnded(state, on) : staleActive(state.run, on);
  if (!reason) return null;
  const current = snapshot(state, ctx.rider, ended);
  const error = `${reason}; now ${nowLine(current)}`;
  // On the timeline of the run it judged, at the phase the instance had reached.
  if (!dryRun) ctx.event("refused", { runId: stretch ? k.runId : k, phase: current.phase, key: on, text: error, by });
  return { ok: false, stale: true, error, current };
}

/** Why a stretch key is not the current one, in the words the verb used before keys, where one applied. With no active
 *  run it does not send the decider to `rider start`: someone ended the run it judged, and the refusal says who and why. */
function staleStretch(ctx, run, ended, on, k) {
  const latest = currentKey(run);
  if (run && latest === on) return null;
  const named = [run, ended].find((x) => x?.runId === k.runId);
  const phase = named?.sessions[k.n - 1]?.phase;
  const of = named ?? run ?? ended;
  const judged = phase ? `${on} judged phase ${phase}` : `${on} is no stretch of ${of ? `run ${of.runId}` : "any run here"}`;
  if (!run) return `${judged}, but no run is active`;
  return ctx.rider.phases[run.phase]?.kind === "human" ? `${judged}, but ${run.phase} is a human phase — rider check runs its check command` : `${judged}, but the latest stretch of ${run.phase} is ${latest ?? "none"}`;
}

function staleEnded(state, on) {
  if (state.run) return `run ${state.run.runId} is active at phase ${state.run.phase} — overrule revives a run that stopped at operator`;
  if (!state.lastRun) return "no ended run — nothing to overrule";
  return state.lastRun.runId === on ? null : `${on} is not the last ended run`;
}

function staleActive(run, on) {
  if (!run) return "no active run — nothing to reset";
  return run.runId === on ? null : `${on} is not the active run`;
}

const labelList = (ctx, phase) => legalLabels(ctx.rider, phase).map((l) => l.label).join(" · ");
const sessionName = (run, instance, phase) => `rider ${run.rider}/${instance}/${run.runId} ${phase}`;
/** What the commands a result prints need in order to run as printed: the same flags as `decide with` (decision 15). */
const flagsOf = (ctx) => targetFlags({ rider: ctx.rider.name, multiRider: ctx.riderCount > 1, instance: ctx.instance.id, declared: !!ctx.instance.declared });

/** §12: a phase prompt is shared by every instance and sent verbatim, so which instance a run serves reaches the
 *  session as a line of appended system text. A rider without `instances` has one instance and nothing to tell. */
export function instanceFacts(ctx) {
  if (!ctx.instance.declared) return [];
  return [`This run serves instance \`${ctx.instance.id}\` of the rider \`${ctx.rider.name}\`. The instance's directory is \`${scopeOf(ctx.instance)}\`, relative to the project root.`];
}

/** A fresh run: intake (the one mechanical refusal before spend, §4.3), the run record, the start phase. */
export function start(ctx, { phase = null, dryRun = false } = {}) {
  return readouts(ctx, ctx.update(() => {
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
    const run = newRun({ rider: ctx.rider.name, phase: target, baseBranch, now: ctx.now(), taken: ctx.runIdsInUse(), roll: ctx.rollRunId });
    if (!dryRun) ctx.event("run-started", { runId: run.runId, phase: target });
    return enterPhase(ctx, run, target, { dryRun });
  }));
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
    return { ok: true, state: "operator", runId: run.runId, reason: because, targetFlags: flagsOf(ctx), totalCost: totalCost(run) };
  }
  if (def.kind === "human") {
    if (dryRun) return { ok: true, state: "dry-run", phase, human: true, check: def.check };
    // What the sessions handed over: the commits that land past this tip are the human phase's own, and
    // `check` records them when the phase's check passes (the gate-precision record). A run recorded before
    // `workTip` existed (or revived by `overrule`) has a branch and no tip: read it now. A run with no work
    // branch (on the base, or any instance rider's, §11.1) hands over HEAD; that is not a work tip.
    if (!run.workTip && run.workBranch) { const tip = ctx.tip(`refs/heads/${run.workBranch}`); if (tip) run.workTip = tip; }
    run.handoff = { phase, at, tip: run.workTip ?? ctx.tip("HEAD") };
    ctx.saveRun(run);
    ctx.event("phase-entered", { runId: run.runId, phase, text: `visit ${run.visits[phase]} · human: ${def.check}` });
    // No `checkExit`: the check has not run yet, and `rider check` is what runs it. `show` runs after the lock (`readouts`).
    return { ok: true, state: "human", rider: run.rider, instance: ctx.instance.id, runId: run.runId, phase, check: def.check, show: null, notes: run.notes, totalCost: totalCost(run), [RUN]: run };
  }
  const prompt = readFileSync(def.prompt, "utf8");
  const model = ctx.local.models?.[phase] ?? def.model;
  const name = sessionName(run, ctx.instance.id, phase);
  const facts = instanceFacts(ctx);
  if (dryRun) return { ok: true, state: "dry-run", phase, model, name, argv: ctx.binding.dryRun.launchArgv(prompt, { model, name, facts }) };
  let ids;
  try {
    ids = ctx.binding.launch(prompt, { model, name, cwd: ctx.root, facts });
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
  ctx.event("phase-entered", { runId: run.runId, phase, key: keyOf(run, sess), text: `visit ${run.visits[phase]} · ${model} · session ${ids.shortId ?? ids.sessionId}` });
  return { ok: true, state: "running", runId: run.runId, phase, visit: run.visits[phase], model, session: ids, attach: ctx.binding.attachHint(ids) };
}

/** The judge's decision: a label from the current phase's edges (§4.3), or the two reserved ones. */
export function next(ctx, label, { on, because = null, by = "judge", dryRun = false } = {}) {
  return readouts(ctx, ctx.update(() => {
    const refused = keyRefusal(ctx, "next", on, { dryRun, by });
    if (refused) return refused;
    // The key matched, so the run is active and its phase has a session: a human phase has no key to match.
    const run = ctx.loadRun();
    if (!label) return refuse(`next needs a label — legal: ${labelList(ctx, run.phase)}`);
    const sess = currentSession(run);
    if (sess.outcome === "running" || sess.outcome === "waiting") return refuse(`${run.phase} is still ${sess.outcome} — rider check first`);
    if (label === "resume") return resume(ctx, { on, because, by, dryRun });
    // Only the declared labels: a label like "toString" must not read through Object.prototype on the phase's edges.
    const to = legalLabels(ctx.rider, run.phase).find((l) => l.label === label)?.to ?? null;
    if (!to) return refuse(`"${label}" is not an edge of ${run.phase} — legal: ${labelList(ctx, run.phase)}`);
    if (dryRun) return to === "operator" ? { ok: true, state: "dry-run", to: "operator" } : enterPhase(ctx, run, to, { dryRun: true });
    run.transitions.push({ at: ctx.now().toISOString(), from: run.phase, label, to, because, by });
    ctx.event("decided", { runId: run.runId, phase: run.phase, key: keyOf(run, sess), text: `${label} → ${to}${because ? `: ${because}` : ""}` });
    if (to === "operator") {
      const reason = because ?? `${label} from ${run.phase}`;
      ctx.endRun(run, { endedBy: "operator", reason });
      return { ok: true, state: "operator", runId: run.runId, reason, overrulable: overrulable(ctx.rider, run), targetFlags: flagsOf(ctx), totalCost: totalCost(run) };
    }
    return enterPhase(ctx, run, to, { dryRun });
  }));
}

/** The operator's ruling on a stop the judge routed to `operator`: revive that run and take a declared
 *  edge of the phase it stopped at. Without it an `operator` stop is a dead end — `next` needs an active
 *  run, and `start` cannot enter a human phase — so a ruling of "the phase's outcome stands" had no verb
 *  to carry it. The judge's stop stays in `transitions` and the ruling lands beside it as
 *  `by: "operator"`: the pair is one judge call and its review, which is what the record is read for. */
export function overrule(ctx, label, { on, because, dryRun = false } = {}) {
  return readouts(ctx, ctx.update(() => {
    const refused = keyRefusal(ctx, "overrule", on, { dryRun, by: "operator" });
    if (refused) return refused;
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
    // The ruling first, then the revival that writes it: no state.json ever holds this run without it.
    run.transitions.push({ at: ctx.now().toISOString(), from: run.phase, label, to, because: because.trim(), by: "operator" });
    ctx.reviveRun(run);
    const stopped = currentSession(run);
    ctx.event("overruled", { runId: run.runId, phase: run.phase, key: stopped ? keyOf(run, stopped) : null, text: `${label} → ${to}: ${because.trim()}` });
    return enterPhase(ctx, run, to);
  }));
}

/** The reflexive edge: re-enter the current session with the nudge (§2.2 `resume`). A transition like any other (§6.1),
 *  so a competing resume shows as the latest decision. `reason` is the session's resumeReason: the watcher's is `rate-limit`. */
export function resume(ctx, { on, because = null, by = "judge", reason = null, dryRun = false } = {}) {
  return ctx.update(() => {
    const refused = keyRefusal(ctx, "resume", on, { dryRun, by });
    if (refused) return refused;
    const run = ctx.loadRun();
    const def = ctx.rider.phases[run.phase];
    const prev = currentSession(run);
    if (!prev.id) return refuse(`no session to resume for ${run.phase}`);
    if (prev.outcome === "running" || prev.outcome === "waiting") return refuse(`session ${prev.shortId} is ${prev.outcome} — rider check first`);
    const ids = { shortId: prev.shortId, sessionId: prev.id };
    const listed = ctx.binding.status(ids).listed;
    const baselineTurns = ctx.binding.read(ids).turns;
    const model = ctx.local.models?.[run.phase] ?? def.model;
    const name = sessionName(run, ctx.instance.id, run.phase);
    // Passed listed or not: the binding knows which resume can carry them, and a listed one drops them (§12).
    const facts = instanceFacts(ctx);
    if (dryRun) return { ok: true, state: "dry-run", phase: run.phase, model, name, argv: ctx.binding.dryRun.resumeArgv(prev.id, { listed, model, name, facts }) };
    let got;
    try {
      got = ctx.binding.resume(prev.id, { listed, model, name, cwd: ctx.root, facts });
    } catch (e) {
      return refuse(`resume failed: ${e.message}`);
    }
    const why = reason ?? because ?? "judge";
    const sess = { phase: run.phase, model, id: got.sessionId ?? prev.id, shortId: got.shortId, resumedFrom: prev.id, resumeReason: why, at: ctx.now().toISOString(), outcome: "running", baselineTurns, watcherSpawns: 0 };
    run.sessions.push(sess);
    run.transitions.push({ at: sess.at, from: run.phase, label: "resume", to: run.phase, because, by });
    ctx.saveRun(run);
    if (ctx.ensureWatcher()) { sess.watcherSpawns++; ctx.saveRun(run); }
    ctx.event("resumed", { runId: run.runId, phase: run.phase, key: keyOf(run, prev), text: `${why} · session ${sess.shortId ?? sess.id}` });
    const nids = { shortId: sess.shortId, sessionId: sess.id };
    return { ok: true, state: "running", runId: run.runId, phase: run.phase, resumed: prev.id, reason: why, session: nids, attach: ctx.binding.attachHint(nids) };
  });
}

/** The run at a glance — the judge re-orients from this, never from chat memory (§3.1). A read, so it takes no lock. */
export function status(ctx) {
  const { run, lastRun } = ctx.readState();
  const watcher = ctx.watcherAlive();
  const lastEvent = ctx.readEvents().at(-1) ?? null;
  const where = { instance: ctx.instance.id, scope: ctx.instance.scope, targetFlags: flagsOf(ctx) };
  if (!run) return { ok: true, state: "none", rider: ctx.rider.name, ...where, watcher, lastEvent, lastRun };
  const def = ctx.rider.phases[run.phase];
  const sess = currentSession(run);
  const state = def.kind === "human" ? "human" : !sess ? "none" : sess.outcome === "running" ? "running" : sess.outcome === "waiting" ? "waiting" : "finished";
  return {
    ok: true, state, rider: run.rider, ...where, runId: run.runId, key: currentKey(run), phase: run.phase, visits: run.visits, baseBranch: run.baseBranch ?? null, workBranch: run.workBranch ?? null, workTip: run.workTip ?? null, branchDrift: run.branchDrift ?? null, startedAt: run.startedAt, watcher, lastEvent,
    totalCost: totalCost(run),
    sessions: run.sessions.map((s) => ({ key: keyOf(run, s), phase: s.phase, model: s.model, shortId: s.shortId, id: s.id, outcome: s.outcome, cost: s.cost ?? null, turns: s.turns ?? null, at: s.at, resumedFrom: s.resumedFrom ?? null })),
    transitions: run.transitions, notes: run.notes,
    attach: sess?.shortId ? ctx.binding.attachHint({ shortId: sess.shortId, sessionId: sess.id }) : null,
    lastRun,
  };
}

/** A note lands on the active run, or on the last ended one: what the operator found at the gate is
 *  usually said after the merge, and the merge is what ended the run. */
export function note(ctx, text) {
  return ctx.update(() => {
    if (!text?.trim()) return refuse("note needs text");
    const active = ctx.loadRun();
    const run = active ?? ctx.lastEndedRun();
    if (!run) return refuse("no run, active or ended — nothing to note on");
    (run.notes ??= []).push({ at: ctx.now().toISOString(), text: text.trim(), ...(active ? {} : { afterEnd: true }) });
    if (active) ctx.saveRun(run);
    else ctx.saveEndedRun(run);
    ctx.event("noted", { runId: run.runId, phase: run.phase, text: text.trim() });
    return { ok: true, state: "noted", runId: run.runId, notes: run.notes.length, ended: !active };
  });
}

/** Forget the active run (its record is kept under runs/); the project's own state is the truth. */
export function reset(ctx, { on, because = null, by = "judge" } = {}) {
  return ctx.update(() => {
    const refused = keyRefusal(ctx, "reset", on, { by });
    if (refused) return refused;
    const run = ctx.loadRun();
    ctx.killWatcher();
    // Forgetting a live phase leaves a paid session running with nothing tracking it: name it, and say
    // how to stop it. The harness-shaped stop line comes from the binding (§5), never from here.
    const sess = currentSession(run);
    const live = sess && (sess.outcome === "running" || sess.outcome === "waiting");
    const paid = live ? ` — session ${sess.shortId ?? sess.id} is still ${sess.outcome} and still paying: ${ctx.binding.stopHint({ shortId: sess.shortId, sessionId: sess.id })}` : "";
    const why = because ?? "rider reset";
    run.transitions.push({ at: ctx.now().toISOString(), from: run.phase, label: "reset", to: "reset", because: why, by });
    const reason = `${why}${paid}`;
    ctx.event("reset", { runId: run.runId, phase: run.phase, key: sess ? keyOf(run, sess) : null, text: reason });
    ctx.endRun(run, { endedBy: "reset", reason });
    return { ok: true, state: "none", message: `run ${run.runId} forgotten; its record is under runs/${paid}` };
  });
}
