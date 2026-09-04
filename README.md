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

For by-hand use outside a session the executor is also `npm i -g`-able (`package.json` declares a
`rider` bin); the plugin is the primary route.

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
| `name` | yes | Identifier; also the session-name prefix and the state directory name. Letters, digits and dashes. Usually equal to the directory name; `--rider` matches the directory |
| `start` | yes | The session phase a fresh run begins at (`rider start <phase>` overrides it) |
| `phases` | yes | Map of phase name → phase (below) |
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
anything runs: a phase name is letters, digits, underscores and dashes (it becomes a path segment and
an event-line token); every edge target is a declared phase or `operator`; `start` names a declared session
phase; a human phase has a `check`; a session phase has a `model`, non-empty `edges`, and a prompt
file that exists; `limits.visits` is a positive integer; `operator` and `resume` are not used as
phase names or edge labels; `intake` and `evidence` are lists of strings.

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
you at a human phase or at `operator`.

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
  rider next <label> --because "…"    take an edge of the current phase; also: resume · operator
  rider check                         classify the current session; print the block the judge reads
  rider resume                        re-enter the current session after a rate limit or a kill
  rider await [--max-minutes N]       block until the watcher's next event (exit 0) or N min (exit 3)
  rider status                        the run at a glance
  rider note "…"                      append to the run record
  rider reset                         forget the active run (its record stays under .rider/<name>/runs/)
  rider watch                         the detached watcher itself (spawned by start/next/resume/check)

  --rider <directory name>   when the project has several riders   --json   machine-readable output
  --dry-run        start/next/resume print the harness command and run nothing
  --max-minutes N  await's deadline in minutes (default 60)  --binding <path>  another harness module (or RIDER_BINDING)
exit: 0 ok · 2 refused or usage · 3 await timed out
```

## `local.json`

Machine facts and per-machine overrides live in `.rider/<name>/local.json`, which is **not
committed** (it sits inside the gitignored `.rider/`). Every key is optional; the defaults are:

| Key | Default | Meaning |
|---|---|---|
| `claudePath` | `null` | Path to the `claude` executable; `null` means the binding's default (see *Windows*) |
| `models` | `{}` | Per-phase model overrides, `{ "<phase>": "<model>" }`, winning over the phase's `model` |
| `advisor` | `null` | Passed as `--advisor <model>` when set; off by default |
| `permissionMode` | `"auto"` | The `--permission-mode` the phase sessions run under |
| `maxWaitHours` | `6` | The watcher gives up on a rate-limit reset further away than this and emits `rate-limited` for the operator |
| `pollSeconds` | `30` | The watcher's poll interval |
| `shell` | `null` | The shell used for intake, evidence and human-phase `check` commands; `null` means the resolved default (see *Windows*) |

Keys not listed here are kept in the file but unused. The watcher's other give-up rule — three
consecutive rate-limit resumes on one phase — is fixed, not configurable.

## Windows

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

State lives under `.rider/<name>/` at the project root:

```
.rider/lemmaria/
  run.json        the active run: phase, visits, transitions, sessions, notes
  runs/           finished runs, one file each, named by start time (`:` and `.` written as `-`)
                  and run id
  logs/           one harvest per session stop: ids, registry entry, outcome, cost, turns,
                  question, final text, transcript path, transcript tail
  logs/watch.log  the detached watcher's own output
  events.log      the watcher's event stream, one line per judge-worthy state
  watch.pid       the live watcher, if any
  local.json      machine facts and overrides (above)
```

A **run** is one traversal from the start phase to a human phase whose `check` passes. It ends
`done` (that check passed), `operator` (the judge routed there, a launch failed, or the visit cap
was hit), or `reset` — and its record moves from `run.json` to `runs/`.

`runs/*.json` is the raw **evaluation record**. Nothing reports over it yet; analysis is a script
over `.rider/*/runs/` once there are enough runs to say something. What is recorded, and against
which criterion:

| Criterion | Recorded as |
|---|---|
| Restart soundness | `watcherSpawns` per session; resumes after `gone` |
| Gate precision | `notes` at the human phase (what the operator reported, if anything) |
| Context efficiency | `cost`, `turns`, `elapsedMs` per session |
| Trajectory conformance | `intervened`, `questionRelayed`, transitions to `operator` with their `because` |
| Transfer within class | one `runs/` file per traversal, same rider |

Cost is charged per stretch: a resumed session's record carries only what its own stretch added.

**Known limit:** `check` is not locked. A hand-run `rider check` and the watcher can classify the
same stop at the same moment, and both write `run.json` — each from the copy it loaded, so the two
writes are not always the same content. The last writer wins, and it can drop a counter the other
had just advanced (`goneSightings`, `signedOffTurns`) by one sighting. That costs at most one extra
poll before the counter is earned again; the design accepts this.

**Known limit:** the rate-limit wait lives in the watcher process. The resume at the reset is
guaranteed only while that process lives; a watcher killed mid-wait resumes nothing by itself. The
run is not stranded — the next `rider check`, or the judge's next `rider await` poll, respawns a
watcher, which re-reads the stored `rateLimit.resetAt` and re-enters the wait — but the session
stays rate-limited until one of those happens.

**Known limit:** the launch is not atomic. If the executor dies between the `claude` CLI creating
the session and `run.json` being written, that session is orphaned — it keeps running, and paying,
with nothing tracking it. It is listed by `claude agents`; remove it by hand (`claude stop <id>`).

## Tests

- `npm test` — the offline suite (`node --test`, zero dependencies): the core against a fake
  binding that scripts session outcomes, plus the parsers, classifiers, graph validation, edge and
  intake refusals, the visit cap, and the loop-simulator scenarios.
- `npm run smoke` — the live tier: the real binding against real sessions on haiku, a few cents.
  Run by hand before a release, never under `node --test`.

## Verified on

The claims the design leaves to be checked against a real install and a real account, filled in at
release (§ numbers refer to the design notes, which are not shipped in this repo):

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
