// test/helpers.mjs
export const LEMMARIA_RIDER_MD = `---
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
    check: test -n "$RIDER_WORK_TIP" && git merge-base --is-ancestor "$RIDER_WORK_TIP" main
    show: git diff --stat main...HEAD -- Lemmaria-design-doc/tests/
intake:
  - test -z "$(git status --porcelain)"
  - test -f Lemmaria-design-doc/docs/progress.md
  - git branch --show-current | grep -Eq '^(main|feature/)'
evidence:
  - git status --porcelain
  - git log --oneline main..HEAD
  - git diff --stat main...HEAD -- packages/ | tail -1
---
One milestone of the Lemmaria build: from the next incomplete milestone named in
progress.md to a merge-ready feature branch carrying its plan, its code and its gate
record. Each phase's prompt asks the session to end with a \`STATUS:\` line — \`planned\`,
\`code green\`, \`gate green\`, or \`BLOCKED — …\` — followed by a \`<promise>\` marker; both
mean only "stopped properly", and the STATUS line is a hint, not the outcome. A BLOCKED
stop always names a proposed change in docs/open-questions.md. The operator's judgment
is needed at exactly one place, the merge: they drive the scenarios under tests/<milestone>/,
review the branch, and merge — the merge is their report.
`;

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInstances, loadRider } from "../scripts/lib/rider-md.mjs";
import { loadLocal } from "../scripts/lib/state.mjs";
import { createContext } from "../scripts/lib/context.mjs";
import { resolveShell, sh } from "../scripts/lib/shell.mjs";
import { riderPaths, WAKE_KINDS } from "../scripts/lib/store.mjs";

export const TEST_RIDER_MD = `---
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
    check: test -f merged.flag
    show: echo SHOW-OUTPUT
intake:
  - test -d riders
evidence:
  - echo evidence-ok
---
Test rider: the §2.4 graph with commands that work in an empty directory.
`;

/** The test rider with its instances declared as the directories under `nodes/`. */
export const INSTANCE_RIDER_MD = TEST_RIDER_MD.replace("name: lemmaria\n", "name: lemmaria\ninstances: nodes/*\n");
/** A rider whose `phase` may be entered only when `cmds` all pass (§5.1), written as a flow list, so no command may hold a comma. */
export const requiring = (phase, cmds, md = TEST_RIDER_MD) => md.replace(`\n  ${phase}:\n`, `\n  ${phase}:\n    requires: [ ${cmds.join(", ")} ]\n`);
/** The test rider whose build waits on a flag file: plan's `planned` is refused until `ok.flag` exists. */
export const REQUIRES_RIDER_MD = requiring("build", ["test -f ok.flag"]);
/** What a session on instance `a` of that rider is told (§12), written out rather than built: the exact text is the spec's. */
export const FACT_A = "This run serves instance `a` of the rider `lemmaria`. The instance's directory is `nodes/a`, relative to the project root.";
/** The test rider with an await phase (§7.1) between two session phases: `wait` polls for `ready.flag`, `review` may
 *  send the run back to it, and a fresh run may enter it on the operator's word or `locate`'s. */
export const AWAIT_RIDER_MD = `---
name: lemmaria
start: plan
phases:
  plan:
    model: fable
    edges: { planned: wait, blocked: operator }
  wait:
    await: true
    check: test -f ready.flag || exit 75
    show: echo SHOW-WAIT
    pollSeconds: 60
    timeoutHours: 2
    edges: { settled: review, timed out: operator }
  review:
    model: opus
    edges: { more: wait, done: merge, blocked: operator }
  merge:
    human: true
    check: test -f merged.flag
intake:
  - test -d riders
evidence:
  - echo evidence-ok
---
Test rider: a wait between two sessions, with commands that work in an empty directory.
`;
/** The prompt files `AWAIT_RIDER_MD`'s session phases need; pass as `tmpProject`'s `prompts`. */
export const AWAIT_PROMPTS = { plan: "PLAN PROMPT", review: "REVIEW PROMPT" };

