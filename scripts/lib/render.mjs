// scripts/lib/render.mjs
import { nowLine } from "./keys.mjs";
import { fmtCost, fmtDuration, formatFinal, formatQuestion } from "./markers.mjs";
import { REQUIRES_CAP } from "./preflight.mjs";

const RULE = (title) => `── ${title} ${"─".repeat(Math.max(4, 60 - title.length))}`;
/** Who a status or check block is about, in the one form event lines and session names use: rider/instance/runId. */
const whose = (r) => `rider ${r.rider}/${r.instance ?? "?"}${r.runId ? `/${r.runId}` : ""}`;
/** Branch drift (§11.1), as status and check print it. The tree is every instance's, so it is relayed, never fixed here. */
const driftLine = (r) => `drift: the shared working tree left ${r.baseBranch ?? "?"} for ${r.branchDrift.branch} (first seen ${r.branchDrift.at}) — the executor does not switch back`;
const labelText = (l) => (l.label === "resume" || l.label === "operator" ? l.label : `${l.label} → ${l.to}`);
/** One edge's preconditions as `check` found them (§5.3). A timeout names itself, since its exit and its empty output
 *  would hide the cause; a failure that printed nothing leaves no dangling colon. */
function requiresEntry(e) {
  if (e.ok) return `${e.label} → ${e.to} ✓`;
  const why = e.timedOut ? `(exit -1: timed out after ${REQUIRES_CAP.timeoutMs / 1000} s)` : `(exit ${e.status})${e.firstLine ? `: ${e.firstLine}` : ""}`;
  return `${e.label} → ${e.to} ✗ ${e.cmd} ${why}`;
}
/** Printed right above `decide with:`, so the judge reads which labels `next` would refuse before it copies one. */
const requiresLine = (entries) => `── requires ── ${entries.map(requiresEntry).join(" · ")}`;

/** What a dry run would do (§6.2): the launch argv, or at a gate or a wait the check it would wait on. */
function dryRunLine(r) {
  if (r.argv) return `[dry-run] ${r.phase} (${r.model}): ${r.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a.length > 60 ? `${a.slice(0, 57)}…` : a) : a)).join(" ")}`;
  return r.human || r.await ? `[dry-run] ${r.phase} (${r.human ? "human" : "await"}): ${r.check}` : `[dry-run] ${r.phase ?? r.to}`;
}
/** Entering a wait launches nothing (§7.5): the entry names the check the watcher polls, and the stretch it decides. */
const awaitingLines = (r) => `${r.phase} awaiting: $ ${r.check} every ${r.pollSeconds} s${r.deadline ? ` until ${r.deadline}` : ""}\nvisit ${r.visit ?? "?"} of run ${r.runId} · stretch ${r.key}`;
/** A wait's last poll as status prints it: before the first, there is no exit to name. */
const waitLine = (w) => [`wait: $ ${w.check}`, `${w.polls} polls`, w.lastPollAt ? `last exit ${w.lastExit} at ${w.lastPollAt}` : "no poll yet", w.deadline ? `deadline ${w.deadline}` : null].filter(Boolean).join(" · ");
/** An awaiting wait at the failure threshold (`failingOf`), as status and the await block both say it. */
const failingLine = (w) => `check failing: ${w.failures} in a row since ${w.failingSince}`;
/** A command's output under its header, two spaces in, as the blocks print every read. */
const indented = (text) => (text ? String(text).split("\n").map((l) => `  ${l}`) : []);
/** The evidence section, as a session's block and a decided wait's both print it: empty when the rider declares none. */
const evidenceLines = (evidence) => (evidence?.length ? [RULE("evidence"), ...evidence.flatMap((e) => [`  $ ${e.cmd}${e.status !== 0 ? `   (exit ${e.status})` : ""}`, ...(e.output || "").split("\n").filter(Boolean).map((l) => `  ${l}`)])] : []);
/** `start`'s own lines (§6.2): above its result, the `locate` the operator's word overrode. A check result's `note` is
 *  the classification's, and its block prints it in place. */
