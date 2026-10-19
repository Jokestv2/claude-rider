// test/watcher-spawn.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instancePaths } from "../scripts/lib/store.mjs";
import { ensureWatcher, killWatcher, watcherAlive } from "../scripts/lib/watcher-spawn.mjs";

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
  assert.equal(readFileSync(paths.watchPid, "utf8"), "777");
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
