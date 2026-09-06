// test/back-compat.test.mjs — a run.json written before the branch pair landed, driven from disk
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../scripts/lib/check.mjs";
import { render } from "../scripts/lib/render.mjs";
import { status } from "../scripts/lib/verbs.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { makeCtx, tmpProject } from "./helpers.mjs";

// The test rider, with a merge phase whose declared commands read the vars a legacy record has to
// supply: the base through the `branch` fallback, the work branch as an empty string.
const LEGACY_RIDER_MD = `---
name: lemmaria
start: plan
phases:
  plan:
    model: fable
    edges: { planned: build, blocked: operator }
  build:
    model: opus
    edges: { code green: close, blocked: operator }
  close:
    model: opus
    edges: { gate green: merge, blocked: operator }
  merge:
    human: true
    check: test "$RIDER_BASE_BRANCH" = main && test -z "$RIDER_WORK_BRANCH" && test -f merged.flag
    show: echo "base=$RIDER_BASE_BRANCH work=[$RIDER_WORK_BRANCH]"
intake:
  - test -d riders
evidence:
  - echo evidence-ok
---
Test rider: the merge phase reads the $RIDER_* vars its declared commands are promised.
`;

// Run c84c's shape: a legacy mirror only, no baseBranch, no workBranch, no humanTurnDetails.
const LEGACY_RUN = {
  rider: "lemmaria",
  runId: "c84c",
  startedAt: "2026-09-06T06:37:37.845Z",
  branch: "main",
  phase: "merge",
  visits: { merge: 1 },
  transitions: [],
  sessions: [],
  notes: [],
};

test("a run.json written before this branch still statuses and still checks", () => {
  const p = tmpProject({ riderMd: LEGACY_RIDER_MD });
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding() });
  ctx.saveRun(structuredClone(LEGACY_RUN));
  const onDisk = () => JSON.parse(readFileSync(ctx.paths.run, "utf8"));
  try {
    // status: the base branch reaches the verb and the rendered line through the `branch` fallback.
    const s = status(ctx);
    assert.equal(s.state, "human");
    assert.equal(s.baseBranch, "main");
    assert.equal(s.workBranch, null);
    assert.match(render("status", s), /· branch main ·/);

    // check on the human phase: the declared commands run with the vars a legacy record implies.
    const r = check(ctx);
    assert.equal(r.state, "human");
    assert.equal(r.checkExit, 1, "the check ran (and failed on the missing flag) rather than throwing");
    assert.equal(r.show, "base=main work=[]");
    assert.deepEqual(ctx.shellOpts(ctx.loadRun()).env.RIDER_BASE_BRANCH, "main");
    assert.deepEqual(ctx.shellOpts(ctx.loadRun()).env.RIDER_WORK_BRANCH, "");

    // Neither verb rewrites the record into the new shape.
    assert.deepEqual(onDisk(), LEGACY_RUN);

    // And the check can still pass: the run ends, and its archived record is still the old shape.
    writeFileSync(join(p.root, "merged.flag"), "");
    const done = check(ctx);
    assert.equal(done.state, "none");
    assert.equal(done.ended.runId, "c84c");
    assert.equal(ctx.loadRun(), null);
    const ended = ctx.lastEndedRun();
    assert.equal(ended.branch, "main");
    assert.equal(ended.baseBranch, undefined, "not migrated on the way out either");
  } finally { p.cleanup(); }
});
