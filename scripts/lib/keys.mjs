// scripts/lib/keys.mjs — decision keys (§8): what a decision judged, and the line `check` prints to make one
import { currentSession, keyOf } from "./state.mjs";

/** `<runId>.<n>`: one stretch, n its 1-based place in `run.sessions`. Not `state.version`, which a note or a sighting moves too. */
export function parseStretchKey(s) {
  const m = typeof s === "string" ? /^([0-9a-f]{4})\.([1-9]\d*)$/.exec(s) : null;
  return m ? { runId: m[1], n: Number(m[2]) } : null;
}

/** `overrule` and `reset` act on a whole run, so their key names the run alone. */
export function parseRunKey(s) { return typeof s === "string" && /^[0-9a-f]{4}$/.test(s) ? s : null; }

/** The one key a stretch decision is accepted on: the current phase's latest stretch. A phase with no session (a human
 *  phase) has none, so nothing judged earlier can land on it. */
export function currentKey(run) {
  const sess = run && currentSession(run);
  return sess ? keyOf(run, sess) : null;
}

/** The instance as a refused decision finds it: what the decider missed, in the terms its key was written in. With no
 *  active run, `ended` is the last ended run's record, read in the same hold: `lastRun` keeps no transitions, and the move
 *  that ended the run (a reset, an operator stop, and by whom) is most often exactly what the decider missed. */
export function snapshot(state, rider, ended = null) {
  const run = state?.run;
  if (!run) return { runId: null, phase: null, key: null, outcome: null, lastTransition: ended?.transitions?.at(-1) ?? null, lastRun: state?.lastRun ?? null };
  const sess = currentSession(run);
  const human = rider.phases[run.phase]?.kind === "human";
  return { runId: run.runId, phase: run.phase, key: sess ? keyOf(run, sess) : null, outcome: sess?.outcome ?? (human ? "human" : null), lastTransition: run.transitions.at(-1) ?? null };
}

/** `<from> —<label>→ <to> by <by>: <because>`: the last move, which in a refusal is usually the other actor's. */
function transitionText(t) {
  return t ? `${t.from} —${t.label}→ ${t.to} by ${t.by}${t.because ? `: ${t.because}` : ""}` : "none";
}

/** Where the instance is now, on one line: the tail of a stale refusal's error, and the `now:` line it renders with. */
export function nowLine(snap) {
  if (!snap.runId) {
    const l = snap.lastRun;
    return l ? `no active run · last run ${l.runId} ended at ${l.endedBy} (phase ${l.phase})${l.reason ? `: ${l.reason}` : ""} · last: ${transitionText(snap.lastTransition)}` : "no run yet";
  }
  return `phase ${snap.phase} · run ${snap.runId} · latest ${snap.key ?? "none"} (${snap.outcome ?? "no session"}) · last: ${transitionText(snap.lastTransition)}`;
}

/** What a printed command needs to run as printed (decision 15): `--rider` when the project has several riders,
 *  `--instance` when the rider declares instances. Empty when the CLI needs neither. */
export function targetFlags({ rider, multiRider, instance, declared }) {
  return [multiRider ? `--rider ${rider}` : null, declared ? `--instance ${instance}` : null].filter(Boolean).join(" ");
}

/** The command `check` prints for the judge to copy (§8): a key assembled by hand is how a stale one gets typed. It
 *  names the rider and the instance whenever the CLI would need them, so it runs as printed. */
export function decideWithLine({ rider, multiRider, instance, declared, key, labels }) {
  const flags = targetFlags({ rider, multiRider, instance, declared });
  return `decide with:  rider next <label>${flags ? ` ${flags}` : ""} --on ${key} --because "…"     (labels: ${labels.join(" · ")})`;
}
