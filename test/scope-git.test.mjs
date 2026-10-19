// test/scope-git.test.mjs — git evidence scoped to an instance's directory, and branches on a shared working tree (§11)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../scripts/lib/check.mjs";
import { sh } from "../scripts/lib/shell.mjs";
import { next, start } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, INSTANCE_RIDER_MD, TEST_RIDER_MD, makeCtx, settled, tmpProject } from "./helpers.mjs";

const GATE_GREEN = "Gate record closed.\nSTATUS: gate green\n<promise>GATE GREEN</promise>";
const CLEAN_INTAKE = "intake:\n  - test -z \"$(git status --porcelain)\"\n";
/** The instance rider: its merge is done when the instance's own directory carries the flag. */
const SCOPED_RIDER_MD = INSTANCE_RIDER_MD
  .replace("check: test -f merged.flag", 'check: test -f "$RIDER_SCOPE/merged.flag"')
  .replace("intake:\n  - test -d riders\n", CLEAN_INTAKE);

/** A shared-branch fixture: one repository on `main`, two instance directories and a shared one, each committed on its
 *  own. The identity is the repository's, so nothing depends on the machine's git config. */
function sharedBranch({ riderMd = SCOPED_RIDER_MD, instances = ["a", "b"] } = {}) {
  const p = tmpProject({ riderMd, instances });
  const git = (cmd) => { const r = sh(`git ${cmd}`, { cwd: p.root }); assert.equal(r.status, 0, `git ${cmd}: ${r.output}`); return r.output; };
  const commit = (path, subject) => {
    mkdirSync(join(p.root, path, ".."), { recursive: true });
    writeFileSync(join(p.root, path), subject);
    git(`add -- ${path}`);
    git(`commit -q -m "${subject}"`);
    return git("rev-parse HEAD");
  };
  git("init -q -b main");
  git("config user.name Test");
  git("config user.email test@example.com");
  git("config commit.gpgsign false");
  writeFileSync(join(p.root, ".gitignore"), ".rider/\n");
  git("add .gitignore riders");
  git('commit -q -m "chore: the rider"');
  for (const dir of [...instances.map((id) => `nodes/${id}`), "src"]) commit(`${dir}/README`, `docs: ${dir}`);
  return { ...p, git, commit };
}

/** A context on one instance (null: `default`), with its own fake binding; instances that share a scenario share a clock. */
const on = (p, instance, script, clock = new FakeClock()) => makeCtx({ root: p.root, instance, binding: new FakeBinding({ script }), clock });

test("on a shared branch, handoff.after counts only commits under the instance's directory", () => {
  const p = sharedBranch();
  try {
    const a = on(p, "a", [{ statuses: ["done"], read: { lastText: GATE_GREEN, turns: 5 } }]);
    assert.equal(start(a, { phase: "close" }).ok, true);
    const { key, state } = settled(check, a);
    assert.equal(state, "done");
    assert.equal(next(a, "gate green", { on: key }).state, "human");
    assert.equal(a.loadRun().handoff.tip, p.git("rev-parse HEAD"), "on the base, the handoff is HEAD");

    // Three agents on one branch: this instance's fix, another instance's work, and shared code.
    p.commit("nodes/a/x", "fix: x in a");
    p.commit("nodes/b/y", "feat: y in b");
    p.commit("src/z", "feat: z shared");
    writeFileSync(join(p.root, "nodes", "a", "merged.flag"), "");
    assert.equal(check(a).state, "none");

    const ended = a.lastEndedRun();
    assert.equal(ended.endedBy, "done");
    assert.equal(ended.handoff.after.ref, "main");
    assert.equal(ended.handoff.after.commits.length, 1, ended.handoff.after.commits.join("\n"));
    assert.match(ended.handoff.after.commits[0], /^[0-9a-f]{7,} fix: x in a$/);
  } finally { p.cleanup(); }
});

test("an instance rider never records a work branch; a branch switch is drift on every live run", () => {
  const p = sharedBranch();
  const clock = new FakeClock();
  try {
    const a = on(p, "a", [{ statuses: ["running"] }], clock);
    const b = on(p, "b", [{ statuses: ["running"] }], clock);
    assert.equal(start(a).ok, true);
    assert.equal(start(b).ok, true);
    assert.equal(a.loadRun().baseBranch, "main");

    p.git("checkout -q -b elsewhere");
    for (const ctx of [a, b]) {
      assert.equal(check(ctx).state, "running");
      const run = ctx.loadRun();
      assert.equal(run.branchDrift?.branch, "elsewhere", `${ctx.instance.id}: drift recorded`);
      assert.equal(run.branchDrift.at, clock.now().toISOString());
      assert.equal(run.workBranch, undefined, `${ctx.instance.id}: the tree's branch is not this instance's work`);
      assert.equal(run.workTip, undefined);
      assert.equal(ctx.shellOpts(run).env.RIDER_WORK_BRANCH, "");
      assert.equal(ctx.shellOpts(run).env.RIDER_WORK_TIP, "");
    }

    // The drift keeps the time it was first seen while the tree stays on the same branch.
    const first = a.loadRun().branchDrift.at;
    clock.sleep(60_000);
    check(a);
    assert.deepEqual(a.loadRun().branchDrift, { branch: "elsewhere", at: first });

    p.git("checkout -q main");
    check(a);
    assert.equal(a.loadRun().branchDrift, undefined, "back on the base: no drift");
    assert.equal(a.loadRun().workBranch, undefined);
  } finally { p.cleanup(); }
});

