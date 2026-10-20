// test/cli.test.mjs — end to end through the real CLI with the file-persisted fake binding
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntryPoint, parseCli } from "../scripts/rider.mjs";
import { AWAIT_PROMPTS, AWAIT_RIDER_MD, tmpProject } from "./helpers.mjs";

const RIDER = fileURLToPath(new URL("../scripts/rider.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-binding.mjs", import.meta.url));

test("parseCli", () => {
  assert.deepEqual(parseCli(["next", "code green", "--because", "why", "--json"]), { verb: "next", args: ["code green"], flags: { because: "why", json: true } });
  assert.deepEqual(parseCli([]), { verb: "status", args: [], flags: {} });
  assert.throws(() => parseCli(["--bogus"]));
  // a --because value may start with a dash: parseArgs alone calls that ambiguous and refuses
  assert.deepEqual(parseCli(["next", "blocked", "--because", "-x is missing"]), { verb: "next", args: ["blocked"], flags: { because: "-x is missing" } });
  assert.deepEqual(parseCli(["next", "blocked", "--because", "--json"]), { verb: "next", args: ["blocked"], flags: { because: "--json" } });
  assert.deepEqual(parseCli(["next", "blocked", "--because=-x"]), { verb: "next", args: ["blocked"], flags: { because: "-x" } });
  assert.throws(() => parseCli(["next", "blocked", "--because"]), /argument missing/); // a trailing flag still refuses
});

