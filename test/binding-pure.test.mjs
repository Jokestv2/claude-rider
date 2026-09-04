// test/binding-pure.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESUME_NUDGE, SYSTEM_APPEND, classifyNoMarker, classifyRegistry, parseBgLaunch, parseResetTime, readTranscript } from "../scripts/bindings/claude-code.mjs";

const alive = () => true;
const dead = () => false;
const A = (text, extra = {}) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, ...extra });
const U = (text, origin = { kind: "human" }) => JSON.stringify({ type: "user", origin, message: { role: "user", content: text } });
const ASK = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "A or B?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }] } }] } });
const ANSWER = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "A" }] } });
const COST = JSON.stringify({ type: "cost-state", totalCostUSD: 0.0871373 });
const SYS = JSON.stringify({ type: "system", content: "You've hit your session limit - resets 1:40am (America/Toronto)" });
const SYNTH = JSON.stringify({ type: "assistant", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 529 overloaded" }] } });
const NOTIFY = U("<task-notification>done</task-notification>", { kind: "task-notification" });

test("the two texts are the v2 texts, verbatim", () => {
  assert.match(SYSTEM_APPEND, /^You are one phase of an automated loop driven by a rider\./);
  assert.match(SYSTEM_APPEND, /ending your turn while one runs is safe\.$/);
  assert.match(RESUME_NUDGE, /^Your previous turn was interrupted by the environment/);
  assert.match(RESUME_NUDGE, /<promise> marker your original instructions require\.$/);
});

test("bg launch line parses through ANSI; garbage is null", () => {
  assert.deepEqual(parseBgLaunch("\x1b[2mbackgrounded\x1b[0m \x1b[2m·\x1b[0m \x1b[36m9c1e02aa\x1b[0m \x1b[2m·\x1b[0m rider lemmaria/ab12 plan\n"), { shortId: "9c1e02aa", name: "rider lemmaria/ab12 plan" });
  assert.equal(parseBgLaunch("something went wrong"), null);
  assert.equal(parseBgLaunch(""), null);
});

test("registry classification", () => {
  assert.equal(classifyRegistry({ pid: 1, status: "busy", state: "working" }, alive), "running");
  assert.equal(classifyRegistry({ pid: 1, status: "waiting", state: "blocked" }, alive), "waiting");
  assert.equal(classifyRegistry({ pid: 1, status: "idle", state: "blocked" }, alive), "waiting");
  assert.equal(classifyRegistry({ pid: 1, status: "idle", state: "done" }, alive), "done");
  assert.equal(classifyRegistry({ state: "done" }, dead), "done");
  assert.equal(classifyRegistry(null, alive), "gone");
  assert.equal(classifyRegistry({ pid: 1, status: "busy", state: "working" }, dead), "gone");
  assert.equal(classifyRegistry({ pid: 1 }, alive), "running");
  assert.equal(classifyRegistry({ pid: 1, status: "idle", state: "working" }, alive), "done");
  assert.equal(classifyRegistry({ state: "stopped" }, dead), "gone");
});

test("harvesting a transcript", () => {
  const finished = readTranscript([U("Prompt P…"), A("thinking…"), A("done.\nSTATUS: planned"), COST].join("\n"));
  assert.equal(finished.lastText, "done.\nSTATUS: planned");
  assert.equal(finished.cost, 0.0871373);
  assert.equal(finished.costEntries, 1);
  assert.equal(finished.question, null);
  assert.equal(finished.turns, 2);
  assert.equal(finished.userTurns, 1);
  assert.equal(readTranscript([COST, COST.replace("0.0871373", "0.5")].join("\n")).cost, 0.5);
  const waiting = readTranscript([U("p"), ASK].join("\n"));
  assert.equal(waiting.question.questions[0].question, "A or B?");
  assert.equal(waiting.cost, null);
  assert.equal(readTranscript([U("p"), ASK, ANSWER].join("\n")).question, null);
  assert.equal(classifyNoMarker({}, readTranscript([U("p"), SYS].join("\n")).signal).kind, "rate-limited");
  assert.equal(readTranscript(`not json\n${A("x")}\n{broken`).lastText, "x");
});

test("synthetic entries never become the final reply but still reach the signal", () => {
  const h = readTranscript([U("p"), A("R2 is complete.\nSTATUS: code green"), SYNTH].join("\n"));
  assert.equal(h.lastText, "R2 is complete.\nSTATUS: code green");
  assert.match(h.signal, /API Error: 529/);
  assert.equal(h.turns, 2);
  assert.equal(readTranscript(SYNTH).lastText, null);
  assert.deepEqual(readTranscript(""), { lastText: null, lastAt: null, cost: null, costEntries: 0, question: null, turns: 0, userTurns: 0, signal: "", tail: [] });
});

test("lastAt is the entry timestamp of the last real assistant text", () => {
  const AT = (text, ts) => JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "text", text }] } });
  const SYNTH_AT = JSON.stringify({ type: "assistant", timestamp: "2026-09-03T09:00:00.000Z", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 529 overloaded" }] } });
  assert.equal(readTranscript([U("p"), AT("first", "2026-09-03T01:00:00.000Z"), AT("second", "2026-09-03T02:00:00.000Z")].join("\n")).lastAt, "2026-09-03T02:00:00.000Z");
  assert.equal(readTranscript([U("p"), AT("real", "2026-09-03T01:00:00.000Z"), SYNTH_AT].join("\n")).lastAt, "2026-09-03T01:00:00.000Z");
  assert.equal(readTranscript([U("p"), A("an old transcript with no timestamp")].join("\n")).lastAt, null);
});