test("RIDER_INSTANCE and RIDER_SCOPE reach intake, evidence, check and show", () => {
  const riderMd = SCOPED_RIDER_MD
    .replace(CLEAN_INTAKE, 'intake:\n  - test "$RIDER_INSTANCE" = a && test "$RIDER_SCOPE" = nodes/a\n')
    .replace("  - echo evidence-ok\n", '  - echo "$RIDER_INSTANCE:$RIDER_SCOPE"\n')
    .replace("show: echo SHOW-OUTPUT", 'show: echo "show-$RIDER_INSTANCE"');
  const p = sharedBranch({ riderMd });
  try {
    // The same intake refuses the other instance: it reads the values, it does not pass vacuously.
    const b = on(p, "b", []);
    assert.match(start(b).error, /^intake check failed/);

    const a = on(p, "a", [{ statuses: ["done"], read: { lastText: GATE_GREEN, turns: 5 } }]);
    assert.equal(start(a, { phase: "close" }).ok, true);
    const r = settled(check, a);
    assert.equal(r.state, "done");
    assert.deepEqual(r.evidence.map((e) => [e.cmd, e.status, e.output]), [['echo "$RIDER_INSTANCE:$RIDER_SCOPE"', 0, "a:nodes/a"]]);

    const entered = next(a, "gate green", { on: r.key });
    assert.equal(entered.state, "human");
    assert.equal(entered.show, "show-a");

    // A flag anywhere but the instance's directory is not this instance's merge.
    writeFileSync(join(p.root, "nodes", "b", "merged.flag"), "");
    const human = check(a);
    assert.equal(human.state, "human");
    assert.equal(human.checkExit, 1);
    assert.equal(human.show, "show-a");
    writeFileSync(join(p.root, "nodes", "a", "merged.flag"), "");
    assert.equal(check(a).state, "none");
    assert.equal(a.lastEndedRun().endedBy, "done");
  } finally { p.cleanup(); }
});

test("a rider without instances keeps v3's work branch, and RIDER_WORK_TIP stays empty on the base", () => {
  const riderMd = TEST_RIDER_MD.replace("intake:\n  - test -d riders\n", CLEAN_INTAKE);
  const p = sharedBranch({ riderMd, instances: [] });
  try {
    const ctx = on(p, null, [{ statuses: ["done"], read: { lastText: GATE_GREEN, turns: 5 } }, { statuses: ["running"] }]);
    assert.equal(ctx.shellOpts(null).env.RIDER_INSTANCE, "default");
    assert.equal(ctx.shellOpts(null).env.RIDER_SCOPE, ".");

    // A run on the base: the handoff is HEAD, and that tip is not a work tip.
    assert.equal(start(ctx, { phase: "close" }).ok, true);
    const { key } = settled(check, ctx);
    assert.equal(next(ctx, "gate green", { on: key }).state, "human");
    const run = ctx.loadRun();
    assert.equal(run.handoff.tip, p.git("rev-parse HEAD"));
    assert.equal(run.workBranch, undefined);
    assert.equal(ctx.shellOpts(run).env.RIDER_WORK_TIP, "", "a handoff tip is not a work tip");
    assert.equal(ctx.shellOpts(run).env.RIDER_WORK_BRANCH, "");
    p.commit("src/fix", "fix: found at the gate");
    writeFileSync(join(p.root, "merged.flag"), "");
    assert.equal(check(ctx).state, "none");
    assert.deepEqual(ctx.lastEndedRun().handoff.after.commits.map((l) => l.replace(/^\S+ /, "")), ["fix: found at the gate"]);
    assert.equal(ctx.lastEndedRun().handoff.after.ref, "main");
    rmSync(join(p.root, "merged.flag")); // the clean intake would refuse an untracked file

    // A run whose work goes to a feature branch: v3's sticky work branch, with its tip, and no drift.
    assert.equal(start(ctx).ok, true);
    p.git("checkout -q -b feature/v1");
    const tip = p.commit("src/work", "feat: the work");
    check(ctx);
    p.git("checkout -q main"); // the operator checks out the base to merge
    check(ctx);
    const live = ctx.loadRun();
    assert.equal(live.workBranch, "feature/v1", "sticky — not cleared");
    assert.equal(live.workTip, tip);
    assert.equal(live.branchDrift, undefined);
    assert.equal(ctx.shellOpts(live).env.RIDER_WORK_BRANCH, "feature/v1");
    assert.equal(ctx.shellOpts(live).env.RIDER_WORK_TIP, tip);
  } finally { p.cleanup(); }
});
