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