test("isEntryPoint recognises the script it is asked about", () => {
  const url = pathToFileURL(RIDER).href;
  assert.equal(isEntryPoint(url, RIDER), true);
  assert.equal(isEntryPoint(url, FAKE), false);
  assert.equal(isEntryPoint(url, undefined), false);
  assert.equal(isEntryPoint(url, join(RIDER, "..", "no-such-file.mjs")), false); // an unresolvable path must not throw
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
  const on = () => json("status").v.key; // the key a decision on the current stretch names (§8)
  assert.equal(json("status").v.state, "none");
  assert.equal(json("start").v.state, "running");
  assert.equal(json("next", "planned", "--on", on()).code, 2);
  assert.equal(json("check").v.state, "done");
  assert.match(run("check").out, /state: done/);
  assert.equal(json("next", "planned", "--because", "ok", "--on", on()).v.phase, "build");
  assert.equal(json("check").v.state, "done");
  assert.equal(json("next", "code green", "--because", "ok", "--on", on()).v.phase, "close");
  assert.equal(json("check").v.state, "done");
  assert.equal(json("next", "gate green", "--because", "ok", "--on", on()).v.state, "human");
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

test("overrule through the CLI: the run the judge stopped is the run that reaches the human phase", () => {
  const p = tmpProject();
  const state = join(p.root, "fake-state.json");
  writeFileSync(state, JSON.stringify({ scripts: [{ statuses: ["done"], read: { lastText: "STATUS: gate green\n<promise>X</promise>", turns: 5, cost: 3 } }] }));
  const env = { ...process.env, RIDER_BINDING: FAKE, RIDER_FAKE_STATE: state, RIDER_NO_WATCHER: "1" };
  const run = (...args) => { const r = spawnSync(process.execPath, [RIDER, ...args], { cwd: p.root, env, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const json = (...args) => { const r = run(...args, "--json"); return { ...r, v: JSON.parse(r.out) }; };
  const started = json("start", "close").v;
  assert.equal(json("check").v.state, "done");
  assert.equal(json("next", "operator", "--because", "asked for a ruling", "--on", `${started.runId}.1`).v.state, "operator");
  // What 842b's judge told the operator to run. A start may enter a gate now (§6.2), but as a fresh run: this run
  // reaches it only by overrule.
  assert.match(run("start", "merge", "--dry-run").out, /^\[dry-run\] merge \(human\): test -f merged\.flag\nentry: merge by operator$/m);
  assert.match(run("status").out, /rider overrule "<label>" --because "…"[^\n]*\(gate green\)/);
  assert.equal(run("overrule", "gate green", "--on", started.runId).code, 2);
  const ruled = json("overrule", "gate green", "--because", "the in-place fix stands", "--on", started.runId);
  assert.deepEqual([ruled.code, ruled.v.state, ruled.v.phase, ruled.v.runId], [0, "human", "merge", started.runId]);
  assert.deepEqual(json("status").v.transitions.map((t) => t.by ?? "judge"), ["judge", "operator"]);
  assert.match(run("--help").out, /rider overrule <label> --because/);
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
  assert.deepEqual([several.status, /several riders here: .* — pass --rider <directory name>/.test(several.stderr)], [2, true]);
  const picked = at(p.root, "status", "--rider", "lemmaria");
  assert.deepEqual([picked.status, /no active run/.test(picked.stdout)], [0, true]);
  const bad = at(p.root, "await", "--rider", "lemmaria", "--max-minutes", "abc");
  assert.deepEqual([bad.status, /--max-minutes must be a positive number/.test(bad.stderr)], [2, true]);
  const nobinding = at(p.root, "status", "--rider", "lemmaria", "--binding", "./does-not-exist.mjs", "--json");
  assert.deepEqual([nobinding.status, JSON.parse(nobinding.stdout).ok], [2, false]);
  p.cleanup();
});

test("every verb refuses state from an older executor, and leaves a guard against one", () => {
  const p = tmpProject();
  const at = (...args) => spawnSync(process.execPath, [RIDER, ...args], { cwd: p.root, encoding: "utf8", env: { ...process.env, RIDER_NO_WATCHER: "1" } });
  const v3Run = join(p.root, ".rider", "lemmaria", "run.json");
  try {
    // A fresh project: the first verb leaves a directory where an older executor looks for its run, so that one fails.
    assert.equal(at("status").status, 0);
    assert.equal(statSync(v3Run).isDirectory(), true);
    assert.equal(at("status").status, 0, "and the guard is not mistaken for old state");
    assert.equal(existsSync(join(p.root, ".rider", "lemmaria", "default", "state.json")), false, "status writes no state");
  } finally { p.cleanup(); }
  const q = tmpProject();
  const atQ = (...args) => spawnSync(process.execPath, [RIDER, ...args], { cwd: q.root, encoding: "utf8", env: { ...process.env, RIDER_NO_WATCHER: "1" } });
  try {
    mkdirSync(join(q.root, ".rider", "lemmaria"), { recursive: true });
    writeFileSync(join(q.root, ".rider", "lemmaria", "run.json"), "{}");
    for (const verb of ["status", "start", "check"]) {
      const r = atQ(verb);
      assert.equal(r.status, 2, verb);
      assert.match(r.stderr, /state from an older claude-rider/, verb);
    }
    assert.equal(existsSync(join(q.root, ".rider", "lemmaria", "default")), false, "nothing was written beside it");
  } finally { q.cleanup(); }
});

test("an entry that lands on an await phase exits 0 and prints the awaiting line", (t) => {
  const p = tmpProject({ riderMd: AWAIT_RIDER_MD, prompts: AWAIT_PROMPTS });
  t.after(p.cleanup);
  const state = join(p.root, "fake-state.json");
  writeFileSync(state, JSON.stringify({ scripts: [] }));
  const env = { ...process.env, RIDER_BINDING: FAKE, RIDER_FAKE_STATE: state, RIDER_NO_WATCHER: "1" };
  const run = (...args) => { const r = spawnSync(process.execPath, [RIDER, ...args], { cwd: p.root, env, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const r = run("start", "wait");
  assert.deepEqual([r.code, r.err], [0, ""]);
  const [first, second] = r.out.trimEnd().split("\n");
  assert.match(first, /^wait awaiting: \$ test -f ready\.flag \|\| exit 75 every 60 s until \d{4}-\d\d-\d\dT[\d:.]+Z$/);
  const runId = /^visit 1 of run ([0-9a-f]{4}) · stretch \1\.1$/.exec(second)?.[1];
  assert.ok(runId, second);
  const st = run("status");
  assert.equal(st.code, 0);
  assert.match(st.out, /^state: awaiting /m);
  assert.match(st.out, /^wait: \$ test -f ready\.flag \|\| exit 75 · 0 polls · no poll yet · deadline /m);
  const refused = run("next", "settled", "--on", `${runId}.1`);
  assert.equal(refused.code, 2);
  assert.match(refused.out, /^refused: wait is awaiting its check \(poll 0, last exit none\): only the operator ends a wait early/);
});
