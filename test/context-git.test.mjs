// test/context-git.test.mjs — the context's git readers against a real repository
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh } from "../scripts/lib/shell.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { makeCtx, tmpProject } from "./helpers.mjs";

test("tip and commitsBetween: a sha outlives the branch it was read from", () => {
  const p = tmpProject();
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding() });
  const git = (cmd) => { const r = sh(`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${cmd}`, { cwd: p.root }); assert.equal(r.status, 0, `${cmd}: ${r.output}`); return r.output; };
  try {
    assert.equal(ctx.tip("HEAD"), null, "no repository: unknown, not a throw");
    assert.equal(ctx.commitsBetween("a", "b"), null);

    git("init -q -b main");
    writeFileSync(join(p.root, "a.txt"), "a");
    git("add a.txt");
    git("commit -q -m base");
    // A name no shell would take unquoted: the ref travels in the environment, not in the command text.
    git("checkout -q -b 'feature/v1-the-verifier'");
    writeFileSync(join(p.root, "b.txt"), "b");
    git("add b.txt");
    git("commit -q -m 'feat: the work'");
    const handoff = ctx.tip("HEAD");
    assert.match(handoff, /^[0-9a-f]{40}$/);
    assert.equal(ctx.tip("refs/heads/feature/v1-the-verifier"), handoff);

    writeFileSync(join(p.root, "c.txt"), "c");
    git("add c.txt");
    git("commit -q -m 'fix: found at the gate'");
    const after = ctx.commitsBetween(handoff, "feature/v1-the-verifier");
    assert.equal(after.length, 1);
    assert.match(after[0], /^[0-9a-f]{7,} fix: found at the gate$/);

    // Merged, then deleted: the name stops resolving — where a check by name exits 128 — and the sha does not.
    const merged = ctx.tip("HEAD");
    git("checkout -q main");
    git("merge -q --no-ff -m merge feature/v1-the-verifier");
    git("branch -q -D feature/v1-the-verifier");
    assert.equal(ctx.tip("refs/heads/feature/v1-the-verifier"), null);
    assert.equal(sh('git merge-base --is-ancestor "feature/v1-the-verifier" main', { cwd: p.root }).status, 128);
    const env = { ...process.env, RIDER_WORK_TIP: merged };
    assert.equal(sh('test -n "$RIDER_WORK_TIP" && git merge-base --is-ancestor "$RIDER_WORK_TIP" main', { cwd: p.root, env }).status, 0);
    assert.equal(sh('test -n "$RIDER_WORK_TIP" && git merge-base --is-ancestor "$RIDER_WORK_TIP" main', { cwd: p.root, env: { ...process.env, RIDER_WORK_TIP: "" } }).status, 1, "no tip: a plain no, not git's 128");
    // Once the branch is gone the commits after the handoff are read off the base. The read is path-limited to the
    // instance's scope (`.` here, §11), and git's history simplification drops a merge that changed nothing against
    // the branch it brought in: the merge is the operator's report, not something the gate missed.
    assert.deepEqual(ctx.commitsBetween(handoff, "main").map((l) => l.replace(/^\S+ /, "")), ["fix: found at the gate"]);
  } finally { p.cleanup(); }
});