const startNote = (verb, r, text) => (verb === "start" && r.note ? `note: ${r.note}\n${text}` : text);

/** One event, one line: `<at> <kind> <rider>/<instance>/<runId> <phase> <key> <text>`, with absent fields left out. */
export function eventLine(e) {
  return [e.at, e.kind, `${e.rider}/${e.instance}/${e.runId ?? "?"}`, e.phase, e.key, e.text].filter((f) => f != null && f !== "").join(" ").replace(/\r?\n/g, " ");
}

export function render(verb, r) {
  // A stale decision (§8) also says where the instance is now, so the decider sees what it missed before it decides again.
  if (r?.ok === false && r.error) return r.stale && r.current ? `refused: ${r.error}\nnow: ${nowLine(r.current)}` : `refused: ${r.error}`;
  if (verb === "status") return renderStatus(r); // before the state switch: status has its own none/human shapes
  if (verb === "board") return renderBoard(r);
  // Before the state switch: `check` at a wait returns state `awaiting` too, and its block is not the entry's line.
  if (r?.kind === "await") return renderAwait(r);
  switch (r?.state) {
    case "none": return renderNone(r);
    case "human": return startNote(verb, r, renderHuman(r));
    // Here, before any read of `r.session`: a wait has none, and a throw after the committed entry would print it as refused.
    case "awaiting": return startNote(verb, r, awaitingLines(r));
    case "dry-run": return startNote(verb, r, r.entry ? `${dryRunLine(r)}\nentry: ${r.entry.phase} by ${r.entry.by}` : dryRunLine(r));
    case "operator": return [`run ${r.runId} stopped at operator: ${r.reason}`, `total cost: ${fmtCost(r.totalCost ?? 0)}`, "the operator directs what happens next:", ...operatorMoves(r.overrulable, r.runId, r.targetFlags)].join("\n");
    case "noted": return `noted (${r.notes} notes on ${r.ended ? "ended " : ""}run ${r.runId})`;
    case "event": return r.events.length ? r.events.map(eventLine).join("\n") : `no new event: ${r.reason}`;
    case "timeout": return `no event in ${r.minutes} min; ${r.atWait ? "nothing is ready to judge yet" : "the phase is still running"} — re-arm rider await`;
    default: break;
  }
  if (verb === "start" || verb === "next" || verb === "resume" || verb === "overrule") return startNote(verb, r, `${r.phase} started as ${r.model}: ${r.session.shortId}  (${r.attach})${r.resumed ? `  resumed ${r.resumed}` : ""}\nvisit ${r.visit ?? "?"} of run ${r.runId}`);
  return renderCheck(r);
}

/** Everything the operator can do after an `operator` stop, spelled as commands that exist: a judge
 *  left to describe the way out invents one (842b's told the operator to `rider start merge`, which the
 *  executor refused; it now starts a fresh run at the gate, not this one). `labels` is what `overrule`
 *  would accept — empty when the executor made the stop. `flags` are the verb's `--rider`/`--instance`
 *  (`targetFlags`), so every move runs as printed. */
function operatorMoves(labels, runId, flags = "") {
  const moves = [];
  if (labels?.length) moves.push([`rider overrule "<label>"${flags ? ` ${flags}` : ""} --because "…" --on ${runId}`, `the phase's outcome stands after all: revive this run and take that edge (${labels.join(" · ")})`]);
  moves.push([`rider start [phase]${flags ? ` ${flags}` : ""}`, "a fresh run, once what stopped this one is dealt with"]);
  const width = Math.max(...moves.map(([cmd]) => cmd.length)) + 3;
  return moves.map(([cmd, what]) => `  ${cmd.padEnd(width)}${what}`);
}

