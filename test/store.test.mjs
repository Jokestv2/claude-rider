// test/store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, appendEvent, emptyState, endedRunPath, guardV3, instancePaths, readEvents, readJson, readState, riderPaths, WAKE_KINDS, writeJsonAtomic, writeState } from "../scripts/lib/store.mjs";
import { status } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, makeCtx, tmpProject } from "./helpers.mjs";

const now = new Date("2026-10-19T12:00:00Z");
const tmpRoot = () => mkdtempSync(join(tmpdir(), "rider-store-"));
const lockAt = (paths, holder) => { mkdirSync(paths.dir, { recursive: true }); writeFileSync(paths.lock, typeof holder === "string" ? holder : JSON.stringify(holder)); };

test("paths: one directory per instance under the rider's, laid out as §6", () => {
  const rp = riderPaths("/p", "lemmaria");
  assert.deepEqual(rp, { dir: join("/p", ".rider", "lemmaria"), local: join("/p", ".rider", "lemmaria", "local.json"), v3Run: join("/p", ".rider", "lemmaria", "run.json") });
  const d = join("/p", ".rider", "lemmaria", "alpha");
  assert.deepEqual(instancePaths("/p", "lemmaria", "alpha"), {
    rider: "lemmaria", instance: "alpha", dir: d, state: join(d, "state.json"), events: join(d, "events.jsonl"), runs: join(d, "runs"),
    logs: join(d, "logs"), watchPid: join(d, "watch.pid"), watchLog: join(d, "logs", "watch.log"), lock: join(d, "lock"),
    checkPid: join(d, "check.pid"), checkOut: join(d, "logs", "check.out"),
  });
  assert.equal(endedRunPath(instancePaths("/p", "lemmaria", "alpha"), { runId: "ab12", startedAt: "2026-10-19T12:00:00.000Z" }), join(d, "runs", "2026-10-19T12-00-00-000Z-ab12.json"));
  assert.deepEqual(WAKE_KINDS, ["done", "gone", "waiting", "intervened", "rate-limited", "watcher-stopped"]);
  assert.deepEqual(emptyState({ rider: "lemmaria", instance: "alpha", scope: "nodes/alpha" }), { schema: 5, rider: "lemmaria", instance: "alpha", scope: "nodes/alpha", version: 0, updatedAt: null, run: null, lastRun: null });
});

test("state is written atomically: version counts writes, no temp file is left", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  assert.equal(readState(paths), null);
  const state = writeState(paths, emptyState({ rider: "lemmaria", instance: "default", scope: "." }), now);
  assert.deepEqual([state.schema, state.version, state.updatedAt], [5, 1, now.toISOString()]);
  writeState(paths, readState(paths), new Date("2026-10-19T12:05:00Z"));
  const back = readState(paths);
  assert.equal(back.version, 2);
  assert.equal(back.updatedAt, "2026-10-19T12:05:00.000Z");
  assert.deepEqual(readdirSync(paths.dir).filter((f) => f.endsWith(".tmp")), []);
  rmSync(root, { recursive: true, force: true });
});

test("a rename that fails with EPERM is retried, then succeeds", () => {
  const root = tmpRoot();
  const target = join(root, "deep", "x.json");
  let failures = 2;
  const slept = [];
  const rename = (from, to) => { if (failures-- > 0) throw Object.assign(new Error("x"), { code: "EPERM" }); renameSync(from, to); };
  writeJsonAtomic(target, { a: 1 }, { rename, sleep: (ms) => slept.push(ms) });
  assert.deepEqual(readJson(target), { a: 1 });
  assert.deepEqual(slept, [50, 100]);

  // A rename that never succeeds is retried five times, then rethrown, and its temp file goes with it.
  const always = [];
  assert.throws(() => writeJsonAtomic(target, { a: 2 }, { rename: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); }, sleep: (ms) => always.push(ms) }), { code: "EBUSY" });
  assert.deepEqual(always, [50, 100, 200, 400, 800]);
  assert.deepEqual(readJson(target), { a: 1 });
  assert.deepEqual(readdirSync(join(root, "deep")), ["x.json"]);
  rmSync(root, { recursive: true, force: true });
});

test("a state file of another schema is refused, naming the file", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.state, JSON.stringify({ schema: 3 }));
  assert.throws(() => readState(paths), /state\.json.*schema 3/);
  assert.throws(() => readState(paths), /reads schema 4 or 5$/);
  writeFileSync(paths.state, JSON.stringify({ schema: 6 }));
  assert.throws(() => readState(paths), /schema 6, but this executor reads schema 4 or 5$/);
  rmSync(root, { recursive: true, force: true });
});

