// scripts/lib/render.mjs
import { fmtCost, fmtDuration, formatFinal, formatQuestion } from "./markers.mjs";

const RULE = (title) => `── ${title} ${"─".repeat(Math.max(4, 60 - title.length))}`;
const labelText = (l) => (l.label === "resume" || l.label === "operator" ? l.label : `${l.label} → ${l.to}`);

export function render(verb, r) {
  if (r?.ok === false && r.error) return `refused: ${r.error}`;
  if (verb === "status") return renderStatus(r); // before the state switch: status has its own none/human shapes
  switch (r?.state) {
    case "none": return renderNone(r);
    case "human": return renderHuman(r);
    case "dry-run": return r.argv ? `[dry-run] ${r.phase} (${r.model}): ${r.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a.length > 60 ? `${a.slice(0, 57)}…` : a) : a)).join(" ")}` : `[dry-run] ${r.phase ?? r.to}`;
    case "operator": return `run ${r.runId} stopped at operator: ${r.reason}\ntotal cost: ${fmtCost(r.totalCost ?? 0)}\nthe operator directs what happens next (rider start [phase] when ready)`;
    case "noted": return `noted (${r.notes} notes on run ${r.runId})`;
    case "event": return r.events.length ? r.events.join("\n") : `no new event: ${r.reason}`;
    case "timeout": return `no event in ${r.minutes} min; the phase is still running — re-arm rider await`;
    default: break;
  }
  if (verb === "start" || verb === "next" || verb === "resume") return `${r.phase} started as ${r.model}: ${r.session.shortId}  (${r.attach})${r.resumed ? `  resumed ${r.resumed}` : ""}\nvisit ${r.visit ?? "?"} of run ${r.runId}`;
  return renderCheck(r);
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
  const L = [`rider ${r.rider}/${r.runId} · phase ${r.phase} is yours`, `check: ${r.check}   (exit ${r.checkExit ?? "?"} — the run ends when it exits 0)`];
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
    L.push("next: rider start [phase]");
    return L.join("\n");
  }
  const L = [`rider ${r.rider}/${r.runId} · phase ${r.phase} (visit ${r.visits[r.phase] ?? 1}) · branch ${r.branch ?? "?"} · started ${r.startedAt}`, `state: ${r.state}   watcher: ${r.watcher ? `alive (pid ${r.watcher})` : "none"}   last event: ${r.lastEvent ?? "none"}`];
  for (const s of r.sessions) L.push(`  ${s.phase.padEnd(8)} ${s.model.padEnd(7)} ${(s.shortId ?? "?").padEnd(9)} ${s.outcome.padEnd(13)} ${fmtCost(s.cost)}${s.turns != null ? `  ${s.turns} turns` : ""}${s.resumedFrom ? "  (resumed)" : ""}`);
  L.push(`total cost: ${fmtCost(r.totalCost)}`);
  if (r.attach) L.push(`attach: ${r.attach}`);
  L.push(`next: ${{ running: "arm rider await (background) and stop", waiting: "rider check, relay the question, arm rider await", finished: "rider check, then rider next <label> --because …", human: "rider check (runs the phase's check command)" }[r.state]}`);
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
  if (r.state === "running") return L.join("\n");
  // Before the final message on purpose: whether the judge may judge that text at all depends on
  // who these turns came from, so it has to read them first.
  if (r.humanTurns > 0) {
    const turns = r.humanTurnDetails ?? [];
    L.push(RULE("human turns"));
    L.push(`  ${r.humanTurns} turn${r.humanTurns === 1 ? "" : "s"} after launch`);
    // The binding keeps only the first few, so a short block can be less than the whole story.
    if (turns.length < r.humanTurns) L.push(`  showing the first ${turns.length} of ${r.humanTurns}`);
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
  return L.join("\n");
}
