// test/watcher-spawn.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instancePaths } from "../scripts/lib/store.mjs";
import { ensureWatcher, killWatcher, watcherAlive, writeWatchPid } from "../scripts/lib/watcher-spawn.mjs";

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 777, unref() { calls.push("unref"); } }; };
  return { spawn, calls };
}

test("no spawn while the pid file names a live process; spawn detached when stale", () => {
  const root = mkdtempSync(join(tmpdir(), "rider-watch-"));
  const paths = instancePaths(root, "lemmaria", "default");
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.watchPid, "4242");
  const { spawn, calls } = fakeSpawn();
  assert.equal(ensureWatcher(paths, { riderName: "lemmaria", instance: "default", root, script: "/x/rider.mjs", alive: (p) => p === 4242, spawn }), false);
  assert.equal(calls.length, 0);
  assert.equal(watcherAlive(paths, (p) => p === 4242), 4242);
  assert.equal(ensureWatcher(paths, { riderName: "lemmaria", instance: "default", root, script: "/x/rider.mjs", alive: () => false, spawn }), true);
  assert.equal(readFileSync(paths.watchPid, "utf8").trim(), "777");
  const c = calls[0];
  assert.equal(c.cmd, process.execPath);
  assert.deepEqual(c.args, ["/x/rider.mjs", "watch", "--rider", "lemmaria", "--instance", "default"]);
  assert.equal(c.opts.detached, true);
  assert.equal(c.opts.cwd, root);
  assert.equal(c.opts.windowsHide, true);
  assert.equal(calls[1], "unref");
  assert.equal(watcherAlive(paths, () => false), null);
  killWatcher(paths, () => false);
  assert.equal(watcherAlive(paths, () => true), null);
  rmSync(root, { recursive: true, force: true });
});

test("watch.pid is replaced by a rename, never rewritten in place", () => {
  // A lock-free reader (board, status, await) must never see the file truncated and not yet written: a new inode
  // means the old file was renamed over whole.
  const root = mkdtempSync(join(tmpdir(), "rider-watch-"));
  try {
    const paths = instancePaths(root, "lemmaria", "default");
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.watchPid, "4242");
    const before = statSync(paths.watchPid).ino;
    assert.equal(ensureWatcher(paths, { riderName: "lemmaria", instance: "default", root, script: "/x/rider.mjs", alive: () => false, spawn: fakeSpawn().spawn }), true);
    assert.notEqual(statSync(paths.watchPid).ino, before, "ensureWatcher");
    assert.equal(watcherAlive(paths, (p) => p === 777), 777);
    // The watcher's own write of its pid, when it starts.
    const spawned = statSync(paths.watchPid).ino;
    writeWatchPid(paths, 778);
    assert.notEqual(statSync(paths.watchPid).ino, spawned, "writeWatchPid");
    assert.equal(watcherAlive(paths, (p) => p === 778), 778);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the watcher is spawned per instance", () => {
  const root = mkdtempSync(join(tmpdir(), "rider-watch-"));
  try {
    const calls = [];
    let pid = 776;
    const spawn = (cmd, args) => { calls.push(args); return { pid: ++pid, unref() {} }; };
    const a = instancePaths(root, "lemmaria", "a");
    const b = instancePaths(root, "lemmaria", "b");
    assert.equal(ensureWatcher(a, { riderName: "lemmaria", instance: "a", root, script: "/x/rider.mjs", alive: () => false, spawn }), true);
    assert.deepEqual(calls[0].slice(-5), ["watch", "--rider", "lemmaria", "--instance", "a"]);
    assert.equal(readFileSync(join(root, ".rider", "lemmaria", "a", "watch.pid"), "utf8").trim(), "777");
    // a's live watcher watches a only: b still gets its own
    const alive = (p) => p === 777;
    assert.equal(ensureWatcher(b, { riderName: "lemmaria", instance: "b", root, script: "/x/rider.mjs", alive, spawn }), true);
    assert.deepEqual(calls[1].slice(-5), ["watch", "--rider", "lemmaria", "--instance", "b"]);
    assert.equal(readFileSync(join(root, ".rider", "lemmaria", "b", "watch.pid"), "utf8").trim(), "778");
    assert.equal(ensureWatcher(a, { riderName: "lemmaria", instance: "a", root, script: "/x/rider.mjs", alive, spawn }), false);
    assert.equal(calls.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a watch.pid written before the boot reads as dead, even when its pid is alive", () => {
  // After a reboot the pid can name an unrelated process: the wait would never be polled while the board shows running.
  const root = mkdtempSync(join(tmpdir(), "rider-watch-"));
  try {
    const paths = instancePaths(root, "lemmaria", "default");
    writeWatchPid(paths, process.pid);
    const bootMs = Date.now() - 60_000;
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(paths.watchPid, hourAgo, hourAgo);
    assert.equal(watcherAlive(paths, () => true, { bootMs }), null);
    // Within the slack of the boot, the file is not misread as written before it.
    const justBefore = new Date(bootMs - 1000);
    utimesSync(paths.watchPid, justBefore, justBefore);
    assert.equal(watcherAlive(paths, () => true, { bootMs }), process.pid);
    const fresh = new Date();
    utimesSync(paths.watchPid, fresh, fresh);
    assert.equal(watcherAlive(paths, () => true, { bootMs }), process.pid);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