test("a schema-4 state is read, and rewritten as schema 5 with its fields intact", () => {
  // What 0.2 leaves behind: an active run on a session stretch, written by hand as 0.2's writeState wrote it.
  const p = tmpProject();
  const paths = instancePaths(p.root, "lemmaria", "default");
  const run = {
    rider: "lemmaria", runId: "ab12", startedAt: "2026-10-19T11:00:00.000Z", baseBranch: "main", phase: "build", visits: { plan: 1, build: 1 },
    transitions: [{ at: "2026-10-19T11:30:00.000Z", from: "plan", label: "planned", to: "build", because: "ok", by: "judge" }],
    sessions: [
      { phase: "plan", model: "fable", id: "sess-1", shortId: "s1", resumedFrom: null, resumeReason: null, at: "2026-10-19T11:00:00.000Z", outcome: "done", baselineTurns: 0, watcherSpawns: 1, cost: 0.5, turns: 5 },
      { phase: "build", model: "opus", id: "sess-2", shortId: "s2", resumedFrom: null, resumeReason: null, at: "2026-10-19T11:30:00.000Z", outcome: "running", baselineTurns: 0, watcherSpawns: 1 },
    ],
    notes: [], workBranch: "feature/x",
  };
  const lastRun = { runId: "cd34", phase: "plan", startedAt: "2026-10-18T09:00:00.000Z", endedAt: "2026-10-18T09:30:00.000Z", endedBy: "reset", reason: "rider reset", totalCost: 0.2, overrulable: [] };
  const v4 = { schema: 4, rider: "lemmaria", instance: "default", scope: ".", version: 7, updatedAt: "2026-10-19T11:30:00.000Z", run, lastRun };
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.state, `${JSON.stringify(v4, null, 2)}\n`);
  assert.deepEqual(readState(paths), v4, "read as it stands");
  const st = status(makeCtx({ root: p.root, binding: new FakeBinding({ script: [] }) }));
  assert.deepEqual([st.state, st.runId, st.phase, st.key, st.lastRun], ["running", "ab12", "build", "ab12.2", lastRun], "status reads it as it stands");
  assert.equal(readState(paths).schema, 4, "a read writes nothing");
  writeState(paths, readState(paths), now);
  assert.deepEqual(readState(paths), { ...v4, schema: 5, version: 8, updatedAt: now.toISOString() });
  p.cleanup();
});

test("0.2's readState refuses a state 0.3 wrote", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  // 0.2's readState, as it shipped: a stale 0.2 executor reads state.json this way on every verb.
  const v02ReadState = (paths) => {
    const state = readJson(paths.state, null);
    if (state === null) return null;
    if (state?.schema !== 4) throw new Error(`${paths.state}: schema ${JSON.stringify(state?.schema) ?? "missing"}, but this executor reads schema 4`);
    return state;
  };
  writeState(paths, emptyState({ rider: "lemmaria", instance: "default", scope: "." }), now);
  assert.throws(() => v02ReadState(paths), /state\.json: schema 5, but this executor reads schema 4$/);
  // A schema-4 state rewritten by 0.3 is shut to 0.2 from then on.
  writeFileSync(paths.state, JSON.stringify({ schema: 4, rider: "lemmaria", instance: "default", scope: ".", version: 1, updatedAt: null, run: null, lastRun: null }));
  assert.equal(v02ReadState(paths).schema, 4);
  writeState(paths, readState(paths), now);
  assert.throws(() => v02ReadState(paths), /schema 5/);
  rmSync(root, { recursive: true, force: true });
});

test("events get seq from 1; a torn last line is skipped and the next append starts a fresh line", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "alpha");
  assert.deepEqual(readEvents(paths), []);
  const first = appendEvent(paths, { runId: "ab12", kind: "run-started", phase: "plan" }, now);
  assert.deepEqual(first, { seq: 1, at: now.toISOString(), rider: "lemmaria", instance: "alpha", runId: "ab12", kind: "run-started", phase: "plan", key: null, text: "" });
  appendEvent(paths, { runId: "ab12", kind: "phase-entered", phase: "plan" }, now);
  appendFileSync(paths.events, '{"seq":3,"at');
  assert.deepEqual(readEvents(paths).map((e) => e.seq), [1, 2]);
  const third = appendEvent(paths, { runId: "ab12", kind: "done", phase: "plan", key: "ab12.1", text: "STATUS: planned\nsecond line" }, now);
  assert.equal(third.seq, 3);
  assert.deepEqual(readEvents(paths).map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(readEvents(paths).at(-1), third);
  assert.equal(readFileSync(paths.events, "utf8").split("\n").length, 5, "two events, the torn line, the third event, and the final newline");
  rmSync(root, { recursive: true, force: true });
});