// `none` is not only "nothing here": reset and check both return it carrying a message of their own
// (what was reset, or why the run has no session), and dropping that leaves the operator with a lie.
function renderNone(r) {
  const L = [r.message ?? "no active run"];
  if (r.ended) L.push(`run ${r.ended.runId} ended: ${r.ended.reason}`);
  const last = r.lastRun;
  if (last && !r.ended) L.push(`last run ${last.runId} ended at ${last.endedBy} (phase ${last.phase}): ${last.reason ?? ""}`.trimEnd());
  if (r.error) L.push(r.error);
  return L.join("\n");
}

function renderHuman(r) {
  // Entering the phase by an edge runs no check: `rider check` runs it, and only then is there an exit code. A start at
  // the gate carries its pre-flight's, which ran it and saw it fail.
  const ran = r.checkExit != null ? `exit ${r.checkExit}` : "not run yet: rider check runs it";
  const L = [`${whose(r)} · phase ${r.phase} is yours`];
  if (r.branchDrift) L.push(driftLine(r));
  L.push(`check: ${r.check}   (${ran} — the run ends when it exits 0)`);
  if (r.checkOutput) L.push(`  ${r.checkOutput.split("\n").join("\n  ")}`);
  if (r.show) L.push(RULE("show"), ...r.show.split("\n").map((l) => `  ${l}`));
  if (r.notes?.length) L.push(RULE("notes"), ...r.notes.map((n) => `  ${n.at}  ${n.text}`));
  L.push(`total cost: ${fmtCost(r.totalCost ?? 0)}`);
  return L.join("\n");
}

