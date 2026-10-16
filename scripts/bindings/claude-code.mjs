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

const TURN_TEXT_MAX = 400;
const TURN_DETAILS_MAX = 10;

export function readTranscript(text) {
  // lastAt anchors the rate-limit reset: a reset parsed against `now` when the judge was down for
  // hours reads as tomorrow, and the watcher would then sleep about a day for a limit already lifted.
  const out = { lastText: null, lastAt: null, cost: null, costEntries: 0, question: null, turns: 0, userTurns: 0, userTurnDetails: [], signal: "", tail: [], harness: null };
  // What the session ran under, beyond what the rider passed: the last value seen of each, since effort
  // and output style can change mid-session. A key stays null when the transcript never states it.
  const harness = { version: null, effort: null, advisorModel: null, outputStyle: null };
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
      if (!synthetic) for (const k of ["version", "effort", "advisorModel"]) if (typeof d[k] === "string") harness[k] = d[k];
      for (const b of content) {
        if (b.type === "text" && b.text) {
          if (!synthetic) { out.lastText = b.text; out.lastAt = typeof d.timestamp === "string" ? d.timestamp : null; }
          signals.push(b.text);
        }
        if (b.type === "tool_use" && b.name === "AskUserQuestion") out.question = b.input ?? null;
      }
    } else if (d.type === "user") {
      if (content.some((b) => b.type === "tool_result")) out.question = null;
      // The origin-less fallback stays for transcripts that predate `origin`, but an injected entry is
      // not a person: an autocompact summary arrives as user-role string content with no origin, and
      // counting it made every phase long enough to compact read as `intervened`.
      else if (
        d.origin?.kind === "human" ||
        (d.origin === undefined && typeof raw === "string" && !d.isCompactSummary && !d.isVisibleInTranscriptOnly)
      ) {
        out.userTurns++;
        const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        // The rider typed this one, not the operator. Matched here because this file owns the text;
        // it lets `check` drop nudges by identity, which position cannot do — after a resume the
        // nudge follows any turn the operator made in the previous stretch.
        const isNudge = text === RESUME_NUDGE;
        // The judge is told a human turn happened; without the text it can only interrogate the
        // operator about something already on disk. Capped so a pasted file cannot flood the block.
        // A matched nudge spends no slot: launch plus nine nudges would otherwise fill the cap, and
        // the operator turn after that — the one the judge must stop on — would never be stored.
        if (!isNudge && out.userTurnDetails.length < TURN_DETAILS_MAX) {
          const truncated = text.length > TURN_TEXT_MAX;
          out.userTurnDetails.push({
            at: typeof d.timestamp === "string" ? d.timestamp : null,
            origin: d.origin?.kind ?? "no origin, string content",
            bytes: Buffer.byteLength(text),
            text: truncated ? text.slice(0, TURN_TEXT_MAX) : text,
            truncated,
            nudge: isNudge,
          });
        }
      }
    } else if (d.type === "cost-state" && typeof d.totalCostUSD === "number") {
      out.cost = d.totalCostUSD;
      out.costEntries++;
    } else if (d.type === "system" && typeof d.content === "string") {
      signals.push(d.content);
    } else if (d.type === "attachment" && d.attachment?.type === "output_style" && typeof d.attachment.style === "string") {
      harness.outputStyle = d.attachment.style;
    }
    out.tail.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
  }
  out.tail = out.tail.slice(-30);
  out.signal = signals.slice(-10).join("\n");
  if (Object.values(harness).some((v) => v !== null)) out.harness = harness;
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

/** "resets 1:40am (America/Toronto)", "will reset at 3pm", or the epoch form "…limit reached|1757000000"
 *  → an absolute instant (in the account's zone for the wall-clock forms); null when unparseable. */