test("an event keeps cause only when given", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "alpha");
  const plain = appendEvent(paths, { runId: "ab12", kind: "decided", phase: "plan", key: "ab12.1", text: "planned → build", by: "judge" }, now);
  const refused = appendEvent(paths, { kind: "refused", phase: "plan", text: "intake check failed (exit 1): x", by: "judge", cause: "intake" }, now);
  assert.equal("cause" in plain, false);
  assert.deepEqual(refused, { seq: 2, at: now.toISOString(), rider: "lemmaria", instance: "alpha", runId: null, kind: "refused", phase: "plan", key: null, text: "intake check failed (exit 1): x", by: "judge", cause: "intake" });
  assert.deepEqual(readEvents(paths), [plain, refused], "on file as returned");
  assert.equal("cause" in readEvents(paths)[0], false);
  rmSync(root, { recursive: true, force: true });
});

test("a lock whose holder is dead on this host is broken", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  lockAt(paths, { pid: 999999, host: hostname(), at: now.toISOString(), nonce: "x" });
  const release = acquireLock(paths, { alive: () => false, timeoutMs: 0 });
  const holder = JSON.parse(readFileSync(paths.lock, "utf8"));
  assert.notEqual(holder.nonce, "x");
  assert.deepEqual([holder.pid, holder.host], [process.pid, hostname()]);
  assert.deepEqual(readdirSync(paths.dir), ["lock"], "the stale lock moved aside is gone");
  release();
  assert.equal(existsSync(paths.lock), false);
  rmSync(root, { recursive: true, force: true });
});

test("a lock held by a live pid refuses after the timeout, naming pid, host and time", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  lockAt(paths, { pid: process.pid, host: hostname(), at: now.toISOString(), nonce: "x" });
  const clock = new FakeClock();
  assert.throws(() => acquireLock(paths, { timeoutMs: 1000, now: clock.now, sleep: clock.sleep }), /locked by pid \d+ on .+ since /);
  assert.deepEqual(clock.slept, [200, 200, 200, 200, 200]);
  assert.equal(JSON.parse(readFileSync(paths.lock, "utf8")).nonce, "x");
  rmSync(root, { recursive: true, force: true });
});

test("a lock from another host is never broken", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  lockAt(paths, { pid: 999999, host: "elsewhere", at: now.toISOString(), nonce: "x" });
  assert.throws(() => acquireLock(paths, { alive: () => false, timeoutMs: 0 }), /on elsewhere/);
  assert.equal(JSON.parse(readFileSync(paths.lock, "utf8")).nonce, "x");
  rmSync(root, { recursive: true, force: true });
});

test("a same-host lock taken before the boot is broken although its pid is alive", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  lockAt(paths, { pid: process.pid, host: hostname(), at: now.toISOString(), nonce: "x", wallAt: Date.now() - 3_600_000 });
  const release = acquireLock(paths, { bootMs: Date.now() - 60_000, timeoutMs: 0 });
  const holder = JSON.parse(readFileSync(paths.lock, "utf8"));
  assert.notEqual(holder.nonce, "x");
  assert.ok(Date.now() - holder.wallAt >= 0 && Date.now() - holder.wallAt < 5000, `wallAt ${holder.wallAt} is the real clock's now`);
  release();
  assert.equal(existsSync(paths.lock), false);
  rmSync(root, { recursive: true, force: true });
});

test("a same-host lock taken since the boot, by a live pid, is not broken", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  const bootMs = Date.now() - 60_000;
  // Within the slack of the boot, a lock is not misread as written before it.
  for (const wallAt of [Date.now() - 30_000, bootMs - 1000]) {
    lockAt(paths, { pid: process.pid, host: hostname(), at: now.toISOString(), nonce: "x", wallAt });
    const clock = new FakeClock();
    assert.throws(() => acquireLock(paths, { bootMs, timeoutMs: 1000, now: clock.now, sleep: clock.sleep }), /locked by pid/);
    assert.equal(JSON.parse(readFileSync(paths.lock, "utf8")).nonce, "x");
  }
  rmSync(root, { recursive: true, force: true });
});

test("a pre-boot lock from another host is still never broken", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  lockAt(paths, { pid: process.pid, host: "elsewhere", at: now.toISOString(), nonce: "x", wallAt: Date.now() - 3_600_000 });
  assert.throws(() => acquireLock(paths, { bootMs: Date.now() - 60_000, timeoutMs: 0 }), /on elsewhere/);
  assert.equal(JSON.parse(readFileSync(paths.lock, "utf8")).nonce, "x");
  rmSync(root, { recursive: true, force: true });
});

