// test/cli.test.mjs — end to end through the real CLI with the file-persisted fake binding
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCli } from "../scripts/rider.mjs";
import { tmpProject } from "./helpers.mjs";

const RIDER = fileURLToPath(new URL("../scripts/rider.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-binding.mjs", import.meta.url));

test("parseCli", () => {
  assert.deepEqual(parseCli(["next", "code green", "--because", "why", "--json"]), { verb: "next", args: ["code green"], flags: { because: "why", json: true } });
  assert.deepEqual(parseCli([]), { verb: "status", args: [], flags: {} });
  assert.throws(() => parseCli(["--bogus"]));
});

test("start → check → next → … → human check through the CLI, --json and text", () => {
  const p = tmpProject();
  const state = join(p.root, "fake-state.json");
  const GREEN = (s) => `STATUS: ${s}\n<promise>X</promise>`;
  writeFileSync(state, JSON.stringify({ scripts: [
    { statuses: ["done"], read: { lastText: GREEN("planned"), cost: 1 } },
    { statuses: ["done"], read: { lastText: GREEN("code green"), cost: 2 } },
    { statuses: ["done"], read: { lastText: GREEN("gate green"), cost: 3 } },
  ] }));
  const env = { ...process.env, RIDER_BINDING: FAKE, RIDER_FAKE_STATE: state, RIDER_NO_WATCHER: "1" };
  const run = (...args) => { const r = spawnSync(process.execPath, [RIDER, ...args], { cwd: p.root, env, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const json = (...args) => { const r = run(...args, "--json"); return { ...r, v: JSON.parse(r.out) }; };
  assert.equal(json("status").v.state, "none");
  assert.equal(json("start").v.state, "running");
  assert.equal(json("next", "planned").code, 2);
  assert.equal(json("check").v.state, "done");
  assert.match(run("check").out, /state: done/);
  assert.equal(json("next", "planned", "--because", "ok").v.phase, "build");
  assert.equal(json("check").v.state, "done");
  assert.equal(json("next", "code green", "--because", "ok").v.phase, "close");
  assert.equal(json("check").v.state, "done");
  assert.equal(json("next", "gate green", "--because", "ok").v.state, "human");
  assert.equal(json("status").v.state, "human");
  assert.equal(json("await").v.reason, "phase merge is a human phase");
  assert.equal(json("check").v.state, "human");
  writeFileSync(join(p.root, "merged.flag"), "");
  assert.equal(json("check").v.state, "none");
  assert.equal(json("status").v.lastRun.endedBy, "done");
  assert.equal(json("status").v.lastRun.totalCost, 6);
  assert.equal(run("bogus").code, 2);
  assert.match(run("--help").out, /rider start \[phase\]/);
  p.cleanup();
});

test("no rider, several riders, --rider selection, and the failures before dispatch", () => {
  const p = tmpProject();
  const at = (cwd, ...args) => spawnSync(process.execPath, [RIDER, ...args], { cwd, encoding: "utf8", env: { ...process.env, RIDER_NO_WATCHER: "1" } });
  const r = at(join(p.root, "riders"), "status");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no riders\/\*\/RIDER\.md/);
  const nosuch = at(p.root, "status", "--rider", "nosuch");
  assert.deepEqual([nosuch.status, /no rider named nosuch; have: lemmaria/.test(nosuch.stderr)], [2, true]);
  mkdirSync(join(p.root, "riders", "other"));
  writeFileSync(join(p.root, "riders", "other", "RIDER.md"), "---\nname: other\n---\n");
  const several = at(p.root, "status");
  assert.deepEqual([several.status, /several riders here: .* — pass --rider <name>/.test(several.stderr)], [2, true]);
  const picked = at(p.root, "status", "--rider", "lemmaria");
  assert.deepEqual([picked.status, /no active run/.test(picked.stdout)], [0, true]);
  const bad = at(p.root, "await", "--rider", "lemmaria", "--max-minutes", "abc");
  assert.deepEqual([bad.status, /--max-minutes must be a positive number/.test(bad.stderr)], [2, true]);
  const nobinding = at(p.root, "status", "--rider", "lemmaria", "--binding", "./does-not-exist.mjs", "--json");
  assert.deepEqual([nobinding.status, JSON.parse(nobinding.stdout).ok], [2, false]);
  p.cleanup();
});
