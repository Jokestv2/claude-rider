// test/instances.test.mjs — several instances of one rider, in one process and through the CLI
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../scripts/lib/check.mjs";
import { next, reset, start } from "../scripts/lib/verbs.mjs";
import { watchLoop } from "../scripts/lib/watch.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { INSTANCE_RIDER_MD, makeCtx, tmpProject, wake } from "./helpers.mjs";

const RIDER = fileURLToPath(new URL("../scripts/rider.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-binding.mjs", import.meta.url));
const GREEN = (s) => `STATUS: ${s}\n<promise>X</promise>`;

test("two instances run independently: separate state, events, runs and watchers", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a", "b"] });
  t.after(p.cleanup);
  const binding = new FakeBinding({ script: [
    { statuses: ["done"], read: { lastText: GREEN("planned") } },
    { statuses: ["done"], read: { lastText: GREEN("planned") } },
    { statuses: ["done"], read: { lastText: GREEN("code green") } },
  ] });
  const spawned = { a: 0, b: 0 };
  const a = makeCtx({ root: p.root, instance: "a", binding, spawnWatcher: () => { spawned.a++; return true; } });
  const b = makeCtx({ root: p.root, instance: "b", binding, spawnWatcher: () => { spawned.b++; return true; } });
  const ra = start(a);
  const rb = start(b);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true, "a's active run does not refuse b's start");
  const stateOf = (id) => JSON.parse(readFileSync(join(p.root, ".rider", "lemmaria", id, "state.json"), "utf8"));
  assert.deepEqual([stateOf("a").instance, stateOf("a").scope, stateOf("a").run.runId], ["a", "nodes/a", ra.runId]);
  assert.deepEqual([stateOf("b").instance, stateOf("b").scope, stateOf("b").run.runId], ["b", "nodes/b", rb.runId]);
  assert.deepEqual(spawned, { a: 1, b: 1 });

  const bVersion = stateOf("b").version;
  assert.equal(check(a).state, "done");
  assert.equal(next(a, "planned", { because: "ok" }).phase, "build");
  assert.equal(stateOf("b").version, bVersion, "a's check and next do not write b");
  assert.equal(stateOf("b").run.phase, "plan");
  assert.deepEqual(spawned, { a: 2, b: 1 });

  // Each watcher wakes on its own instance's stretch, in its own events file.
  assert.equal(watchLoop(a, { pollMs: 1000 }).state, "done");
  assert.equal(watchLoop(b, { pollMs: 1000 }).state, "done");
  const wa = wake(a);
  const wb = wake(b);
  assert.deepEqual(wa.map((e) => [e.kind, e.instance, e.runId, e.key]), [["done", "a", ra.runId, `${ra.runId}.2`]]);
  assert.deepEqual(wb.map((e) => [e.kind, e.instance, e.runId, e.key]), [["done", "b", rb.runId, `${rb.runId}.1`]]);
  assert.ok(a.readEvents().every((e) => e.instance === "a"));
  assert.ok(b.readEvents().every((e) => e.instance === "b"));

  // Ending a's run files its record under a only; b's run is still active.
  assert.equal(reset(a).ok, true);
  assert.equal(readdirSync(a.paths.runs).length, 1);
  assert.equal(existsSync(b.paths.runs), false);
  assert.equal(b.loadRun().runId, rb.runId);
});

const cli = (root, env = {}) => (...args) => {
  const r = spawnSync(process.execPath, [RIDER, ...args], { cwd: root, env: { ...process.env, RIDER_NO_WATCHER: "1", ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test("--instance is required for a declared rider, and an unknown id lists the instances", (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a", "b"] });
  t.after(p.cleanup);
  const run = cli(p.root);
  for (const args of [["status"], ["status", "--instance", "zzz"], ["status", "--instance", "default"]]) {
    const r = run(...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err, /lemmaria .*— pass --instance <id>; have: a, b/, args.join(" "));
  }
  assert.match(run("status").err, /declares instances/);
  assert.match(run("status", "--instance", "zzz").err, /no instance "zzz"/);
  const ok = run("status", "--instance", "b");
  assert.deepEqual([ok.code, /no active run/.test(ok.out)], [0, true]);
  assert.equal(existsSync(join(p.root, ".rider", "lemmaria", "zzz")), false, "a refused id leaves no directory");
});

test("an undeclared rider accepts default only", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const run = cli(p.root);
  assert.equal(run("status").code, 0);
  assert.equal(run("status", "--instance", "default").code, 0);
  const r = run("status", "--instance", "a");
  assert.equal(r.code, 2);
  assert.match(r.err, /^lemmaria declares no instances — omit --instance/);
});

test("eight concurrent rider note processes lose no note", async (t) => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a", "b"] });
  t.after(p.cleanup);
  const fake = join(p.root, "fake-state.json");
  // Seeded whole: the fake binding rewrites a file that lacks `sessions` on load, and eight loads would race on it.
  writeFileSync(fake, JSON.stringify({ scripts: [{ statuses: ["running"] }], sessions: {}, n: 0, calls: [] }));
  const env = { ...process.env, RIDER_BINDING: FAKE, RIDER_FAKE_STATE: fake, RIDER_NO_WATCHER: "1" };
  const started = cli(p.root, env)("start", "--instance", "a");
  assert.equal(started.code, 0, started.err);
  const note = (i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RIDER, "note", String(i), "--instance", "a"], { cwd: p.root, env });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ i, code, err }));
  });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => note(i)));
  for (const r of results) assert.equal(r.code, 0, `note ${r.i}: ${r.err}`);
  const state = JSON.parse(readFileSync(join(p.root, ".rider", "lemmaria", "a", "state.json"), "utf8"));
  assert.deepEqual(state.run.notes.map((n) => n.text).sort(), ["0", "1", "2", "3", "4", "5", "6", "7"]);
  const noted = readFileSync(join(p.root, ".rider", "lemmaria", "a", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === "noted");
  assert.equal(new Set(noted.map((e) => e.seq)).size, 8, "every append got its own seq");
});
