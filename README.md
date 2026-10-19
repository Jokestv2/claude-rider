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

This is independent of the plugin cache, so it survives plugin upgrades. Upgrade the plugin and the
npm CLI together; a mismatch refuses loudly in either direction (schema check and v3 guard, see
*Upgrading from the v3 layout*).

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
| `start` | yes | The session phase a fresh run begins at (`rider start <phase>` overrides it) |
| `phases` | yes | Map of phase name → phase (below) |
| `instances` | no | One directory glob, such as `nodes/*`: every directory it matches is an instance of this rider (see *Instances*). Without it the rider has one instance, `default` |
| `intake` | no | List of shell commands; **all must exit 0** before a fresh run may start. The only mechanical refusal that fires before any model runs |
| `evidence` | no | List of shell commands whose output rides along with every `check` return. Informs the judge; never refuses anything |
| `limits.visits` | no | Maximum times a run may enter the same phase (default 3). Exceeding it stops the run at `operator`. Rate-limit resumes are counted separately |

Written as a nested map: `limits: { visits: 3 }` — a literal `limits.visits:` key is ignored.

A **phase** is either a *session phase* or a *human phase*:

| Key | Session phase | Human phase |
|---|---|---|
| `prompt` | Path relative to `RIDER.md`; **defaults to `<phase>.md`**. The whole file is the prompt: no frontmatter, no extraction | — |
| `model` | Required. Model name passed to the harness; overridable per phase in `local.json` | — |
| `edges` | Required, non-empty. Map of **outcome label → next phase**. These labels are the only outcomes the judge may pick | — |
| `human` | — | `true`. The run stops here for the operator |
| `check` | — | Required. Shell command; exit 0 means the human has acted, and the run ends |
| `show` | — | Optional shell command whose output is printed for the operator when the run reaches this phase |

`prompt`, `model` and `edges` are rejected on a human phase.

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

Every shell command a rider declares — `intake`, `evidence`, and a human phase's `check` and `show` —
runs from the project root with the environment it inherits plus eight variables naming the instance
and the run it is being asked about. A `check` line needs them: it is the gate of a phase that is
entirely the operator's, and without them it can only hard-code a branch name or fall back to `HEAD`,
which passes vacuously the moment the operator stands on the base branch.

| Variable | Holds |
|---|---|
| `RIDER_NAME` | The rider's `name` |
| `RIDER_INSTANCE` | The instance id; `default` for a rider without `instances` |
| `RIDER_SCOPE` | The instance's directory relative to the project root; `.` for `default` |
| `RIDER_RUN_ID` | The active run's four-character id |
| `RIDER_PHASE` | The phase the command is being run for — for `intake`, the phase about to be entered |
| `RIDER_BASE_BRANCH` | The branch the run started on |
| `RIDER_WORK_BRANCH` | The branch the work went to — recorded at a session-phase `check` whenever the current branch differs from the base. It sticks: checking the base out again to merge does not clear it |
| `RIDER_WORK_TIP` | The work branch's tip commit, recorded with it and followed while the branch resolves; it outlives the branch's deletion |

Every one is always set, and is the **empty string** when it is not known: the work variables until
the work lands on a branch of its own, and either branch variable when the project is not on a branch
at all (no repository, or a detached `HEAD`). During `intake`, `RIDER_RUN_ID` and the work variables
are empty because the run does not exist yet, and `RIDER_BASE_BRANCH` is the branch about to be
recorded. Quote them: a command that tests `"$RIDER_WORK_BRANCH"` unquoted while it is empty is a
different command.

```yaml
    check: git merge-base --is-ancestor "$RIDER_WORK_BRANCH" main
```

**For a rider with `instances`, `RIDER_WORK_BRANCH` and `RIDER_WORK_TIP` are always empty.** Its
instances share one working tree on one branch, so the branch checked out is the tree's, not any
one instance's — recorded as one instance's work branch, it would become every instance's on the
next poll. Such a rider's `check` reads its own directory:

```yaml
    check: test -f "$RIDER_SCOPE/REVIEWED"
```

