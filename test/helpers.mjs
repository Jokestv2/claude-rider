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
/** What a session on instance `a` of that rider is told (§12), written out rather than built: the exact text is the spec's. */
export const FACT_A = "This run serves instance `a` of the rider `lemmaria`. The instance's directory is `nodes/a`, relative to the project root.";

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

/** A context on one instance of the test rider: `instance` names one of its declared instances, or null for `default`. */
export function makeCtx({ root, name = "lemmaria", instance = null, binding, clock = new FakeClock(), local = {}, spawnWatcher = () => false, watcherAlive = () => null, killWatcher = () => {}, lock = {}, riderCount = 1 }) {
  const rider = loadRider(join(root, "riders", name, "RIDER.md"));
  const { declared, instances } = listInstances(root, rider);
  const id = instance ?? "default";
  const found = instances.find((i) => i.id === id);
  if (!found) throw new Error(`makeCtx: ${rider.name} has no instance ${id}; have: ${instances.map((i) => i.id).join(", ") || "none"}`);
  return createContext({ rider, instance: { ...found, declared }, root, local: { ...loadLocal(riderPaths(root, rider.name)), ...local }, binding, now: clock.now, sleep: clock.sleep, spawnWatcher, watcherAlive, killWatcher, lock, riderCount });
}

/** A run edited by hand is written the way every writer writes: under the instance lock. */
export const save = (ctx, run) => ctx.update(() => ctx.saveRun(run));
/** The events `await` wakes on; record events share the file, so a test that counts what the watcher said filters first. */
export const wake = (ctx) => ctx.readEvents().filter((e) => WAKE_KINDS.includes(e.kind));
/** A rate-limit message whose reset is `min` minutes after the clock's CURRENT time. Successive limits in one scenario
 *  must use increasing offsets: a wall-clock time already passed parses as tomorrow (past the cap). */
export const limitSoon = (clock, min = 30) => { const t = new Date(clock.t + min * 60_000); return `You've hit your session limit - resets ${t.getUTCHours()}:${String(t.getUTCMinutes()).padStart(2, "0")} (UTC)`; };
