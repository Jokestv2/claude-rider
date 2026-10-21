# claude-rider

A Claude Code plugin that drives a project's **rider** — a committed directory `riders/<name>/`
holding a phase graph and one prompt file per phase — one phase at a time: it launches each phase
as a background session, watches it, and hands the finished phase to a judge skill that picks one
of the phase's declared outcome labels. The technique is
[rider engineering](https://github.com/Jokestv2/rider-engineering): a task-class-specific control
layer over a general-purpose harness, and this plugin is its reference implementation on Claude
Code.

## Install

```
claude plugin marketplace add Jokestv2/claude-rider
claude plugin install rider@claude-rider
```

The judge runs the executor through its Bash tool. The skill's own `allowed-tools` frontmatter is
the first line of defence against a permission prompt; if your harness needs it, add the fallback
allowlist line to `~/.claude/settings.json` (or the project's `.claude/settings.json`):

```json
{ "permissions": { "allow": ["Bash(node */claude-rider/*/scripts/rider.mjs:*)"] } }
```

Neither line has been exercised yet: the verification session ran under `--permission-mode auto`,
so nothing prompted. Two shapes to be aware of if it does prompt — the judge's command begins
`cd "<project>" && node "…"`, not `node …`, and the glob above expects one path segment between
`claude-rider/` and `/scripts`, where a local directory install has none and a cache install has
two. Settling which line the harness honours needs an interactive `--permission-mode default`
session; see *Verified on*.

### The operator's CLI

The plugin gives Claude the judge skill. It does **not** put `rider` on your PATH — inside the skill
the executor is spelled `node "${CLAUDE_PLUGIN_ROOT}/scripts/rider.mjs"`, which only resolves there.
For the verbs you run yourself — `rider board` to see every instance at once, `rider status` to look
in on a run without spending a judge turn, `rider resume` after a rate limit, `rider start <phase>`
to enter a milestone that is already planned:

```bash
npm i -g Jokestv2/claude-rider
```

This is independent of the plugin cache, so it survives plugin upgrades. **Upgrade the plugin and
the npm CLI together.** A mismatch refuses loudly once the newer copy has written an instance's
state (schema check and v3 guard, see *Upgrading*), but an instance that has never run has no state
to refuse on: an older copy would start it and silently skip the keys it does not know, such as
`requires` and `locate`.

A decision you type yourself is recorded as the judge's unless you say otherwise: pass
`--by operator` on `next`, `resume` and `reset` (see *Verbs*).

## Adopt it in a project

Create `riders/<name>/RIDER.md` plus one prompt file per session phase. Riders are discovered as
`riders/*/RIDER.md` under the project root — the discovery rule of skills — so a project may have
several; pass `--rider <directory name>` when it does.

```
riders/lemmaria/
  RIDER.md      graph in frontmatter, task class in the body
  plan.md       the prompt for phase `plan`, verbatim, nothing else
  build.md
  close.md
```

### Frontmatter

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Identifier; also the session-name prefix and the state directory name. Letters, digits and dashes. Must equal the rider's directory name, or the rider is refused at load |
| `start` | yes | The session phase a fresh run begins at when the rider declares no `locate`; `rider start <phase>` overrides it |
| `locate` | no | One shell command that prints the phase a fresh run enters (see *Where a fresh run starts: `locate`*) |
| `phases` | yes | Map of phase name → phase (below) |
| `instances` | no | One directory glob, such as `nodes/*`: every directory it matches is an instance of this rider (see *Instances*). Without it the rider has one instance, `default` |
| `intake` | no | List of shell commands; **all must exit 0** before a fresh run may start, whatever phase it starts at. One of the mechanical refusals that fire before any model runs, with a `locate` that fails or names no phase, each phase's `requires`, and a gate whose check already passes |
| `evidence` | no | List of shell commands whose output rides along with every `check` return. Informs the judge; never refuses anything |
| `limits.visits` | no | Maximum times a run may enter the same phase (default 3). Exceeding it stops the run at `operator`. Rate-limit resumes are counted separately |

Written as a nested map: `limits: { visits: 3 }` — a literal `limits.visits:` key is ignored.

A **phase** is a *session phase*, a *human phase* or an *await phase*:

| Key | Session phase | Human phase | Await phase |
|---|---|---|---|
| `prompt` | Path relative to `RIDER.md`; **defaults to `<phase>.md`**. The whole file is the prompt: no frontmatter, no extraction | — | — |
| `model` | Required. Model name passed to the harness; overridable per phase in `local.json` | — | — |
| `edges` | Required, non-empty. Map of **outcome label → next phase**. These labels are the only outcomes the judge may pick | — | Required, as on a session phase |
| `requires` | Optional list of shell commands; **all must exit 0** for the phase to be entered (see *Entry preconditions: `requires`*) | — | Optional, as on a session phase |
| `human` | — | `true`. The run stops here for the operator | — |
| `await` | — | — | `true`. The run waits here, with no session, for a machine condition (see *Await phases*) |
| `check` | — | Required. Shell command; exit 0 means the human has acted, and the run ends | Required. Shell command the watcher polls: exit 0 means there is something to judge, 75 not yet, anything else is an error |
| `show` | — | Optional shell command whose output is printed for the operator when the run reaches this phase | Optional shell command whose output `check` prints once the wait is ready or timed out |
| `pollSeconds` | — | — | Optional, default 300: the seconds between two polls of the check |
| `checkTimeoutSeconds` | — | — | Optional, default 300: the cap on one run of the check |
| `timeoutHours` | — | — | Optional: the deadline, counted from entering the phase; absent means none |

`prompt`, `model`, `edges` and `requires` are rejected on a human phase, and `prompt` and `model`
on an await phase. A phase is human or await, never both.

### Entries and waits

The plugin's central choice is this: **outcomes are judged; entries may be refused; waits are
observed mechanically.** What a phase's work amounted to is read by the judge, and by nothing else.
`intake`, at a run's door, and `requires`, at a phase's, refuse to spend on a phase whose inputs are
missing, before any model runs. An await phase's check says only *whether* there is something to
judge, never what: the executor never maps an exit code to an edge.

The examples below come from one rider, `batch`, which declares no instances. Its phases run
`plan` → `implement` → `await-jobs`, an await phase → `review` → `approve`, a human phase; `tool …`
stands for the project's own commands.

#### Entry preconditions: `requires`

```yaml
  implement:
    model: opus
    requires:
      - tool gate approved --current
      - tool budget --ok
    edges: { launched: await-jobs, blocked: operator }
```

- **When they run.** On every entry through `start`, `next` and `overrule`, in order, stopping at
  the first that fails. Not on `resume`, which re-enters a phase already admitted: a budget the
  session itself spent must not strand it mid-work. Not on the executor's own stops either, since
  `operator` has none. Each command gets 10 s and 2 KB of output, and a timeout is a failure.
- **Before the lock.** They run before the verb takes the instance's lock, and the locked write then
  re-checks what they were run for. A stale key still wins: a decision on a stretch the instance
  has moved past is refused as stale, whatever its target's `requires` say.
- **A failure changes nothing:** no transition, no visit counted, no run created, no revival. The
  verb exits 2 with the command, its exit and its output, and the same decision goes through once
  the condition holds:

  ```
  refused: requires check failed for implement (exit 1): tool budget --ok
  3.2 of 3.0 units spent
  ```

  It is recorded as a `refused` event with `cause: "requires"`, except under `--dry-run`, which
  runs the commands and records nothing: `rider next <label> --on <key> --dry-run` asks "would this
  be refused?".
- **`check` shows them in advance.** When a block's `decide with:` labels lead to a phase with
  `requires`, `check` runs them after the lock is released, once per label, and marks the labels
  `next` would refuse:

  ```
  ── requires ── settled → review ✓ · jobs failed → implement ✗ tool budget --ok (exit 1): 3.2 of 3.0 units spent
  decide with:  rider next <label> --on 9f45.1 --because "…"     (labels: settled · jobs failed ✗ · timed out · operator)
  ```

  That is information, never a refusal: `next` runs the commands again and is the only authority,
  since the state can change in between.

#### Where a fresh run starts: `locate`

```yaml
start: plan
locate: tool next-phase
```

`start:` is still the canonical entry. `locate` is one shell command that names the phase a fresh
run enters, recomputed from the project's own state on every fresh run: the project knows its
artifacts, and `locate` turns them into a place in the graph.

- **`rider start` with no phase runs it**, per instance, with `RIDER_PHASE` empty, 10 s and 2 KB:
  - exit 0, and the first non-empty line of its **stdout** names a declared phase: the run enters
    it. A warning on stderr is never part of the name;
  - exit 0 with anything else: refused, as in `refused: locate printed "revew", which is not a
    declared phase`, or `locate printed nothing`;
  - any other exit: refused with its output, as in `refused: locate failed (exit 3): tool
    next-phase` followed by what it printed. This is how a rider says there is nothing for a
    session to do.
- **Precedence:** `rider start <phase>` beats `locate`, and a declared `locate` replaces `start:`
  outright: one that fails, or prints no declared phase, refuses the start rather than falling back
  to `start:`. When the operator names a phase and `locate` is declared, it still runs, and a
  disagreement is only noted above the result: `note: located approve; entering plan on the
  operator's word`. A failing `locate` is then only noted too, and the named phase's `requires`
  still guard it.
- **Any declared phase may be entered this way**, a wait or a human phase included; `start:` must
  still name a session phase. A run that starts at a human phase stops there for the operator, and
  `rider board` lists it under **needs you**. No session handed anything over, so it records no
  handoff and counts no gate precision. A gate whose check already passes is not entered:
  `refused: approve's check already passes; nothing waits on the operator there`. Otherwise a
  `locate` that keeps naming a passed gate would loop the judge.
- **The record:** `run.entry` is `{ by, located, phase }`, where `by` is `operator`, `locate` or
  `start` and `located` is what `locate` printed, or null. The `run-started` event says the same
  (`approve by locate`).
- **`rider start --dry-run`** runs `locate`, `intake` and the target's door, records nothing, and
  prints where a fresh run would start and what entering it would do; with `--json` it is the cheap
  "where would this instance resume?":

  ```
  [dry-run] await-jobs (await): tool jobs tick --current
  entry: await-jobs by locate
  ```
- Only `start` consults `locate`. Inside a run the judge routes by edges, and a run that has
  drifted goes to `operator` or back along a declared edge; the next fresh run locates again.

#### Await phases

```yaml
  await-jobs:
    await: true
    check: tool jobs tick --current
    show: tool jobs status --current
    pollSeconds: 300
    checkTimeoutSeconds: 300
    timeoutHours: 72
    requires: [ tool jobs any --current ]
    edges: { settled: review, jobs failed: implement, timed out: operator }
```

An await phase waits for a machine condition, such as a batch of jobs or a CI run, for hours or
days, with no session and without ending the run. Entering it launches nothing: the instance's
detached watcher runs `check` at once, then every `pollSeconds`. A wait is a stretch like a
session's, with a key of its own, and entering the phase again adds a new one. The visit cap
applies, and "wait more" is an edge back to the phase (`still running: await-jobs`): `resume` is
not a label here, since there is no session to resume.

**The check's exit is its whole contract:**

| Exit | Meaning | What the watcher does |
|---|---|---|
| `0` | Ready: there is something to judge | Stores the poll, appends a `ready` event, and exits |
| `75` | Not yet (`EX_TEMPFAIL`: try again later) | Stores the poll and sleeps `pollSeconds` |
| anything else, a timeout, or a failure to spawn | A check error; its output says what failed | Stores the poll and counts it. After `awaitCheckFailures` errors in a row (3 by default, in `local.json`) it appends one `check-failing` event for the streak and keeps polling. A 0 or a 75 ends the streak |

"Not yet" is 75, not 1, because a Python traceback exits 1, and so does a shell script under
`set -e` when one of its commands fails: a broken check must not read as "not yet" until its
deadline. A one-line check pays one clause for it:

```yaml
    check: test -f ready.flag || exit 75
```

- **The check answers only whether there is something to judge**, for example "every job is
  terminal, whether it succeeded or not". What that amounts to is the judge's to read from the
  check's output, `show` and `evidence`, as it reads a session's final message.
- **The deadline** is `timeoutHours` after the wait began. A check still answering 75, or failing,
  past it makes the wait `timed-out`, with a `timed-out` event
  (`deadline 2026-10-20T23:58:11.999Z passed; last exit 75`). The check runs first and the deadline
  is compared second, so a laptop that slept through the deadline wakes to `ready` if the jobs
  finished. `timed-out` is no verdict on anyone's work: the rider's body says which label it means.
- **Only the watcher runs the check**, with nothing locked, and commits each poll in one short
  locked write. `rider check` never runs it: it reports the last stored poll, and respawns a dead
  watcher. For a fresh look, run the phase's `show`, which should be a read. A poll appends no
  event, but rewrites `state.json`, so its `version` going up says the watcher still polls.

**A check may act.** It may be a *tick*: one pass of a keeper that relaunches what the platform
killed, then reports whether everything is settled. The executor treats it as opaque:

- **Make it idempotent.** A tick can be cut short by its timeout, a `reset` or a reboot, and the
  next poll runs it again from the top.
- **Two never run at once** for one instance. The check runs through a small runner, in its own
  process group, with its output going to a file. A watcher respawned while a tick still runs
  waits for it to end. It kills the tick only when its runner has died and the tick has overrun
  its own timeout, and it signals nothing once that timeout is a minute past: by then the group's
  id may name another process's. A tick whose run moved on, because the operator ended the wait,
  is left to finish, and its poll is not committed.
- **The check is finished when its shell exits.** A child the tick leaves running neither blocks
  the poll nor turns it into an error. But a timeout (`checkTimeoutSeconds`) and a `reset` kill the
  check's **whole process group**, so a process meant to outlive the tick must leave the group:
  `setsid`, or the platform's own submit command.
- **2 KB of its output are kept,** for `check` and the board.
- **It keeps only while the wait awaits.** Keeping stops at `ready`, when every job is terminal,
  at `timed-out`, when jobs still running are no longer kept, and when the run leaves the phase.
  Nothing keeps between the phase that launched the jobs and the wait's first poll.

**A remote check** opens a connection on every poll: hundreds over a three-day wait. Raise its
`pollSeconds`, and multiplex the connections (for `ssh`, `ControlMaster` with `ControlPersist`).

**While it waits,** `rider status` says `state: awaiting`, with the stored poll and, once a streak
reaches `awaitCheckFailures`, a `check failing:` line:

```
rider batch/default/db7b · phase await-jobs (visit 1) · stretch db7b.1 · branch main · started 2026-10-20T23:57:50.306Z
state: awaiting   watcher: alive (pid 111063)   last event: 2026-10-21T00:07:50.519Z check-failing batch/default/db7b await-jobs db7b.1 exit 2, 3 in a row: tool: cannot reach the job queue
  await-jobs await   -         awaiting
wait: $ tool jobs tick --current · 6 polls · last exit 2 at 2026-10-21T00:22:50.731Z · deadline 2026-10-23T23:57:50.307Z
check failing: 6 in a row since 2026-10-20T23:57:50.377Z
total cost: $0.00
next: relay the failing check to the operator, then arm rider await
```

`rider await`'s heartbeat is 360 minutes at an await phase, 60 elsewhere, when `--max-minutes` is
not given. **Only the operator ends a wait early.** While it awaits, `next` refuses everything but
`operator` with `--by operator`, and `resume` is refused:

```
refused: await-jobs is awaiting its check (poll 0, last exit none): only the operator ends a wait early — rider next operator --on 59c5.1 --by operator --because "…"
```

The watcher is not stopped: its next commit finds the run moved on.

**Ready or timed out,** the wait is decided like a stopped session. `rider check` prints the full
block: the check's last output where a session's block has its final message, the phase's `show`,
the evidence, the requires annotation and a `decide with:` line whose labels are the phase's edges
and `operator`. Here after 169 polls:

```
rider batch/default/9f45 · phase await-jobs · visit 1 · awaiting since 2026-10-21T01:12:00.000Z (14h 3m) · 169 polls
state: ready
── check ── $ tool jobs tick --current   (exit 0, polled 2026-10-21T15:15:00.000Z)
  3/3 jobs settled: 2 succeeded, 1 failed (job 2: out of memory at step 1840)
── show ── $ tool jobs status --current
  job 1  succeeded  4h 10m
  job 2  failed     out of memory at step 1840
  job 3  succeeded  13h 52m
── evidence ────────────────────────────────────────────────────
  $ tool jobs outputs --current
  outputs: 2 of 3 result files present
── requires ── settled → review ✓ · jobs failed → implement ✗ tool budget --ok (exit 1): 3.2 of 3.0 units spent
decide with:  rider next <label> --on 9f45.1 --because "…"     (labels: settled · jobs failed ✗ · timed out · operator)
```

`next` decides against that stored poll and never runs the check again.

A wait survives a reboot. The run stays active in `state.json`, so `rider start` refuses it
(`refused: run 95e5 is active at phase await-jobs — rider check, next, or reset first`); instead,
`rider check` or `rider await` finds the watcher dead, respawns it, and the wait carries on where
its polls left off. After a `reset` during a long wait, `rider start await-jobs`, or a `locate`
that prints it, goes straight back to the wait, as a new one.

### Instances

A rider that declares `instances: nodes/*` drives one **instance** per matching directory. They share
the phase graph; each has its own runs, watcher and judge session, and they run at the same time, all
in one working tree on one branch.

- The glob is relative to the project root, and `*`, in its last segment only, is its one wildcard.
  Creating a matching directory creates an instance; nothing is registered. Dot-directories are not
  matched.
- An instance's **id** is its directory's basename, and its **scope** is the matched path
  (`nodes/a`). An id is a safe token — letters, digits, `_`, `.` and `-`, not starting with `.` —
  and not `local.json` or `run.json`. A matching directory whose name is not is skipped, and
  `rider board` lists it with the reason.
- A rider without `instances` has exactly one instance, `default`, scoped to the project root (`.`).
- Every verb but `board` needs `--instance <id>` for a rider that declares instances; for one that
  does not, omit it (or pass `default`). An unknown id is refused with the list of instances.
- A phase session learns its instance from one line of appended system text, given at launch:
  *This run serves instance `<id>` of the rider `<rider>`. The instance's directory is `<scope>`,
  relative to the project root.* A prompt file is shared by every instance and sent verbatim, so it
  refers to "the instance's directory given in your system prompt". It must not rely on a `RIDER_*`
  variable reaching the session: those are set for the rider's declared commands (below), and
  whether `claude --bg` passes its caller's environment to a session is unverified.
- Rename or delete an instance's directory while it has state, and that state is **orphaned**:
  `rider board` lists it, `status` and `reset` accept its id so it can be inspected and its active
  run forgotten, and every other verb refuses it. A watcher already running for it carries on. The
  row stays until you remove `.rider/<rider>/<id>/` or restore the directory.

### What a declared command is told

Every shell command a rider declares — `intake`, `locate`, `requires`, `evidence`, and a human or
an await phase's `check` and `show` — runs from the project root with the environment it inherits
plus ten variables naming the instance and the run it is being asked about. A human phase's `check`
line needs them: it is the gate of a phase that is
entirely the operator's, and without them it can only hard-code a branch name or fall back to `HEAD`,
which passes vacuously the moment the operator stands on the base branch.

| Variable | Holds |
|---|---|
| `RIDER_NAME` | The rider's `name` |
| `RIDER_INSTANCE` | The instance id; `default` for a rider without `instances` |
| `RIDER_SCOPE` | The instance's directory relative to the project root; `.` for `default` |
| `RIDER_RUN_ID` | The active run's four-character id |
| `RIDER_PHASE` | The phase the command is being run for — for `intake` and `requires`, the phase about to be entered; empty for `locate`, which is asked which phase |
| `RIDER_BASE_BRANCH` | The branch the run started on |
| `RIDER_WORK_BRANCH` | The branch the work went to — recorded at a session-phase `check` whenever the current branch differs from the base. It sticks: checking the base out again to merge does not clear it |
| `RIDER_WORK_TIP` | The work branch's tip commit, recorded with it and followed while the branch resolves; it outlives the branch's deletion |
| `RIDER_FROM_PHASE` | For `requires` run by `next` or `overrule` (or by `check`, to annotate its labels), the phase being left; empty on `start` and for every other command |
| `RIDER_LABEL` | For `requires` run the same way, the label being taken; empty on `start` and for every other command |

Every one is always set, and is the **empty string** when it is not known: the work variables until
the work lands on a branch of its own, and either branch variable when the project is not on a branch
at all (no repository, or a detached `HEAD`). During a fresh run's entry commands — `locate`,
`intake`, and the target's `requires` or gate check — `RIDER_RUN_ID` and the work variables are
empty because the run does not exist yet, and `RIDER_BASE_BRANCH` is the branch about to be
recorded. Quote them: a command that tests `"$RIDER_WORK_BRANCH"` unquoted while it is empty is a
different command.

```yaml
    check: git merge-base --is-ancestor "$RIDER_WORK_BRANCH" main
```

**A gate a fresh run can reach with no session behind it must not key its check on
`RIDER_WORK_BRANCH` or `RIDER_WORK_TIP`.** That is a gate `locate` may name, a gate the operator
may enter with `rider start <gate>`, and a gate one edge after a wait that a fresh run may enter. Such
a run has had no session, so it never learns a work branch or tip: both stay empty for its check,
which then never passes, and the run waits at the gate until it is reset (see *Known limit* below).

**For a rider with `instances`, `RIDER_WORK_BRANCH` and `RIDER_WORK_TIP` are always empty.** Its
instances share one working tree on one branch, so the branch checked out is the tree's, not any
one instance's — recorded as one instance's work branch, it would become every instance's on the
next poll. Such a rider's `check` reads its own directory:

```yaml
    check: test -f "$RIDER_SCOPE/REVIEWED"
```

What the executor surfaces instead is **branch drift**: every `check` of an instance (the watcher's polls,
and checks at a human phase or on a stopped stretch, included) that finds the tree on a branch
other than the run's base records it, with the time it was first seen. `rider status` and
`rider check` print it on a `drift:` line (`branchDrift` under `--json`), and `rider board` lists the
instance under *needs you*, keeping the row's own reason and adding "the shared working tree left
`<base>` for `<branch>`" to it. The executor does not switch back; a later `check` back on the base
clears it. The board never runs git itself, so it shows what the instance's last check found.

Two names are reserved and never declared as phases or as edge labels:

- **`operator`** — a built-in terminal phase. Any edge may target it. Reaching it stops the run for
  the human with the judge's stated reason. From an await phase that is still awaiting, it is the
  only label, and only the operator may take it (`--by operator`).
- **`resume`** — an implicit reflexive edge on every session phase (not on an await phase, which
  has no session), taken when a session was cut
  short by the environment (a rate limit, a killed process). It re-enters the *same* session with a
  nudge; it never restarts the phase.

The rate-limit message shapes the classifier recognises are Claude Code 2.1.260's known strings;
none of them has been observed live in this project (no 429 was hit while it was built). A shape it
does not recognise reads `done` with "no STATUS line in the final message" — the judge relays that,
and you resume the session by hand: `rider resume --on <key> --by operator`, the key copied from
`rider check`'s `decide with:` line.

The graph is validated when the rider loads, and an invalid rider is refused with the reason before
anything runs: `name` equals the rider's directory name; a phase name is letters, digits, underscores
and dashes (it becomes a path segment and an event token); every edge target is a declared phase or
`operator`; `start` names a declared session phase, not a human or an await phase; a human phase
has a `check`, and no `prompt`, `model`, `edges` or `requires`; an await phase has a `check` and
non-empty `edges`, no `prompt` or `model`, and positive numbers for `pollSeconds`,
`checkTimeoutSeconds` and `timeoutHours`; no phase is both human and await; a session phase has a
`model`, non-empty `edges`, and a prompt file that exists; `requires` is a list of shell commands;
`locate` is one non-empty shell command; `limits.visits` is a positive integer; `operator` and
`resume` are not used as phase names or edge labels; `intake` and `evidence` are lists of strings;
`instances` is one glob relative to the project root (no leading `/`, no `\`, no `..` segment)
whose only wildcard is `*`, in its last segment.

The **body** of `RIDER.md` is prose for the judge — the task class and its terminal condition, what
each outcome label means, what a blocked stop looks like. It is never sent to a phase session; the
phase's prompt file is, whole and unmodified.

### Worked example

```yaml
---
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
record. Each phase's prompt asks the session to end with a `STATUS:` line — `planned`,
`code green`, `gate green`, or `BLOCKED — …` — followed by a `<promise>` marker; both
mean only "stopped properly", and the STATUS line is a hint, not the outcome. A BLOCKED
stop always names a proposed change in docs/open-questions.md. The operator's judgment
is needed at exactly one place, the merge: they drive the scenarios under tests/<milestone>/,
review the branch, and merge — the merge is their report.
```

### Then

Add `.rider/` to the project's `.gitignore` — the rider directory is committed, its run state is
not:

```
.rider/
```

Open a Claude Code session at the project root and type `/rider:rider`. The skill re-orients from
`rider status`, starts the run, arms a background watch, judges each finished phase, and stops for
you at a human phase or at `operator`. For a rider that declares instances, open one session per
instance you want driven and type `/rider:rider <id>`. When a rider declares instances or the
project has several riders, `/rider:rider` with no argument is **board mode** — your view of every
instance, which acts only on your word and arms no watch.

## The YAML subset

`RIDER.md` frontmatter is read by a deliberately small YAML reader, not a full parser. It supports:
block maps at 2-space indents; block lists of scalars (`- item`, indented under their key); flow
maps `{ a: x, b: { c: y } }` (nested, keys may contain spaces, may span lines until braces
balance); flow sequences `[ a, b ]`; scalars bare-to-end-of-line, `"double"` (`\"` `\\` `\n`),
`'single'` (`''`); `true`/`false`/`null`/numbers typed; `#` lines are comments, no inline comments.
Nothing else. A ` #` inside a value is part of the value, since shell lines contain one, so a trailing
comment would become part of the command; no example here carries one. In a flow list `[ a, b ]`
a comma outside quotes ends an item, and in a flow map it ends a value; a `]` or `}` outside quotes
ends the list or the map. So a command that contains any of them, such as
`test -f ${RIDER_SCOPE}/approved`, is quoted (`[ "test -f ${RIDER_SCOPE}/approved" ]`) or goes in
a block list. Unquoted, a `]` or `}` inside an item makes the reader refuse the file and name the
line, but a comma splits the command in two without a word.

## Verbs

Run from the project root. Every verb is short-lived and idempotent; the one long-lived process is
the watcher, and it is detached.

```
rider — drive riders/<name>/RIDER.md one phase at a time (run from the project root)

  rider start [phase]                 fresh run at any declared phase: the named one, else the one locate prints
                                      (start: when the rider declares no locate); intake and that phase's requires
                                      run first, and a gate's check must fail
  rider next <label> --because "…" --on <key>   take an edge of the current phase; also: resume · operator
  rider check                         classify the current stretch; print the block the judge reads, and its decide-with line
  rider resume --on <key>             re-enter the current session after a rate limit or a kill
  rider overrule <label> --because "…" --on <runId>   the operator's ruling: revive the run that stopped at operator, take the edge
  rider await [--max-minutes N]       block until the watcher's next event (exit 0) or N min (exit 3)
  rider status                        the run at a glance
  rider note "…"                      append to the run record (the last ended run when none is active)
  rider reset --on <runId>            forget the active run (its record stays under .rider/<name>/<instance>/runs/)
  rider watch                         the detached watcher itself (spawned by start/next/resume/check)
  rider board                         every instance of every rider, needs-you first (no --rider, no --instance)

  --rider <directory name>   when the project has several riders   --json   machine-readable output
  --instance <id>  which instance: required when the rider declares instances, else omitted (or default);
                   an orphaned id (state, but no directory) is accepted by status and reset only
  --on <key>       what the decision judged: <runId>.<n> for next and resume (check prints it), <runId> for overrule and reset;
                   refused when the instance has moved on since
  --by judge|operator  who decided, recorded on the transition, and on the refused event when it is refused
                   (default judge; operator for the operator's own ruling)
  --dry-run        start/next/resume/overrule print what they would enter (the harness command, a gate's or a wait's check);
                   they launch and record nothing, but start/next/overrule still run the entry checks that could refuse
  --max-minutes N  await's deadline in minutes (default 360 at an await phase, else 60)
  --binding <path>  another harness module (or RIDER_BINDING)
exit: 0 ok · 2 refused or usage · 3 await timed out
```

**A decision names what it judged.** A **stretch** is one record of a run's sessions — a launch, one
resume of it, or one wait at an await phase — and its key is `<runId>.<n>`, `n` its 1-based place in
the run's sessions. `next` and
`resume` take the key of the stretch they decide on; `overrule` and `reset` take the run id. The
executor checks the key under the instance's lock and refuses a stale or mismatched one with exit 2:
a `refused:` line saying what the key judged and why it no longer applies, and a `now:` line with
the phase, the run, the latest stretch's key and outcome, and the last transition with its `because`
and who made it. The refusal is recorded as a `refused` event, except under `--dry-run`. A missing
or malformed `--on` is a usage refusal and leaves no trace. Instead of assembling a key, copy the
line `check` prints for a stopped stretch — here at the worked example's `plan` phase, for an
instance `a` — up to `--because "…"`, and not its `(labels: …)` tail, which is a bash syntax error
if copied:

```
decide with:  rider next <label> --instance a --on c1d1.1 --because "…"     (labels: planned · blocked · resume · operator)
```

A wait still awaiting its check prints no such line: its key is `status`'s `stretch <key>`, for the
one decision it admits, the operator's `rider next operator --on <key> --by operator`.

That line, the moves printed after an `operator` stop, `status`'s `next:` line and the board's hints
carry `--rider` when the project has several riders and `--instance` when the rider declares
instances, so each runs as printed. Text `status` and `check` name the rider, the instance and the
run in their first line — `rider <name>/<instance>/<runId>`, as event lines and session names do,
`default` for a rider without instances — and `status` adds the current stretch (`stretch <key>`;
`key` under `--json`).

`--by judge|operator` on `next`, `resume` and `reset` records who decided on the transition, and a
refused verb, `start` included, records it on its `refused` event. The default is `judge`, so pass
`--by operator` for your own ruling. `overrule` is always recorded as the operator's, and the
executor's own moves (the visit cap, a failed launch, the watcher's rate-limit resume) as
`executor`.

### The board

`rider board` lists every instance of every rider, derived from `riders/*/RIDER.md` and each rider's
`instances` glob — so an instance that never ran is listed too — grouped in this order:

| Group | When |
|---|---|
| **needs you** | branch drift (added to the row's own reason, which stays); an active run at a human phase, one that started there included; the last run ended at `operator`; a stretch `waiting` on a question; a running stretch, or an awaiting wait, whose watcher is not alive; an awaiting wait whose check failed `awaitCheckFailures` times in a row; a stopped stretch that was `intervened` (rate-limited or not); a rate-limited stretch whose watcher gave up or died; **undecided** — a `done` or `gone` stretch, or a `ready` or `timed-out` wait, that stopped more than `staleDecisionMinutes` ago (default 20, `local.json`) with no decision: its judge has most likely died |
| **orphaned** | state under `.rider/<rider>/` whose instance directory no longer exists |
| **needs its judge** | a `done` or `gone` stretch, or a `ready` or `timed-out` wait, that stopped more recently than that, with no decision yet |
| **running** | a running stretch with a live watcher, a rate-limited one whose live watcher waits for the reset (with the reset time), or an awaiting wait with a live watcher (with its last poll) |
| **idle** | no active run: the last one ended by a passing check or by `reset`, or the instance never ran |

Each row shows the rider, instance and scope, the phase, how long it has been in this state, what it
waits on, the latest decision (label, `by`, `because`), the run's cost and the instance's total, the
watcher's pid, and — for a row whose stretch waits on a decision — its `decide with:` line. Those
are the *needs its judge* and *undecided* rows, and a row that branch drift moved from *needs its
judge* to *needs you*. The board runs no command, so its `decide with:` never marks a label `✗`;
`check`'s does. A ruling on any other row takes its `--on` from the instance: the stretch key from
`rider check --instance <id>`'s `decide with:` line, the run id from `rider status --instance <id>`.
An awaiting wait has no `decide with:` line anywhere: its stretch key is in
`rider status --instance <id>`.

An await phase's row says what the watcher last stored, as in these:

```
  batch/default  . · phase await-jobs · 0m · awaiting tool jobs tick --current · poll 9, last exit 75 at 2026-10-20T23:57:58.639Z
  batch/default  . · phase await-jobs · 0m · await check failing: exit 2, 6 in a row since 2026-10-20T23:57:50.377Z: tool: cannot reach the job queue
  batch/default  . · phase await-jobs · 0m · its judge's decision on the ready wait
  batch/default  . · phase await-jobs · 45m · undecided for 45 min — its judge has most likely died
```

The first is *running*, the second and the last are *needs you*, and the third is *needs its
judge*. An awaiting wait whose watcher is dead reads `watcher not alive`, under *needs you*,
whatever its last poll said.
Directories the glob matched but skipped (an unsafe or reserved name) are listed with the reason,
and a rider whose `RIDER.md` does not load, or whose state is the v3 layout, is an error entry while
every other rider is still listed.

The board only reads: no lock, no `claude` call, nothing written. Its *running* is therefore what
the watcher last recorded, not a fresh poll; the row says how long ago the state was written and
whether the watcher is alive. That is a liveness check of the pid in `watch.pid`, nothing more: it
says a watcher process exists for the instance, not what it last looked at.

**`rider board --json` is the stable interface for a dashboard.** It is versioned:
`{ board: 1, generatedAt, riders, rows, skipped, errors }`, where `riders` names every rider
directory found, a row is `{ rider, instance, scope, category, phase, runId, since, waitsOn,
decision: { label, because, by } | null, runCost, instanceCost, key, decideWith,
drift: { branch, at } | null, watcher, updatedAt, statePath }` (`drift.at` is when a check first saw
the tree on that branch), a skipped entry is `{ rider, path, reason }`, and an error is
`{ rider, instance?, error }`. The files under `.rider/` are documented below, but internal.

## `local.json`

Machine facts and per-machine overrides live in `.rider/<name>/local.json`, one per rider and shared
by its instances, which is **not committed** (it sits inside the gitignored `.rider/`). Every key is
optional; the defaults are:

| Key | Default | Meaning |
|---|---|---|
| `claudePath` | `null` | Path to the `claude` executable; `null` means the binding's default (see *Platforms*) |
| `models` | `{}` | Per-phase model overrides, `{ "<phase>": "<model>" }`, winning over the phase's `model` |
| `advisor` | `null` | Passed as `--advisor <model>` when set; off by default |
| `permissionMode` | `"auto"` | The `--permission-mode` the phase sessions run under |
| `launchArgs` | `[]` | Extra `claude` flags every phase session launches with, one argv element each — how a project pins settings the sessions would otherwise inherit from the operator's own setup. A resume of a session still listed passes none |
| `maxWaitHours` | `6` | The watcher gives up on a rate-limit reset further away than this and emits `rate-limited` for the operator |
| `pollSeconds` | `30` | The watcher's poll interval at a session phase. An await phase is polled at its own `pollSeconds`, declared in `RIDER.md` |
| `staleDecisionMinutes` | `20` | How long a stopped stretch, or a ready or timed-out wait, may wait for its judge's decision before `rider board` calls it undecided and lists it under *needs you* |
| `awaitCheckFailures` | `3` | How many await-check errors in a row make a wait's check *failing*: one `check-failing` event for the streak, a `check failing:` line in `status` and `check`, and a *needs you* row on the board. A positive integer: any other value is refused, with the file named |
| `shell` | `null` | The shell every command a rider declares runs in; `null` means the resolved default (see *Platforms*) |

Keys not listed here are kept in the file but unused. The watcher's other give-up rule — three
consecutive rate-limit resumes on one phase — is fixed, not configurable.

## Platforms

Linux is the primary platform. macOS is likely to work. Windows is unverified since the
per-instance state layout: the atomic rename retries `EPERM`/`EBUSY` as graceful-fs does, but
nothing of it has run there.

Every command a rider declares is a POSIX shell line, and the platform shell on Windows is
`cmd.exe`, which cannot run them. The executor therefore resolves Git Bash explicitly:
`C:/Program Files/Git/bin/bash.exe`, then `C:/Program Files (x86)/Git/bin/bash.exe`, then plain
`bash.exe` on `PATH` — that last is a fallback worth overriding, since `bash.exe` on `PATH` may be
WSL's, a different filesystem. Set `shell` in `local.json` to point somewhere else. On every other
platform the shell is `/bin/sh`.

The `claude` executable defaults to `~/.local/bin/claude.exe` on Windows when that file exists,
because `spawnSync` does not resolve `.cmd` shims; otherwise it is plain `claude` on `PATH`. Set
`claudePath` in `local.json` to override.

An await phase's check runs in its own process group, so that a timeout or a `reset` can kill all of
it. Process groups exist on Linux and macOS; on Windows this is unverified.

## State and the evaluation record

State lives under `.rider/<name>/` at the project root, one directory per instance:

```
.rider/lemmaria/
  local.json        machine facts and overrides, shared by the rider's instances (above)
  run.json/         a directory, not a file: it makes an older executor refuse (see Upgrading below)
  default/          one directory per instance: `default`, or each id the instances glob matched
    state.json      the instance's state: the active run (or null) and a summary of the last ended run
    events.jsonl    the instance's event stream, one JSON object per line
    runs/           ended runs, one file each, named by start time (`:` and `.` written as `-`)
                    and run id
    logs/           one harvest per session stop: ids, registry entry, outcome, cost, turns,
                    question, final text, transcript path, transcript tail
    logs/watch.log  the detached watcher's own output
    logs/check.out  the output of the await check now running; a reset can leave the last one behind
    watch.pid       the live watcher, if any
    check.pid       the await check now running, if any: its process group, its wait's key,
                    when it started, its runner's pid and the timeout the runner enforces
    lock            present only while a verb holds the instance
```

A **run** is one traversal from the phase it started at (or a revival by `overrule`) to a human
phase whose `check` passes. It ends `done` (that check passed), `operator` (the judge routed there, a launch
failed, or the visit cap was hit), or `reset`: its record is written to `runs/`, and `state.json`
keeps `run: null` and a `lastRun` summary. **`state.json` is never deleted**, so a reader finds one
file per instance that has ever run. It carries `schema: 5`, and a `version` that goes up by one on
every committed write — for a poller to tell that it changed, not a decision key. Each poll of an
await check is such a write.

`events.jsonl` holds one `{ seq, at, rider, instance, runId, kind, phase, key, text }` per line, `seq`
counting from 1 per instance and `key` naming the stretch the event concerns. Its kinds come in two
families: **wake events**, which the watcher appends and `rider await` wakes on — `done`, `gone`,
`waiting`, `intervened`, `rate-limited`, `watcher-stopped`, and at an await phase `ready`,
`timed-out` and `check-failing` — and **record events**, which every committed write appends —
`run-started`, `phase-entered`, `decided`, `overruled`, `resumed`, `noted`, `run-ended`, `reset`,
and `refused` for a verb refused by its key or by an entry command. A `refused` event also carries
`by`, who sent the verb: `judge`, `operator`, or `executor` for the watcher's own resume; and
`cause`, why it was refused: `stale` (the key), `intake`, `locate`, `requires`, or `gate` (a start
at a gate whose check already passes). A dry run records none. A poll of an await check appends no
event of its own. An instance's timeline can be drawn from this file alone.

**One writer at a time per instance.** Every write goes through one store, under the instance's
lock: the file `lock`, made by exclusive create and naming its holder's pid, host and acquisition
time. Each writing verb holds it from its first read of the state to its last write, its `claude`
calls included: a launch (`start`, `next`, `resume`, `overrule`) holds it longest, typically about
45 s, and a `check` about 20 s. Neither is a bound: each `claude` call is capped at 120 s, a launch
makes several (up to 30 registry polls among them), and a slow human-phase `check` runs inside the
hold too. The entry commands — `locate`, `intake`, `requires`, and the check of a gate a fresh run
would start at — run before it is taken, and the hold re-checks what they were run for. An await phase's check runs with nothing held, and its poll is
committed in one short write. No wait is ever held across it — not the watcher's poll sleep or
rate-limit wait, not `await`'s poll, not the judge's thinking: decisions are protected by their keys
instead. `evidence`, `show` and `check`'s `requires` readout run after it is released; a human
phase's `check` runs inside it, since its exit decides whether the run ends. A verb that finds the
instance locked retries about every 200 ms for 60 s, then refuses with
`instance <id> is locked by pid N on <host> since <time>`. A stale lock is broken only when its
holder ran on this host and that pid is dead, or the lock was taken before the machine last booted;
a live pid's lock, or one from another host, is never broken. A `watch.pid` or `check.pid` written
before the boot likewise names no live process. Reads — `status`, `board`, and `await` unless it respawns a dead watcher — take no lock:
`state.json` and `runs/` files only ever change by an atomic rename.

These files are internal. **`rider board --json` is the stable interface** for anything that reads
the state from outside (see *The board*).

`runs/*.json` is the raw **evaluation record**. Nothing reports over it yet; analysis is a script
over `.rider/*/*/runs/` once there are enough runs to say something. What is recorded, and against
which criterion:

| Criterion | Recorded as |
|---|---|
| Restart soundness | `watcherSpawns` per session and per wait; resumes after `gone` |
| Gate precision | `handoff.after`, the commits that landed after the sessions handed over (below); `notes` at the human phase (what the operator reported, if anything) |
| Context efficiency | `cost`, `turns`, `elapsedMs` per session; a wait's wall-clock time (`at` → `readyAt` or `timedOutAt`) and `polls` |
| Trajectory conformance | `intervened`, `questionRelayed`, every transition (a resume is one) with its `because` and `by` (`judge`, `operator` or `executor`), the transitions to `operator` above all; `entry`, how the run was started (`by`: `operator`, `locate` or `start`); the `refused` events and their `cause` |
| Transfer within class | one `runs/` file per traversal, same rider |

Cost is charged per stretch: a resumed session's record carries only what its own stretch added.

**Gate precision** is counted when a human phase's check passes: `handoff.after` keeps
`git log --oneline <tip>..<ref> -- <scope>`, where `<tip>` is what the sessions handed over (the
work tip, else `HEAD` on entering the human phase), `<ref>` is the work branch while it exists, else
the base branch, else `HEAD`, and `<scope>` is the instance's directory (`.` for `default`). A run
that reaches its human phase with no session behind it — started at the gate, or at a wait whose
edge leads straight there — records no handoff, and nothing is counted for it. Every
rider's count is path-limited, so two kinds of commit are not counted. A commit that touches only
paths outside the instance's directory — shared code several instances use — is a known undercount;
an adopter who needs it can declare an `evidence` command that uses `$RIDER_SCOPE` and its own
conventions. And a clean `--no-ff` merge commit is not counted, because any pathspec turns on git's
history simplification; the commits it brings in are.

**Known limit:** the rate-limit wait lives in the watcher process. The resume at the reset is
guaranteed only while that process lives; a watcher killed mid-wait resumes nothing by itself, and
nothing respawns one for it — `check` returns early for a session already recorded `rate-limited`,
and `rider await` waits on a rate-limited stretch only while its watcher is alive. The run is not
stranded: `rider board` lists it under *needs you*, `rider status` shows the stretch `rate-limited`
and `rider check` its stored reset time, and `rider resume --on <key>` starts a new stretch in the
same session — the judge asks the operator before running it (see the skill).

**Known limit:** a watcher whose `check` keeps failing can cycle. The watcher gives up after five
consecutive `check` failures and appends a `watcher-stopped` event (`watcher giving up: …`); the
judge that event wakes re-arms `rider await`, which respawns the watcher, which may fail five times
again. Each cycle is bounded (about 2.5 minutes at the default poll), the sequence is not. A failure
that persists also breaks the judge's own `rider check`, which reports and stops, so the cycle needs
a failure that comes and goes. Repeated give-up events in the instance's `events.jsonl` mean: read
`.rider/<name>/<instance>/logs/`, fix the cause (usually the `claude` CLI or a transcript the harness
cannot read), then `rider check`.

**Known limit:** the launch is not atomic. If the executor dies between the `claude` CLI creating
the session and `state.json` being written, that session is orphaned — it keeps running, and paying,
with nothing tracking it. It is listed by `claude agents`; remove it by hand (`claude stop <id>`).

**Known limit:** one watcher per live instance. At a session phase each polls `claude agents` every
`pollSeconds`, which is fine for about ten live instances; a shared poller is not built. At an await
phase it holds its instance's watcher for days, but its polls run the rider's own check, never
`claude agents`, so it costs less than a session's watcher.

**Known limit:** the lock relies on exclusive create, which is reliable on local filesystems and on
NFSv3 or later. Keep `.rider/` on a local disk where you can.

**Known limit:** breaking a stale lock can race. When two or three verbs find the same dead holder's
lock within moments of each other, they can rarely let two verbs hold the instance at once, or leave
a lock that nobody holds but that names a live process. That lock stays until the process exits —
minutes, when it is the instance's watcher — and meanwhile verbs on the instance are refused after
60 s with `instance <id> is locked by pid N on <host> since <time>`. If that refusal repeats and no
verb on the instance is mid-operation, remove `.rider/<name>/<instance>/lock` by hand. A lock that
names no holder (a crash between its create and its write) is never broken; its refusal names the
file to remove.

**Known limit:** a detached `HEAD` reads as no branch. A run started on one records no base branch
and never records drift, and a mid-run detached `HEAD` (a rebase in progress, a checked-out commit)
clears the drift a rider with instances recorded instead of showing it.

**Known limit:** instances share git's own lock. Phase sessions that commit at the same moment
contend on `.git/index.lock`; staging explicit paths and retrying is the adopter's concern.

**Known limit:** a run that reaches a gate with no session behind it — started at the gate, or at a
wait whose edge leads straight there — never learns a work branch or tip, so `RIDER_WORK_BRANCH`
and `RIDER_WORK_TIP` stay empty for its check. A gate a fresh run can reach with no session behind
it — one `locate` may name or `rider start <gate>` may enter, or one an edge after a wait a fresh run
may enter — must not key its check on them: such a run could never pass its gate, and would wait at
*needs you* until it is reset. Key such a gate on the project's own state instead, as a rider with instances does
(`test -f "$RIDER_SCOPE/REVIEWED"`).

**Known limit:** the judge is a live interactive session. Across a multi-day wait it may die, and
nothing re-invokes it. The watcher still records `ready` or `timed-out`, and after
`staleDecisionMinutes` `rider board` lists the instance as **undecided**, so board mode or a fresh
`/rider:rider <id>` decides it. A headless judge is not built.

**Known limit:** a watcher at an await phase is busy. While a tick runs, the instance's one watcher
does nothing else, and a verb that finds it alive spawns no other. A session launched meanwhile —
the operator ended the wait, and a fresh `rider start` launched one — is first polled once the tick
ends: up to `checkTimeoutSeconds` later. Between ticks the watcher sleeps the phase's `pollSeconds`
in slices of `local.json`'s `pollSeconds` (30 s by default) and reads the run after each, so a
stretch launched while it sleeps is polled within one slice. The board shows it *running*
meanwhile, which it is; only the watcher's notice of its stop is late.

**Known limit:** a reboot kills the check runner and its process group together, so nothing
overlaps; a tick it cut short is the rider's to make idempotent. After a reboot, nothing runs a verb
until someone does, so the watcher — and any keeping its tick does — stays dead until then. The
board's **watcher not alive** row is the signal.

**Known limit:** a remote check opens a connection on every poll. Raise its `pollSeconds`, and
multiplex its connections (see *Await phases*).

## Upgrading

### From 0.2

0.3 writes `state.json` as `schema: 5` and reads 4 and 5. The shape only grew — wait records, a
run's `entry`, a `cause` on `refused` events — so a 0.2 instance carries on as it is, and nothing is
converted. 0.2 reads schema 4 only: once 0.3 has written an instance's state, a stale 0.2 copy
refuses every verb on it, naming the file, instead of launching past `requires` it does not know.
An instance that has never run has no state to refuse on, and a 0.2 copy would start it and skip
its `requires` and `locate` in silence. **Upgrade the plugin and the CLI together.**

### From the v3 layout

The per-instance layout arrived in 0.2.0. Every 0.1.x release used the earlier layout, v3.

There is no migration. The earlier layout, v3, kept one `.rider/<name>/run.json` file per rider; an
executor that finds such a file refuses every verb, naming it: finish or `reset` that run with the
old version first, then remove `.rider/<name>/` (move its `runs/` aside first to keep the history;
nothing reads it). An active v3 run is upgraded past only once it has ended. A `state.json` whose
`schema` is neither 4 nor 5 is refused the same way.

The reverse is guarded too. This version creates `.rider/<name>/run.json/` as a directory holding a
`README`, so an older executor run against the project fails on every verb (`EISDIR`) instead of
finding no run and launching a paid session. Leave it in place.

## Tests

- `npm test` — the offline suite (`node --test`, zero dependencies): the core against a fake
  binding that scripts session outcomes, plus the parsers, classifiers, graph validation, edge and
  intake refusals, `requires` and `locate`, await phases and their watcher, the visit cap, the store
  and its lock, decision keys, instances, the board, and the loop-simulator scenarios. The await
  check's runner is tested against real process groups.
- `npm run smoke` — the live tier: the real binding against real sessions on haiku, a few cents.
  Run by hand before a release, never under `node --test`. Last results: 17/17 at `be850e1`
  (three runs on 2026-09-04, about $0.32 in total); 16/17 at `59c7d67` after the review fix wave
  (2 min 33 s, about $0.12) — the one failure was the zero-sample flake on the pending-subagent
  assertion described under *Verified on*, and every assertion that touches the changed code
  passed. On the per-instance state layout: 20/21 at `5425f5d` on 2026-10-20 (Linux, Claude Code
  2.1.304, about $0.04). The one failure was the same zero-sample flake. The two-instance section,
  decision keys, the board and the detached watcher all passed.
- **The smoke needs a trusted workspace.** Since 2.1.304, `claude --bg` refuses to launch in a
  directory nobody has trusted ("Workspace not trusted. Run `claude` in … once and accept the trust
  prompt"). The smoke's fresh temp roots are never trusted, so every launch is refused: the run
  ends at `operator` and nothing is spent. Trust covers subdirectories, so point `TMPDIR` at a
  directory under one you have trusted, as in `TMPDIR=<trusted dir>/.rider-smoke npm run smoke`.
  An adopting project needs the same: run `claude` in it once before its first `rider start`.

## Verified on

The claims the design leaves to be checked against a real install and a real account, filled in at
release (§ numbers refer to the design notes, which are not shipped in this repo). The rows were
measured before the per-instance state layout. Only the watcher row has been rerun on it, by the
2026-10-20 smoke:

| Claim | Where | Verified | Result |
|---|---|---|---|
| `/rider` resolves (or only `/rider:rider`) | §3.4 | 2026-09-04, Claude Code 2.1.260 | **PASS for `/rider:rider`** — a session launched with that prompt expanded the skill (the turn carries `<command-name>/rider:rider</command-name>` followed by the SKILL.md body) and went on to run the executor. Bare `/rider` was **not tried**, so it stays unverified; `plugin details rider` lists the component as `rider` |
| `${CLAUDE_PLUGIN_ROOT}` expands in the skill's Bash calls; which allowlist line prevents prompts | §3.4 | 2026-09-04, Claude Code 2.1.260 | **Expansion PASS** — it reached the skill body already substituted, as an absolute forward-slash path, and every `node "…/scripts/rider.mjs"` call ran. It is the plugin's *install root*: installed from a local `directory` marketplace that is the checkout itself, not the `~/.claude/plugins/cache/` copy. **The allowlist question is not discriminated** — under `--permission-mode auto` no prompt appeared, so neither line was exercised; both are kept above. The GitHub-source install route was not exercised. |
| The detached watcher outlives its spawning process | §4.6 | `npm run smoke` (the two watcher assertions) | **PASS as measured** — it outlived `rider start`, a `spawnSync`'d process that had already exited, and appended the phase's `done` event. The same shape was seen again in the live judge session. It was **not** measured against a judge session's own exit. **Rerun on 2026-10-20** (Linux, Claude Code 2.1.304, the per-instance layout): PASS. The smoke's backgrounded `rider await` also exited 0 carrying the `waiting` event, and two instances' watchers each appended their own `done` event |
| A backgrounded `rider await` wakes the judge | §3.3 | a live judge session (below) | **PASS** — `rider await` was armed with the Bash tool's `run_in_background`, exited 0 carrying the watcher's event line at `08:50:33.380Z`, the completion notification reached the judge at `08:50:35.313Z` (**1.9 s**), and it then ran `status`, `check` and `next "done" --because …` with nobody typing |
| Git Bash runs the worked example's POSIX commands on Windows | §7 | `test/shell.test.mjs` | **PASS offline** — `test/shell.test.mjs` resolves Git Bash to `C:/Program Files/Git/bin/bash.exe` on this machine and runs POSIX lines of the worked example's shape (`test`, `$(…)` substitution, redirection, non-zero exit); the example's own `intake`/`evidence` lines are not run. Offline evidence only: the smoke rider declares no `intake` or `evidence` and never enters its human phase. |

Three things the runs behind this table showed that are worth knowing:

- The smoke's "a pending subagent keeps the session busy" assertion passes on **exactly one sample** by
  design, and a detached-watcher tick landing inside its 3 s window would leave none — roughly a 10%
  chance per run. A zero-sample run is a flake, not a regression.
- On 2.1.260 `claude stop` leaves the session `gone`, not `done` (three runs of three, seen 10–15 s
  after the stop). The smoke accepts either.
- A phase that asks its question in prose instead of calling `AskUserQuestion` classifies as `waiting`
  with 0 turns — 1 of 3 smoke runs here, 2 of 3 under the predecessor, and again in the live judge
  session above. The judge relays it either way.

## License

MIT.