What the executor surfaces instead is **branch drift**: every `check` of an instance (the watcher's polls,
and checks at a human phase or on a stopped stretch, included) that finds the tree on a branch
other than the run's base records it, and `rider board` lists the instance under *needs you* —
"the shared working tree left `<base>` for `<branch>`". The executor does not switch back; a later
`check` back on the base clears it.

Two names are reserved and never declared as phases or as edge labels:

- **`operator`** — a built-in terminal phase. Any edge may target it. Reaching it stops the run for
  the human with the judge's stated reason.
- **`resume`** — an implicit reflexive edge on every session phase, taken when a session was cut
  short by the environment (a rate limit, a killed process). It re-enters the *same* session with a
  nudge; it never restarts the phase.

The rate-limit message shapes the classifier recognises are Claude Code 2.1.260's known strings;
none of them has been observed live in this project (no 429 was hit while it was built). A shape it
does not recognise reads `done` with "no STATUS line in the final message" — the judge relays that,
and you resume the session by hand with `rider resume`.

The graph is validated when the rider loads, and an invalid rider is refused with the reason before
anything runs: `name` equals the rider's directory name; a phase name is letters, digits, underscores
and dashes (it becomes a path segment and an event token); every edge target is a declared phase or
`operator`; `start` names a declared session phase; a human phase has a `check`; a session phase has
a `model`, non-empty `edges`, and a prompt file that exists; `limits.visits` is a positive integer;
`operator` and `resume` are not used as phase names or edge labels; `intake` and `evidence` are lists
of strings; `instances` is one glob relative to the project root (no leading `/`, no `\`, no `..`
segment) whose only wildcard is `*`, in its last segment.

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
instance you want driven and type `/rider:rider <id>`; `/rider:rider` with no argument is then
**board mode** — your view of every instance, which acts only on your word and arms no watch.

## The YAML subset

`RIDER.md` frontmatter is read by a deliberately small YAML reader, not a full parser. It supports:
block maps at 2-space indents; block lists of scalars (`- item`, indented under their key); flow
maps `{ a: x, b: { c: y } }` (nested, keys may contain spaces, may span lines until braces
balance); flow sequences `[ a, b ]`; scalars bare-to-end-of-line, `"double"` (`\"` `\\` `\n`),
`'single'` (`''`); `true`/`false`/`null`/numbers typed; `#` lines are comments, no inline comments.
Nothing else.

## Verbs

Run from the project root. Every verb is short-lived and idempotent; the one long-lived process is
the watcher, and it is detached.

```
rider — drive riders/<name>/RIDER.md one phase at a time (run from the project root)

  rider start [phase]                 fresh run: intake, then launch the start phase (or the named one)
  rider next <label> --because "…" --on <key>   take an edge of the current phase; also: resume · operator
  rider check                         classify the current session; print the block the judge reads, and its decide-with line
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
  --by judge|operator  who decided, recorded on the transition (default judge; operator for the operator's own ruling)
  --dry-run        start/next/resume/overrule print the harness command and run nothing
  --max-minutes N  await's deadline in minutes (default 60)  --binding <path>  another harness module (or RIDER_BINDING)
exit: 0 ok · 2 refused or usage · 3 await timed out
```

**A decision names what it judged.** A **stretch** is one session record of a run — a launch, or one
resume of it — and its key is `<runId>.<n>`, `n` its 1-based place in the run's sessions. `next` and
`resume` take the key of the stretch they decide on; `overrule` and `reset` take the run id. The
executor checks the key under the instance's lock and refuses a stale or mismatched one with exit 2:
a `refused:` line saying what the key judged and why it no longer applies, and a `now:` line with
the phase, the run, the latest stretch's key and outcome, and the last transition with its `because`
and who made it. The refusal is recorded as a `refused` event, except under `--dry-run`. A missing
or malformed `--on` is a usage refusal and leaves no trace. Instead of assembling a key, copy the
line `check` prints for a stopped stretch — here at the worked example's `plan` phase, for an
instance `a`:

```
decide with:  rider next <label> --instance a --on c1d1.1 --because "…"     (labels: planned · blocked · resume · operator)
```

That line, the moves printed after an `operator` stop, `status`'s `next:` line and the board's hints
carry `--rider` when the project has several riders and `--instance` when the rider declares
instances, so each runs as printed. Text `status` names the run id in its first line
(`rider <name>/<runId>`); the stretch key is in `status --json` (`key`) and on `check`'s
`decide with:` line.

`--by judge|operator` on `next`, `resume` and `reset` records who decided on the transition; the
default is `judge`, so pass `--by operator` for your own ruling. `overrule` is always recorded as
the operator's, and the executor's own moves (the visit cap, a failed launch, the watcher's
rate-limit resume) as `executor`.

### The board

`rider board` lists every instance of every rider, derived from `riders/*/RIDER.md` and each rider's
`instances` glob — so an instance that never ran is listed too — grouped in this order:

| Group | When |
|---|---|
| **needs you** | branch drift; an active run at a human phase; the last run ended at `operator`; a stretch `waiting` on a question; a running stretch whose watcher is not alive; a stopped stretch that was `intervened` (rate-limited or not); a rate-limited stretch whose watcher gave up or died; **undecided** — a `done` or `gone` stretch that stopped more than `staleDecisionMinutes` ago (default 20, `local.json`) with no decision: its judge has most likely died |
| **orphaned** | state under `.rider/<rider>/` whose instance directory no longer exists |
| **needs its judge** | a `done` or `gone` stretch that stopped more recently than that, with no decision yet |
| **running** | a running stretch with a live watcher, or a rate-limited one whose live watcher waits for the reset (with the reset time) |
| **idle** | no active run: the last one ended by a passing check or by `reset`, or the instance never ran |

Each row shows the rider, instance and scope, the phase, how long it has been in this state, what
it waits on, the latest decision (label, `by`, `because`), the run's cost and the instance's total,
the watcher's pid, and — for a stretch that waits on a decision — its `decide with:` line. Directories
the glob matched but skipped (an unsafe or reserved name) are listed with the reason, and a rider
whose `RIDER.md` does not load, or whose state is the v3 layout, is an error entry while every other
rider is still listed.

The board only reads: no lock, no `claude` call, nothing written. Its *running* is therefore what
the watcher last recorded, not a fresh poll; the row says how long ago the state was written and
whether the watcher is alive.

**`rider board --json` is the stable interface for a dashboard.** It is versioned:
`{ board: 1, generatedAt, riders, rows, skipped, errors }`, where `riders` names every rider
directory found, a row is `{ rider, instance, scope, category, phase, runId, since, waitsOn,
decision: { label, because, by } | null, runCost, instanceCost, key, decideWith, watcher, updatedAt,
statePath }`, a skipped entry is `{ rider, path, reason }`, and an error is
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
| `pollSeconds` | `30` | The watcher's poll interval |
| `staleDecisionMinutes` | `20` | How long a stopped stretch may wait for its judge's decision before `rider board` calls it undecided and lists it under *needs you* |
| `shell` | `null` | The shell used for intake, evidence and human-phase `check` commands; `null` means the resolved default (see *Platforms*) |

Keys not listed here are kept in the file but unused. The watcher's other give-up rule — three
consecutive rate-limit resumes on one phase — is fixed, not configurable.

## Platforms

Linux is the primary platform. macOS is likely to work. Windows is unverified since the
per-instance state layout: the atomic rename retries `EPERM`/`EBUSY` as graceful-fs does, but
nothing of it has run there.

`intake`, `evidence` and human-phase `check` commands are POSIX shell lines, and the platform shell
on Windows is `cmd.exe`, which cannot run them. The executor therefore resolves Git Bash explicitly:
`C:/Program Files/Git/bin/bash.exe`, then `C:/Program Files (x86)/Git/bin/bash.exe`, then plain
`bash.exe` on `PATH` — that last is a fallback worth overriding, since `bash.exe` on `PATH` may be
WSL's, a different filesystem. Set `shell` in `local.json` to point somewhere else. On every other
platform the shell is `/bin/sh`.

The `claude` executable defaults to `~/.local/bin/claude.exe` on Windows when that file exists,
because `spawnSync` does not resolve `.cmd` shims; otherwise it is plain `claude` on `PATH`. Set
`claudePath` in `local.json` to override.

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
    watch.pid       the live watcher, if any
    lock            present only while a verb holds the instance
```

A **run** is one traversal from the start phase (or a revival by `overrule`) to a human phase whose
`check` passes. It ends `done` (that check passed), `operator` (the judge routed there, a launch
failed, or the visit cap was hit), or `reset`: its record is written to `runs/`, and `state.json`
keeps `run: null` and a `lastRun` summary. **`state.json` is never deleted**, so a reader finds one
file per instance that has ever run. It carries `schema: 4`, and a `version` that goes up by one on
every committed write — for a poller to tell that it changed, not a decision key.

`events.jsonl` holds one `{ seq, at, rider, instance, runId, kind, phase, key, text }` per line, `seq`
counting from 1 per instance and `key` naming the stretch the event concerns. Its kinds come in two
families: **wake events**, which the watcher appends and `rider await` wakes on — `done`, `gone`,
`waiting`, `intervened`, `rate-limited`, `watcher-stopped` — and **record events**, which every
committed write appends — `run-started`, `phase-entered`, `decided`, `overruled`, `resumed`, `noted`,
`run-ended`, `reset`, and `refused` for a decision refused by its key. An instance's timeline can be
drawn from this file alone.

**One writer at a time per instance.** Every write goes through one store, under the instance's lock:
the file `lock`, made by exclusive create and naming its holder's pid, host and acquisition time. Each
verb holds it for its whole duration, its `claude` calls included: a launch (`start`, `next`,
`resume`, `overrule`) holds it longest, about 45 s in the worst case, and a `check` about 20 s. No
wait is ever held across it — not the watcher's poll sleep or rate-limit wait, not `await`'s poll,
not the judge's thinking: decisions are protected by their keys instead. `evidence` and `show` run
after it is released; a human phase's `check` runs inside it, since its exit decides whether the run
ends. A verb that finds the instance locked retries about every 200 ms for 60 s, then refuses with
`instance <id> is locked by pid N on <host> since <time>`. A stale lock is broken only when its
holder ran on this host and that pid is dead; a live pid's lock, or one from another host, is never
broken. Reads — `status`, `board`, and `await` unless it respawns a dead watcher — take no lock:
`state.json` and `runs/` files only ever change by an atomic rename.

These files are internal. **`rider board --json` is the stable interface** for anything that reads
the state from outside (see *The board*).

`runs/*.json` is the raw **evaluation record**. Nothing reports over it yet; analysis is a script
over `.rider/*/*/runs/` once there are enough runs to say something. What is recorded, and against
which criterion:

| Criterion | Recorded as |
|---|---|
| Restart soundness | `watcherSpawns` per session; resumes after `gone` |
| Gate precision | `handoff.after`, the commits that landed after the sessions handed over (below); `notes` at the human phase (what the operator reported, if anything) |
| Context efficiency | `cost`, `turns`, `elapsedMs` per session |
| Trajectory conformance | `intervened`, `questionRelayed`, every transition (a resume is one) with its `because` and `by` (`judge`, `operator` or `executor`), the transitions to `operator` above all |
| Transfer within class | one `runs/` file per traversal, same rider |

Cost is charged per stretch: a resumed session's record carries only what its own stretch added.

**Gate precision** is counted when a human phase's check passes: `handoff.after` keeps
`git log --oneline <tip>..<ref> -- <scope>`, where `<tip>` is what the sessions handed over (the
work tip, else `HEAD` on entering the human phase), `<ref>` is the work branch while it exists, else
the base branch, else `HEAD`, and `<scope>` is the instance's directory (`.` for `default`). Every
rider's count is path-limited, so two kinds of commit are not counted. A commit that touches only
paths outside the instance's directory — shared code several instances use — is a known undercount;
an adopter who needs it can declare an `evidence` command that uses `$RIDER_SCOPE` and its own
conventions. And a clean `--no-ff` merge commit is not counted, because any pathspec turns on git's
history simplification; the commits it brings in are.

**Known limit:** the rate-limit wait lives in the watcher process. The resume at the reset is
guaranteed only while that process lives; a watcher killed mid-wait resumes nothing by itself, and
nothing respawns one for it — `check` returns early for a session already recorded `rate-limited`,
and `rider await` only watches a running or waiting one. The run is not stranded: `rider board`
lists it under *needs you*, `rider status` shows the stretch `rate-limited` and `rider check` its
stored reset time, and `rider resume --on <key>` starts a new stretch in the same session — the judge asks
the operator before running it (see the skill).

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

**Known limit:** one watcher per live instance. Each polls `claude agents` every `pollSeconds`, which
is fine for about ten live instances; a shared poller is not built.

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

## Upgrading from the v3 layout

There is no migration. The earlier layout, v3, kept one `.rider/<name>/run.json` file per rider; an
executor that finds such a file refuses every verb, naming it: finish or `reset` that run with the
old version first, then remove `.rider/<name>/` (move its `runs/` aside first to keep the history;
nothing reads it). An active v3 run is upgraded past only once it has ended. A `state.json` whose
`schema` is not 4 is refused the same way.

The reverse is guarded too. This version creates `.rider/<name>/run.json/` as a directory holding a
`README`, so an older executor run against the project fails on every verb (`EISDIR`) instead of
finding no run and launching a paid session. Leave it in place.

## Tests

- `npm test` — the offline suite (`node --test`, zero dependencies): the core against a fake
  binding that scripts session outcomes, plus the parsers, classifiers, graph validation, edge and
  intake refusals, the visit cap, the store and its lock, decision keys, instances, the board, and
  the loop-simulator scenarios.
- `npm run smoke` — the live tier: the real binding against real sessions on haiku, a few cents.
  Run by hand before a release, never under `node --test`. Last results: 17/17 at `be850e1`
  (three runs on 2026-09-04, about $0.32 in total); 16/17 at `59c7d67` after the review fix wave
  (2 min 33 s, about $0.12) — the one failure was the zero-sample flake on the pending-subagent
  assertion described under *Verified on*, and every assertion that touches the changed code
  passed. Not rerun: the binding gained two additive fields afterwards (`lastAt` in `12de44b`,
  `stopHint` in `3bc1ea7`), covered offline, and nothing has run live on the per-instance state
  layout yet.

## Verified on

The claims the design leaves to be checked against a real install and a real account, filled in at
release (§ numbers refer to the design notes, which are not shipped in this repo). Every row was
measured before the per-instance state layout, and none has been rerun on it:

| Claim | Where | Verified | Result |
|---|---|---|---|
| `/rider` resolves (or only `/rider:rider`) | §3.4 | 2026-09-04, Claude Code 2.1.260 | **PASS for `/rider:rider`** — a session launched with that prompt expanded the skill (the turn carries `<command-name>/rider:rider</command-name>` followed by the SKILL.md body) and went on to run the executor. Bare `/rider` was **not tried**, so it stays unverified; `plugin details rider` lists the component as `rider` |
| `${CLAUDE_PLUGIN_ROOT}` expands in the skill's Bash calls; which allowlist line prevents prompts | §3.4 | 2026-09-04, Claude Code 2.1.260 | **Expansion PASS** — it reached the skill body already substituted, as an absolute forward-slash path, and every `node "…/scripts/rider.mjs"` call ran. It is the plugin's *install root*: installed from a local `directory` marketplace that is the checkout itself, not the `~/.claude/plugins/cache/` copy. **The allowlist question is not discriminated** — under `--permission-mode auto` no prompt appeared, so neither line was exercised; both are kept above. The GitHub-source install route was not exercised. |
| The detached watcher outlives its spawning process | §4.6 | `npm run smoke` (the two watcher assertions) | **PASS as measured** — it outlived `rider start`, a `spawnSync`'d process that had already exited, and appended the phase's `done` event. The same shape was seen again in the live judge session. It was **not** measured against a judge session's own exit |
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
