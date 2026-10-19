// scripts/lib/render.mjs
import { nowLine } from "./keys.mjs";
import { fmtCost, fmtDuration, formatFinal, formatQuestion } from "./markers.mjs";

const RULE = (title) => `── ${title} ${"─".repeat(Math.max(4, 60 - title.length))}`;
const labelText = (l) => (l.label === "resume" || l.label === "operator" ? l.label : `${l.label} → ${l.to}`);

/** One event, one line: `<at> <kind> <rider>/<instance>/<runId> <phase> <key> <text>`, with absent fields left out. */
export function eventLine(e) {
  return [e.at, e.kind, `${e.rider}/${e.instance}/${e.runId ?? "?"}`, e.phase, e.key, e.text].filter((f) => f != null && f !== "").join(" ").replace(/\r?\n/g, " ");
}

export function render(verb, r) {
  // A stale decision (§8) also says where the instance is now, so the decider sees what it missed before it decides again.
  if (r?.ok === false && r.error) return r.stale && r.current ? `refused: ${r.error}\nnow: ${nowLine(r.current)}` : `refused: ${r.error}`;
  if (verb === "status") return renderStatus(r); // before the state switch: status has its own none/human shapes
  switch (r?.state) {
    case "none": return renderNone(r);
    case "human": return renderHuman(r);
    case "dry-run": return r.argv ? `[dry-run] ${r.phase} (${r.model}): ${r.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a.length > 60 ? `${a.slice(0, 57)}…` : a) : a)).join(" ")}` : `[dry-run] ${r.phase ?? r.to}`;
    case "operator": return [`run ${r.runId} stopped at operator: ${r.reason}`, `total cost: ${fmtCost(r.totalCost ?? 0)}`, "the operator directs what happens next:", ...operatorMoves(r.overrulable, r.runId)].join("\n");
    case "noted": return `noted (${r.notes} notes on ${r.ended ? "ended " : ""}run ${r.runId})`;
    case "event": return r.events.length ? r.events.map(eventLine).join("\n") : `no new event: ${r.reason}`;
    case "timeout": return `no event in ${r.minutes} min; the phase is still running — re-arm rider await`;
    default: break;
  }
  if (verb === "start" || verb === "next" || verb === "resume" || verb === "overrule") return `${r.phase} started as ${r.model}: ${r.session.shortId}  (${r.attach})${r.resumed ? `  resumed ${r.resumed}` : ""}\nvisit ${r.visit ?? "?"} of run ${r.runId}`;
  return renderCheck(r);
}

/** Everything the operator can do after an `operator` stop, spelled as commands that exist: a judge
 *  left to describe the way out invents one (842b's told the operator to `rider start merge`, which the
 *  executor refuses). `labels` is what `overrule` would accept — empty when the executor made the stop. */
function operatorMoves(labels, runId) {
  const moves = [];
  if (labels?.length) moves.push([`rider overrule "<label>" --because "…" --on ${runId}`, `the phase's outcome stands after all: revive this run and take that edge (${labels.join(" · ")})`]);
  moves.push(["rider start [phase]", "a fresh run, once what stopped this one is dealt with"]);
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
  // Entering the phase does not run its check; only `rider check` does, and only then is there an exit code.
  const ran = r.checkExit != null ? `exit ${r.checkExit}` : "not run yet: rider check runs it";
  const L = [`rider ${r.rider}/${r.runId} · phase ${r.phase} is yours`, `check: ${r.check}   (${ran} — the run ends when it exits 0)`];
  if (r.checkOutput) L.push(`  ${r.checkOutput.split("\n").join("\n  ")}`);
  if (r.show) L.push(RULE("show"), ...r.show.split("\n").map((l) => `  ${l}`));
  if (r.notes?.length) L.push(RULE("notes"), ...r.notes.map((n) => `  ${n.at}  ${n.text}`));
  L.push(`total cost: ${fmtCost(r.totalCost ?? 0)}`);
  return L.join("\n");
}

function renderStatus(r) {
  if (r.state === "none") {
    const L = [`rider ${r.rider} · no active run`];
    if (r.lastRun) L.push(`last run ${r.lastRun.runId} ended at ${r.lastRun.endedBy} (phase ${r.lastRun.phase}): ${r.lastRun.reason ?? ""}   cost ${fmtCost(r.lastRun.totalCost)}`);
    if (r.lastRun?.endedBy === "operator") L.push("next, on the operator's word:", ...operatorMoves(r.lastRun.overrulable, r.lastRun.runId));
    else L.push("next: rider start [phase]");
    return L.join("\n");
  }
  const base = r.baseBranch ?? "?";
  const branchText = r.workBranch && r.workBranch !== base ? `base ${base} → work ${r.workBranch}` : `branch ${base}`;
  const L = [`rider ${r.rider}/${r.runId} · phase ${r.phase} (visit ${r.visits[r.phase] ?? 1}) · ${branchText} · started ${r.startedAt}`, `state: ${r.state}   watcher: ${r.watcher ? `alive (pid ${r.watcher})` : "none"}   last event: ${r.lastEvent ? eventLine(r.lastEvent) : "none"}`];
  for (const s of r.sessions) L.push(`  ${s.phase.padEnd(8)} ${s.model.padEnd(7)} ${(s.shortId ?? "?").padEnd(9)} ${s.outcome.padEnd(13)} ${fmtCost(s.cost)}${s.turns != null ? `  ${s.turns} turns` : ""}${s.resumedFrom ? "  (resumed)" : ""}`);
  L.push(`total cost: ${fmtCost(r.totalCost)}`);
  if (r.attach) L.push(`attach: ${r.attach}`);
  L.push(`next: ${{ running: "arm rider await (background) and stop", waiting: "rider check, relay the question, arm rider await", finished: "rider check, then the command its decide-with line prints", human: "rider check (runs the phase's check command)" }[r.state]}`);
  return L.join("\n");
}

export function renderCheck(r) {
  const L = [];
  L.push(`rider ${r.rider}/${r.runId} · phase ${r.phase} · visit ${r.visit} · session ${r.session.shortId ?? r.session.id ?? "?"} (${r.attach})`);
  L.push(`state: ${r.state.padEnd(14)} (running | done | waiting | gone | rate-limited | intervened)`);
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
  if (r.evidence?.length) {
    L.push(RULE("evidence"));
    for (const e of r.evidence) {
      L.push(`  $ ${e.cmd}${e.status !== 0 ? `   (exit ${e.status})` : ""}`);
      for (const l of (e.output || "").split("\n").filter(Boolean)) L.push(`  ${l}`);
    }
  }
  L.push(`── legal labels: ${r.labels.map(labelText).join(" · ")}`);
  if (r.decideWith) L.push(r.decideWith);
  return L.join("\n");
}
