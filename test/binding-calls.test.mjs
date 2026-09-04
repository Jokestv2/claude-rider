// test/binding-calls.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESUME_NUDGE, SYSTEM_APPEND, createBinding } from "../scripts/bindings/claude-code.mjs";

function fakeExec(script) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args[0] === "agents" ? "agents" : args[0] === "stop" ? "stop" : "launch";
    return { status: 0, stdout: script[key] ?? "", stderr: "" };
  };
  return { exec, calls };
}
const launchLine = "backgrounded · 9c1e02aa · rider lemmaria/ab12 plan\n";
const registry = JSON.stringify([{ id: "9c1e02aa", sessionId: "full-id-1", pid: 4242, status: "busy", state: "working" }]);

test("launch argv is the v2 shape and the session id comes from the registry", () => {
  const { exec, calls } = fakeExec({ launch: launchLine, agents: registry });
  const b = createBinding({ claudePath: "claude-x", advisor: "fable", exec, sleep: () => {} });
  const r = b.launch("PROMPT", { model: "opus", name: "rider lemmaria/ab12 plan", cwd: "/proj" });
  assert.deepEqual(r, { shortId: "9c1e02aa", sessionId: "full-id-1", name: "rider lemmaria/ab12 plan" });
  assert.deepEqual(calls[0], ["claude-x", "--bg", "-n", "rider lemmaria/ab12 plan", "--model", "opus", "--permission-mode", "auto", "--append-system-prompt", SYSTEM_APPEND, "--advisor", "fable", "PROMPT"]);
  assert.deepEqual(calls[1].slice(0, 3), ["claude-x", "agents", "--json"]);
});

test("a listed session is resumed BARE; an unlisted one gets its options again", () => {
  const b = createBinding({ exec: fakeExec({ launch: launchLine, agents: registry }).exec, sleep: () => {} });
  assert.deepEqual(b.dryRun.resumeArgv("full-id-1", { listed: true, model: "opus", name: "n" }), ["--bg", "--resume", "full-id-1", RESUME_NUDGE]);
  assert.deepEqual(b.dryRun.resumeArgv("full-id-1", { listed: false, model: "opus", name: "n" }), ["--bg", "-n", "n", "--model", "opus", "--permission-mode", "auto", "--append-system-prompt", SYSTEM_APPEND, "--resume", "full-id-1", RESUME_NUDGE]);
  const r = b.resume("full-id-1", { listed: true, model: "opus", name: "n", cwd: "/p" });
  assert.equal(r.sessionId, "full-id-1");
});

test("a spawn error names the binary instead of a null exit", () => {
  const enoent = () => ({ status: null, stdout: undefined, stderr: undefined, error: Object.assign(new Error("spawn claude-x ENOENT"), { code: "ENOENT" }) });
  const b = createBinding({ claudePath: "claude-x", exec: enoent, sleep: () => {} });
  assert.throws(() => b.launch("P", { model: "m", name: "n", cwd: "/p" }), /spawn claude-x ENOENT/);
  assert.throws(() => b.status({ shortId: "x", sessionId: null }), /cannot run claude-x: .*ENOENT.*local\.json/);
});

test("launch failure throws with the CLI's words", () => {
  const b = createBinding({ exec: (c, a) => ({ status: 1, stdout: "", stderr: "unknown flag --bg" }), sleep: () => {} });
  assert.throws(() => b.launch("P", { model: "m", name: "n", cwd: "/p" }), /unknown flag --bg/);
});

test("status, stop and attachHint go through the registry", () => {
  const { exec, calls } = fakeExec({ agents: registry });
  const b = createBinding({ claudePath: "claude", exec, alive: () => true }); // explicit: the default resolves ~/.local/bin/claude.exe on Windows
  assert.deepEqual(b.status({ shortId: "9c1e02aa", sessionId: null }).kind, "running");
  assert.equal(b.status({ shortId: "nope", sessionId: "nope" }).listed, false);
  b.stop({ shortId: "9c1e02aa", sessionId: "full-id-1" });
  assert.deepEqual(calls.at(-1), ["claude", "stop", "9c1e02aa"]);
  assert.match(b.attachHint({ shortId: "9c1e02aa" }), /^claude attach 9c1e02aa/);
});

test("read finds the transcript across project shards", () => {
  const projects = mkdtempSync(join(tmpdir(), "rider-projects-"));
  mkdirSync(join(projects, "D--some-proj"));
  writeFileSync(join(projects, "D--some-proj", "full-id-1.jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "STATUS: planned" }] } }));
  const b = createBinding({ projectsDir: projects, exec: () => ({ stdout: "[]" }) });
  const h = b.read({ shortId: "x", sessionId: "full-id-1" });
  assert.equal(h.lastText, "STATUS: planned");
  assert.equal(h.transcript, join(projects, "D--some-proj", "full-id-1.jsonl"));
  assert.equal(b.read({ shortId: "x", sessionId: "missing" }).transcript, null);
  rmSync(projects, { recursive: true, force: true });
});