export function tmpProject({ riderMd = TEST_RIDER_MD, name = "lemmaria", prompts = { plan: "PLAN PROMPT", build: "BUILD PROMPT", close: "CLOSE PROMPT" }, instances = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rider-"));
  const riderDir = join(root, "riders", name);
  mkdirSync(riderDir, { recursive: true });
  writeFileSync(join(riderDir, "RIDER.md"), riderMd);
  for (const [phase, text] of Object.entries(prompts)) writeFileSync(join(riderDir, `${phase}.md`), text);
  for (const id of instances) mkdirSync(join(root, "nodes", id), { recursive: true });
  return { root, riderDir, file: join(riderDir, "RIDER.md"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export class FakeClock {
  constructor(start = "2026-09-03T12:00:00Z") { this.t = new Date(start).getTime(); this.slept = []; }
  now = () => new Date(this.t);
  sleep = (ms) => { this.slept.push(ms); this.t += ms; };
}

/** `check` until the session is past running. A `done` with no STATUS line may take a confirming look
 *  before it is acted on, and how many is policy (`bareDoneConfirmed`): a test about what the stop READS
 *  as should not also pin how many polls it took to believe it. Takes `check` so this file stays import-light. */
export function settled(check, ctx, max = 5) {
  let r = check(ctx);
  for (let i = 1; i < max && r.state === "running"; i++) r = check(ctx);
  return r;
}

/** An await check run in this process by `sh()`, with no runner and no process group: offline fixtures such as
 *  `test -f ready.flag || exit 75` need neither. */
const inProcessCheck = (cwd, shell) => (cmd, { timeoutMs, env }) => {
  const r = sh(cmd, { cwd, shell, timeoutMs, env });
  return { status: r.status, timedOut: /ETIMEDOUT/.test(r.error ?? ""), output: r.output, error: r.error };
};

/** A context on one instance of the test rider: `instance` names one of its declared instances, or null for `default`.
 *  `runCheck` defaults to the in-process check above; a test passes a scripted one to pin what the watcher does with each answer. */
export function makeCtx({ root, name = "lemmaria", instance = null, binding, clock = new FakeClock(), local = {}, spawnWatcher = () => false, watcherAlive = () => null, killWatcher = () => {}, runCheck = null, lock = {}, riderCount = 1, rollRunId = undefined }) {
  const rider = loadRider(join(root, "riders", name, "RIDER.md"));
  const { declared, instances } = listInstances(root, rider);
  const id = instance ?? "default";
  const found = instances.find((i) => i.id === id);
  if (!found) throw new Error(`makeCtx: ${rider.name} has no instance ${id}; have: ${instances.map((i) => i.id).join(", ") || "none"}`);
  const merged = { ...loadLocal(riderPaths(root, rider.name)), ...local };
  return createContext({ rider, instance: { ...found, declared }, root, local: merged, binding, now: clock.now, sleep: clock.sleep, spawnWatcher, watcherAlive, killWatcher, runCheck: runCheck ?? inProcessCheck(root, resolveShell(merged)), lock, riderCount, rollRunId });
}

/** A run edited by hand is written the way every writer writes: under the instance lock. */
export const save = (ctx, run) => ctx.update(() => ctx.saveRun(run));
/** The events `await` wakes on; record events share the file, so a test that counts what the watcher said filters first. */
export const wake = (ctx) => ctx.readEvents().filter((e) => WAKE_KINDS.includes(e.kind));
/** A rate-limit message whose reset is `min` minutes after the clock's CURRENT time. Successive limits in one scenario
 *  must use increasing offsets: a wall-clock time already passed parses as tomorrow (past the cap). */
export const limitSoon = (clock, min = 30) => { const t = new Date(clock.t + min * 60_000); return `You've hit your session limit - resets ${t.getUTCHours()}:${String(t.getUTCMinutes()).padStart(2, "0")} (UTC)`; };
