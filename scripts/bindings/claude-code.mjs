// scripts/bindings/claude-code.mjs — everything Claude-Code-shaped lives here (§5)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What a session cannot infer about being driven. VERBATIM from v2; the test every clause must
 * pass: a phase behaves as if the operator had pasted the prompt into an interactive session. */
export const SYSTEM_APPEND = [
  "You are one phase of an automated loop driven by a rider.",
  "No human is watching this session as it runs: your final message is harvested by a script,",
  "which reads it for the `STATUS:` line your prompt asks for.",
  "A quick tactical question may use AskUserQuestion - the rider will fetch the operator,",
  "who answers by attaching to this session.",
  "The harness re-invokes you when a subagent or a background task finishes, so never poll for one",
  "with a sleep loop: ending your turn while one runs is safe.",
].join(" ");

export const RESUME_NUDGE =
  "Your previous turn was interrupted by the environment - an API rate limit or a killed " +
  "process - not by anything you did, and not by a problem with the work. Continue exactly " +
  "where you stopped: do NOT restart this phase or redo work you have already done. Finish " +
  "the phase and end with the STATUS line and the <promise> marker your original " +
  "instructions require.";

export function parseBgLaunch(stdout) {
  const plain = String(stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const m = /^backgrounded\s+\S+\s+([0-9a-f]{8})\s+\S+\s+(.+?)\s*$/m.exec(plain);
  return m ? { shortId: m[1], name: m[2] } : null;
}

export function classifyRegistry(entry, alive) {
  if (!entry) return "gone";
  if (entry.state === "done") return "done";
  if (!entry.pid || !alive(entry.pid)) return "gone";
  if (entry.state === "blocked" || entry.status === "waiting") return "waiting";
  if (entry.status === "idle") return "done";
  return "running";
}

export function readTranscript(text) {
  const out = { lastText: null, cost: null, costEntries: 0, question: null, turns: 0, userTurns: 0, signal: "", tail: [] };
  const signals = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const raw = d.message?.content;
    const content = Array.isArray(raw) ? raw : typeof raw === "string" ? [{ type: "text", text: raw }] : [];
    if (d.type === "assistant") {
      out.turns++;
      const synthetic = d.isApiErrorMessage === true || d.message?.model === "<synthetic>";
      for (const b of content) {
        if (b.type === "text" && b.text) {
          if (!synthetic) out.lastText = b.text;
          signals.push(b.text);
        }
        if (b.type === "tool_use" && b.name === "AskUserQuestion") out.question = b.input ?? null;
      }
    } else if (d.type === "user") {
      if (content.some((b) => b.type === "tool_result")) out.question = null;
      else if (d.origin?.kind === "human" || (d.origin === undefined && typeof raw === "string")) out.userTurns++;
    } else if (d.type === "cost-state" && typeof d.totalCostUSD === "number") {
      out.cost = d.totalCostUSD;
      out.costEntries++;
    } else if (d.type === "system" && typeof d.content === "string") {
      signals.push(d.content);
    }
    out.tail.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
  }
  out.tail = out.tail.slice(-30);
  out.signal = signals.slice(-10).join("\n");
  return out;
}

export function findEntry(list, { shortId, sessionId }) {
  return list.find((x) => (sessionId && x.sessionId === sessionId) || (shortId && x.id === shortId)) ?? null;
}

export function findTranscript(projectsDir, sessionId) {
  if (!sessionId || !existsSync(projectsDir)) return null;
  for (const d of readdirSync(projectsDir)) {
    const p = join(projectsDir, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** ms to add to an instant so a UTC getter reads its wall clock in `zone`. */
function tzOffsetMs(date, zone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const p = {};
  for (const x of parts) if (x.type !== "literal") p[x.type] = x.value;
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUTC - date.getTime();
}

/** The next instant whose wall clock in `zone` reads hour:minute. */
function nextWallClock(now, zone, hour, minute) {
  const off = tzOffsetMs(now, zone);
  const shifted = new Date(now.getTime() + off);
  const y = shifted.getUTCFullYear();
  const mo = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  for (const add of [0, 1, 2]) {
    const wall = Date.UTC(y, mo, d + add, hour, minute, 0);
    let t = wall - off;
    const off2 = tzOffsetMs(new Date(t), zone);
    if (off2 !== off) t = wall - off2;
    if (t > now.getTime()) return new Date(t);
  }
  return null;
}

/** "resets 1:40am (America/Toronto)" → absolute instant in the account's zone; null when unparseable. */
export function parseResetTime(text, now = new Date()) {
  const m = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(text ?? "");
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const mer = m[3]?.toLowerCase();
  if (mer === "pm" && hour !== 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  try { return nextWallClock(now, m[4] || "UTC", hour, minute); } catch { return null; }
}

/** Why a session produced no STATUS line: a rate limit (a wait), an API error, or nothing. */
export function classifyNoMarker(json, text, now = new Date()) {
  const status = json?.api_error_status ?? null;
  const limited = status === 429 || /(hit|reached) your (session|usage|weekly|account) limit|\brate[ -]?limits?\b|\btoo many requests\b/i.test(text ?? "");
  if (limited) return { kind: "rate-limited", status, resetAt: parseResetTime(text, now) };
  const apiErr = /\bAPI Error:?\s*(5\d\d)\b/i.exec(text ?? "");
  if (json?.terminal_reason === "api_error" || (status !== null && status >= 500) || apiErr) {
    return { kind: "api-error", status: status ?? (apiErr ? Number(apiErr[1]) : null) };
  }
  return { kind: "no-marker", status };
}

// Process liveness and a blocking sleep are not harness-shaped: they live in scripts/lib/proc.mjs
// (created in this task) and are re-exported here for the binding's own use.
export { isAlive, sleepSync } from "../lib/proc.mjs";
import { isAlive, sleepSync } from "../lib/proc.mjs";
