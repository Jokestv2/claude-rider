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
    check: git merge-base --is-ancestor HEAD main
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
import { loadRider } from "../scripts/lib/rider-md.mjs";
import { ensureDirs, loadLocal, statePaths } from "../scripts/lib/state.mjs";
import { createContext } from "../scripts/lib/context.mjs";

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

export function tmpProject({ riderMd = TEST_RIDER_MD, name = "lemmaria", prompts = { plan: "PLAN PROMPT", build: "BUILD PROMPT", close: "CLOSE PROMPT" } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rider-"));
  const riderDir = join(root, "riders", name);
  mkdirSync(riderDir, { recursive: true });
  writeFileSync(join(riderDir, "RIDER.md"), riderMd);
  for (const [phase, text] of Object.entries(prompts)) writeFileSync(join(riderDir, `${phase}.md`), text);
  return { root, riderDir, file: join(riderDir, "RIDER.md"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export class FakeClock {
  constructor(start = "2026-09-03T12:00:00Z") { this.t = new Date(start).getTime(); this.slept = []; }
  now = () => new Date(this.t);
  sleep = (ms) => { this.slept.push(ms); this.t += ms; };
}

export function makeCtx({ root, name = "lemmaria", binding, clock = new FakeClock(), local = {}, spawnWatcher = () => false, watcherAlive = () => null, killWatcher = () => {} }) {
  const rider = loadRider(join(root, "riders", name, "RIDER.md"));
  const paths = statePaths(root, rider.name);
  ensureDirs(paths);
  return createContext({ rider, root, paths, local: { ...loadLocal(paths), ...local }, binding, now: clock.now, sleep: clock.sleep, spawnWatcher, watcherAlive, killWatcher });
}