test("userTurns counts human-origin user messages only", () => {
  const t = [U("launch prompt"), A("a"), NOTIFY, A("b"), U("the nudge"), A("c"), ANSWER, U("operator typed this")].join("\n");
  assert.equal(readTranscript(t).userTurns, 3);
  assert.equal(readTranscript(JSON.stringify({ type: "user", message: { role: "user", content: "old transcript, no origin" } })).userTurns, 1);
});

test("rate-limit and API-error classification", () => {
  const limit = "You've hit your session limit - resets 1:40am (America/Toronto)";
  assert.equal(classifyNoMarker({ api_error_status: 429 }, "").kind, "rate-limited");
  assert.equal(classifyNoMarker({}, limit).kind, "rate-limited");
  assert.equal(classifyNoMarker(null, "we deliberate limits here").kind, "no-marker");
  assert.equal(classifyNoMarker(null, "API Error: 429 rate limit exceeded").kind, "rate-limited");
  assert.equal(classifyNoMarker(null, "API Error: 500 Internal server error").kind, "api-error");
  assert.equal(classifyNoMarker(null, 'API Error: 529 {"type":"overloaded_error"}').kind, "api-error");
  assert.equal(classifyNoMarker(null, "released in 2026, see issue 500").kind, "no-marker");
  assert.equal(classifyNoMarker(null, "").kind, "no-marker");
});

test("the real Claude Code limit shapes classify as rate-limited", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const hit = classifyNoMarker(null, "You've hit your limit · resets 1:40am (America/Toronto)", now);
  assert.equal(hit.kind, "rate-limited");
  assert.equal(new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hour12: false, hour: "2-digit", minute: "2-digit" }).format(hit.resetAt), "01:40");
  const epoch = classifyNoMarker(null, "Claude AI usage limit reached|1757000000", now);
  assert.equal(epoch.kind, "rate-limited");
  assert.equal(epoch.resetAt.toISOString(), "2025-09-04T15:33:20.000Z");
  const api = classifyNoMarker(null, "API Error: 429 {\"type\":\"error\"}", now);
  assert.deepEqual([api.kind, api.resetAt], ["rate-limited", null]);
  const later = classifyNoMarker(null, "Your limit will reset at 3pm (UTC)", now);
  assert.equal(later.kind, "rate-limited");
  assert.equal(later.resetAt.toISOString(), "2026-08-31T15:00:00.000Z");
  // prose about limits is not a limit
  assert.equal(classifyNoMarker(null, "The rate-limiting middleware is off; these are the limits of the approach.", now).kind, "no-marker");
  assert.equal(parseResetTime("the quota resets, eventually", now), null);
});

test("reset time is resolved in the account's zone", () => {
  const noonUTC = new Date("2026-08-31T12:00:00Z");
  const inToronto = (d, o) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hour12: false, ...o }).format(d);
  const r1 = parseResetTime("resets 1:40am (America/Toronto)", noonUTC);
  assert.ok(r1.getTime() > noonUTC.getTime());
  assert.equal(inToronto(r1, { hour: "2-digit", minute: "2-digit" }), "01:40");
  assert.equal(inToronto(r1, { day: "2-digit" }), "01");
  const r2 = parseResetTime("resets 11pm (America/Toronto)", noonUTC);
  assert.equal(inToronto(r2, { hour: "2-digit" }), "23");
  assert.equal(inToronto(r2, { day: "2-digit" }), "31");
  assert.equal(parseResetTime("resets 12:00am", noonUTC).toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(parseResetTime("resets 12:30pm", noonUTC).toISOString(), "2026-08-31T12:30:00.000Z");
  assert.equal(parseResetTime("something went wrong", noonUTC), null);
  assert.equal(parseResetTime("resets 1:40am (Not/AZone)", noonUTC), null);
  assert.equal(parseResetTime("resets 99:99am (UTC)", noonUTC), null);
});