test("a lock with no wallAt falls back to the pid test", () => {
  // A lock written by 0.2 records no real-clock write time: a live pid holds it, a dead one does not.
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  lockAt(paths, { pid: process.pid, host: hostname(), at: now.toISOString(), nonce: "x" });
  const clock = new FakeClock();
  assert.throws(() => acquireLock(paths, { bootMs: Date.now() - 60_000, timeoutMs: 1000, now: clock.now, sleep: clock.sleep }), /locked by pid/);
  assert.equal(JSON.parse(readFileSync(paths.lock, "utf8")).nonce, "x");
  const release = acquireLock(paths, { bootMs: Date.now() - 60_000, alive: () => false, timeoutMs: 0 });
  assert.notEqual(JSON.parse(readFileSync(paths.lock, "utf8")).nonce, "x");
  release();
  rmSync(root, { recursive: true, force: true });
});

test("an empty lock file is waited on, not broken", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  lockAt(paths, "");
  assert.throws(() => acquireLock(paths, { alive: () => false, timeoutMs: 0 }), /locked by pid \? on \? since \? .*names no holder/);
  assert.ok(existsSync(paths.lock));
  assert.equal(readFileSync(paths.lock, "utf8"), "");
  rmSync(root, { recursive: true, force: true });
});

test("release removes only its own lock", () => {
  const root = tmpRoot();
  const paths = instancePaths(root, "lemmaria", "default");
  const release = acquireLock(paths);
  lockAt(paths, { pid: process.pid, host: hostname(), at: now.toISOString(), nonce: "another" });
  release();
  assert.ok(existsSync(paths.lock));
  assert.equal(JSON.parse(readFileSync(paths.lock, "utf8")).nonce, "another");
  rmSync(root, { recursive: true, force: true });
});

test("eight processes writing through the lock lose no update", { timeout: 30_000 }, async () => {
  const root = tmpRoot();
  const store = new URL("../scripts/lib/store.mjs", import.meta.url).href;
  const proc = new URL("../scripts/lib/proc.mjs", import.meta.url).href;
  // The sleep inside the hold widens the read-modify-write window: without the lock, updates are lost.
  const script = (i) => `
    import { acquireLock, emptyState, instancePaths, readState, writeState } from ${JSON.stringify(store)};
    import { sleepSync } from ${JSON.stringify(proc)};
    const paths = instancePaths(${JSON.stringify(root)}, "lemmaria", "default");
    const release = acquireLock(paths, { retryMs: 10, timeoutMs: 10_000 });
    try {
      const state = readState(paths) ?? emptyState({ rider: "lemmaria", instance: "default", scope: "." });
      const probe = state.probe ?? [];
      sleepSync(20);
      state.probe = [...probe, ${i}];
      writeState(paths, state, new Date());
    } finally { release(); }
  `;
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script(i)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ i, code, stderr }));
  })));
  for (const r of results) assert.equal(r.code, 0, `child ${r.i}: ${r.stderr}`);
  const state = readState(instancePaths(root, "lemmaria", "default"));
  assert.deepEqual([...state.probe].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(state.version, 8);
  rmSync(root, { recursive: true, force: true });
});

test("the v3 guard: a directory at run.json, ignored by v4, fatal to a v3 read", () => {
  const root = tmpRoot();
  const rp = riderPaths(root, "lemmaria");
  guardV3(rp);
  assert.ok(statSync(rp.v3Run).isDirectory());
  assert.match(readFileSync(join(rp.v3Run, "README"), "utf8"), /<instance>\/state\.json/);
  guardV3(rp);
  // v3's readJson, as it shipped: a v3 executor reads run.json this way on every verb.
  const v3ReadJson = (path, fallback = null) => { if (!existsSync(path)) return fallback; return JSON.parse(readFileSync(path, "utf8")); };
  assert.throws(() => v3ReadJson(rp.v3Run), (e) => e.code === "EISDIR");
  rmSync(root, { recursive: true, force: true });
});

test("v3 state is refused with what to do", () => {
  const root = tmpRoot();
  const rp = riderPaths(root, "lemmaria");
  mkdirSync(rp.dir, { recursive: true });
  writeFileSync(rp.v3Run, JSON.stringify({ rider: "lemmaria", runId: "ab12", phase: "build" }));
  assert.throws(() => guardV3(rp), /finish or reset/i);
  assert.throws(() => guardV3(rp), /\.rider\/lemmaria\//);
  assert.ok(statSync(rp.v3Run).isFile(), "the v3 state is left as it was");
  rmSync(root, { recursive: true, force: true });
});