function renderStatus(r) {
  // Every command printed for copying carries the verb's --rider/--instance, as `decide with` does (decision 15).
  const f = r.targetFlags ? ` ${r.targetFlags}` : "";
  if (r.state === "none") {
    const L = [`${whose(r)} · no active run`];
    if (r.lastRun) L.push(`last run ${r.lastRun.runId} ended at ${r.lastRun.endedBy} (phase ${r.lastRun.phase}): ${r.lastRun.reason ?? ""}   cost ${fmtCost(r.lastRun.totalCost)}`);
    if (r.lastRun?.endedBy === "operator") L.push("next, on the operator's word:", ...operatorMoves(r.lastRun.overrulable, r.lastRun.runId, r.targetFlags));
    else L.push(`next: rider start [phase]${f}`);
    return L.join("\n");
  }
  const base = r.baseBranch ?? "?";
  // Under drift the tree is not on the base, so the base is not named as the branch.
  const branchText = r.workBranch && r.workBranch !== base ? `base ${base} → work ${r.workBranch}` : r.branchDrift ? `base ${base}` : `branch ${base}`;
  const L = [`${whose(r)} · phase ${r.phase} (visit ${r.visits[r.phase] ?? 1})${r.key ? ` · stretch ${r.key}` : ""} · ${branchText} · started ${r.startedAt}`];
  if (r.branchDrift) L.push(driftLine(r));
  L.push(`state: ${r.state}   watcher: ${r.watcher ? `alive (pid ${r.watcher})` : "none"}   last event: ${r.lastEvent ? eventLine(r.lastEvent) : "none"}`);
  // A wait has no model, session or cost (§7.4): its row says what it is, and its line below what it last saw.
  for (const s of r.sessions) L.push(s.kind === "await" ? `  ${s.phase.padEnd(8)} ${"await".padEnd(7)} ${"-".padEnd(9)} ${s.outcome}` : `  ${s.phase.padEnd(8)} ${s.model.padEnd(7)} ${(s.shortId ?? "?").padEnd(9)} ${s.outcome.padEnd(13)} ${fmtCost(s.cost)}${s.turns != null ? `  ${s.turns} turns` : ""}${s.resumedFrom ? "  (resumed)" : ""}`);
  if (r.wait) L.push(waitLine(r.wait));
  if (r.wait?.failing) L.push(failingLine(r.wait));
  L.push(`total cost: ${fmtCost(r.totalCost)}`);
  if (r.attach) L.push(`attach: ${r.attach}`);
  // A failing check is the operator's to fix: the watcher keeps polling it, and nothing the judge decides would help.
  const awaiting = r.wait?.failing ? `relay the failing check to the operator, then arm rider await${f}` : `arm rider await${f} (background) and stop`;
  L.push(`next: ${{ running: `arm rider await${f} (background) and stop`, awaiting, waiting: `rider check${f}, relay the question, arm rider await${f}`, finished: `rider check${f}, then the command its decide-with line prints`, human: `rider check${f} (runs the phase's check command)` }[r.state]}`);
  return L.join("\n");
}

/** The board (§10), one group per category in the order the rows come sorted, needs-you first. Ages are read against
 *  `generatedAt`, so the text says what the JSON says. A row's `decide with` line is printed whole, as `check` prints it. */
function renderBoard(b) {
  const now = new Date(b.generatedAt).getTime();
  const age = (at) => (at ? fmtDuration(now - new Date(at).getTime()) : null);
  const L = [];
  if (b.errors.length) L.push(RULE(`errors (${b.errors.length})`), ...b.errors.map((e) => `  ${e.rider}${e.instance ? `/${e.instance}` : ""}: ${e.error.split("\n").join("\n    ")}`));
  const groups = new Map();
  for (const r of b.rows) groups.set(r.category, [...(groups.get(r.category) ?? []), r]);
  for (const [category, rows] of groups) {
    L.push(RULE(`${category} (${rows.length})`));
    for (const r of rows) {
      L.push(`  ${r.rider}/${r.instance}  ${[r.scope, r.phase && `phase ${r.phase}`, age(r.since), r.waitsOn].filter(Boolean).join(" · ")}`);
      const d = r.decision ? `${r.decision.label} by ${r.decision.by ?? "?"}${r.decision.because ? `: ${r.decision.because}` : ""}` : "none";
      const cost = r.runCost == null ? "no run" : `run ${fmtCost(r.runCost)}`;
      L.push(`    last decision: ${d}   cost: ${cost} · instance ${fmtCost(r.instanceCost)}   watcher: ${r.watcher ? `pid ${r.watcher}` : "none"}${r.updatedAt ? `   updated ${age(r.updatedAt)} ago` : ""}`);
      if (r.decideWith) L.push(`    ${r.decideWith}`);
    }
  }
  // Not beside an error: of a rider that did not load, nothing is known, its instances included.
  if (!b.rows.length && !b.errors.length) L.push(b.riders?.length ? `no instances yet (riders: ${b.riders.join(", ")}) — an instance is a directory its rider's instances glob matches` : "no riders/*/RIDER.md here — nothing on the board");
  if (b.skipped.length) L.push(RULE(`skipped (${b.skipped.length})`), ...b.skipped.map((s) => `  ${s.rider}: ${s.path} — ${s.reason}`));
  return L.join("\n");
}

export function renderCheck(r) {
  const L = [];
  L.push(`${whose(r)} · phase ${r.phase} · visit ${r.visit} · session ${r.session.shortId ?? r.session.id ?? "?"} (${r.attach})`);
  L.push(`state: ${r.state.padEnd(14)} (running | done | waiting | gone | rate-limited | intervened)`);
  if (r.branchDrift) L.push(driftLine(r));
  if (r.note) L.push(`note: ${r.note}`);
  if (r.doneReason) L.push(`reason: ${r.doneReason}`);
  L.push(`status hint: ${r.statusHint ?? "none"}`);
  const resumes = r.resumes ? `${r.resumes}${r.lastResume ? ` (${r.lastResume.reason}, ${r.lastResume.at})` : ""}` : "0";
  L.push(`resumes: ${resumes}   human turns after launch: ${r.humanTurns}   cost this stretch: ${fmtCost(r.cost)}   turns: ${r.turns ?? "?"}${r.elapsedMs != null ? `   elapsed: ${fmtDuration(r.elapsedMs)}` : ""}`);
  if (r.rateLimit) L.push(`rate limit: reset ${r.rateLimit.resetAt ?? "unknown"} (seen ${r.rateLimit.at})`);
  // The keys are the binding's; printed as found, so nothing harness-shaped is spelled here. Beyond the
  // model these are the operator's ambient settings, which is how an output style meant for a person
  // ends up in a session nobody reads.
  const ran = Object.entries(r.harness ?? {}).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`);
  if (ran.length) L.push(`ran under: ${ran.join(" · ")}`);
  if (r.state === "running") return L.join("\n");
  // Before the final message on purpose: whether the judge may judge that text at all depends on
  // who these turns came from, so it has to read them first.
  if (r.humanTurns > 0) {
    const turns = r.humanTurnDetails ?? [];
    L.push(RULE("human turns"));
    L.push(`  ${r.humanTurns} turn${r.humanTurns === 1 ? "" : "s"} after launch`);
    // The binding keeps only the first few, so a short block can be less than the whole story. A long
    // one means a nudge went unmarked and is about to read as an intervention: the count is the only
    // thing that can expose that, and nothing here identifies which entry to drop.
    if (turns.length < r.humanTurns) L.push(`  showing the first ${turns.length} of ${r.humanTurns}`);
    else if (turns.length > r.humanTurns) L.push(`  ${turns.length} shown, ${r.humanTurns} counted`);
    for (const t of turns) {
      L.push("", `  [${t.at ?? "no timestamp"}] (${t.origin})`);
      for (const l of String(t.text ?? "").split("\n")) L.push(`  ${l}`);
      if (t.truncated) L.push(`  … ${t.bytes} bytes total, cut`);
    }
  }
  L.push(`${RULE("final message")} (capped at 8 KB${r.log ? `; full text in ${r.log}` : ""})`);
  for (const l of formatFinal(r.finalText, 8 * 1024).split("\n")) L.push(`  ${l}`);
  if (r.question) L.push(RULE("question"), ...formatQuestion(r.question));
  L.push(...evidenceLines(r.evidence));
  L.push(`── legal labels: ${r.labels.map(labelText).join(" · ")}`);
  if (r.requires) L.push(requiresLine(r.requires));
  if (r.decideWith) L.push(r.decideWith);
  return L.join("\n");
}

/** `check` at an await phase (§7.7): the watcher's last stored poll, never a fresh one. While the wait awaits, that is all
 *  there is; ready or timed out, the judge reads the show, the evidence and the requires before it copies `decide with:`. */
function renderAwait(r) {
  const w = r.wait;
  const L = [`${whose(r)} · phase ${r.phase} · visit ${r.visit} · awaiting since ${w.at} (${fmtDuration(r.elapsedMs)}) · ${w.polls} polls`, `state: ${r.state}`];
  if (r.branchDrift) L.push(driftLine(r));
  // Before the first poll there is no exit to name; an error the exit cannot say (a timeout, a spawn failure) follows it.
  const polled = w.lastPollAt ? `exit ${w.lastExit}${w.lastError ? `: ${w.lastError}` : ""}, polled ${w.lastPollAt}` : "no poll yet";
  L.push(`── check ── $ ${w.check}   (${polled})`, ...indented(r.checkOutput));
  if (r.state === "awaiting") {
    if (w.failing) L.push(failingLine(w));
    if (w.deadline) L.push(`deadline: ${w.deadline}`);
    return L.join("\n");
  }
  if (r.showCmd) L.push(`── show ── $ ${r.showCmd}`, ...indented(r.show));
  L.push(...evidenceLines(r.evidence));
  if (r.requires) L.push(requiresLine(r.requires));
  if (r.decideWith) L.push(r.decideWith);
  return L.join("\n");
}