export function parseResetTime(text, now = new Date()) {
  // Claude Code prints the reset as a unix epoch after a pipe on some messages: it needs no zone.
  const epoch = /\|(\d{10})\b/.exec(text ?? "");
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(text ?? "");
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
  // The shapes 2.1.260 actually prints; the \b anchors keep prose ("rate-limiting middleware") out.
  const limited = status === 429 || /(hit|reached) your(?: \w+)? limit|usage limit reached|limit will reset|\brate[ -_]?limits?\b|\btoo many requests\b|\bAPI Error:?\s*429\b/i.test(text ?? "");
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

/** The default executable: v2 pinned `~/.local/bin/claude.exe` on Windows because spawnSync does
 * not resolve `.cmd` shims; `local.json`'s `claudePath` overrides. */
export function defaultClaudePath() {
  if (process.platform === "win32") {
    const p = join(homedir(), ".local", "bin", "claude.exe");
    if (existsSync(p)) return p;
  }
  return "claude";
}

export function createBinding({ claudePath = null, advisor = null, launchArgs = [], permissionMode = "auto", projectsDir = join(homedir(), ".claude", "projects"), exec = spawnSync, alive = isAlive, sleep = sleepSync } = {}) {
  const exe = claudePath || defaultClaudePath();
  const claude = (args, opts = {}) => exec(exe, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts });
  const agents = () => {
    const r = claude(["agents", "--json", "--all"]);
    // A missing binary is configuration, not a transient: say so instead of reporting every session gone.
    if (r.error?.code === "ENOENT") throw new Error(`cannot run ${exe}: ${r.error.message} — set claudePath in .rider/<name>/local.json`);
    try { const v = JSON.parse(r.stdout ?? ""); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  // A phase session otherwise inherits the operator's interactive setup — effort, output style, advisor —
  // and that setup drifts under the runs. `launchArgs` is how a project pins it (`--effort`, `--settings`).
  // Placed before the rider's own flags: a variadic flag (`--mcp-config a b`) then ends at `-n` instead
  // of swallowing the prompt. Validated here because a string would spread into single characters.
  if (!Array.isArray(launchArgs) || launchArgs.some((a) => typeof a !== "string")) throw new Error("launchArgs in local.json must be a list of strings, one argv element each");
  const common = ({ model, name }) => ["--bg", ...launchArgs, "-n", name, "--model", model, "--permission-mode", permissionMode || "auto", "--append-system-prompt", SYSTEM_APPEND, ...(advisor ? ["--advisor", advisor] : [])];
  const launchArgv = (prompt, o) => [...common(o), prompt];
  const resumeArgv = (sessionId, o) => (o.listed ? ["--bg", "--resume", sessionId, RESUME_NUDGE] : [...common(o), "--resume", sessionId, RESUME_NUDGE]);
  const spawnBg = (argv, cwd) => {
    const r = claude(argv, { cwd });
    const launched = parseBgLaunch(r.stdout);
    if (!launched) throw new Error((r.error?.message || r.stderr || r.stdout || `claude exited ${r.status}`).trim());
    let entry = null;
    for (let i = 0; i < 30 && !entry; i++) { sleep(1000); entry = findEntry(agents(), { shortId: launched.shortId }); }
    return { shortId: launched.shortId, sessionId: entry?.sessionId ?? null, name: launched.name };
  };
  return {
    name: "claude-code",
    launch: (prompt, { model, name, cwd }) => spawnBg(launchArgv(prompt, { model, name }), cwd),
    resume: (sessionId, { listed, model, name, cwd }) => { const r = spawnBg(resumeArgv(sessionId, { listed, model, name }), cwd); return { ...r, sessionId: r.sessionId ?? sessionId }; },
    status: (ids) => { const entry = findEntry(agents(), ids); return { kind: classifyRegistry(entry, alive), entry, listed: !!entry }; },
    read: (ids) => { const p = findTranscript(projectsDir, ids.sessionId); return { ...readTranscript(p ? readFileSync(p, "utf8") : ""), transcript: p }; },
    stop: (ids) => { claude(["stop", ids.shortId ?? ids.sessionId]); },
    attachHint: (ids) => `claude attach ${ids.shortId ?? ids.sessionId}   (or ← for agents)`,
    stopHint: (ids) => `claude stop ${ids.shortId ?? ids.sessionId}`,
    dryRun: { claudePath: exe, launchArgv, resumeArgv },
    heuristics: { classifyNoMarker, parseResetTime },
  };
}
