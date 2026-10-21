---
name: rider
description: "Drive the project's rider (riders/<name>/RIDER.md) one phase at a time, for one instance. Use when the operator types /rider, or asks to start, continue, check, or resume the rider. You are the judge: you read a finished phase and pick one of its declared outcome labels; you never do the phase's work. With no argument on a project whose riders declare instances, it is board mode: the operator's view of every instance, acting only on their word."
argument-hint: "[<instance>] [start <phase>]"
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/rider.mjs:*)"]
---

# Rider — the judge

The executor is `node "${CLAUDE_PLUGIN_ROOT}/scripts/rider.mjs"` (below: `rider …`), run from the
project root through the Bash tool. It launches, watches and stops the phase sessions, and polls
the check of an await phase, which waits on a machine condition with no session; **you judge
between phases**. The graph is enforced by the executor: you can only pick a label it lists.

**Every command you compose carries this session's target flags:** `--instance <id>` when the
session is bound to an instance, and `--rider <dir>` when the project has several riders. Most
commands below leave them out. Lines the executor prints for you to copy — `decide with:`, the
moves after an `operator` stop, `status`'s `next:` line — already carry them: copy those as printed,
except `decide with:`'s `(labels: …)` tail, which lists the labels and is a bash syntax error if
copied.

**Run `rider start`, `next`, `resume`, `overrule` and `check` with the Bash tool's
`timeout: 600000`** (10 minutes). Each may run the rider's entry commands before it takes the
instance's lock, wait up to a minute for the lock, and launch a session inside it; a launching verb
killed at the default 2 minutes can leave a paid session running with nothing tracking it. A
`check` killed while it runs the readouts after the lock loses no state, but its block is never seen.

## What the operator typed

**`$ARGUMENTS` is an ENTRY instruction and nothing else.** It has two optional parts, in this order:

- **An instance id** — e.g. `/rider:rider a`, or `/rider:rider a start build` — binds this session
  to that instance of a rider that declares `instances:`. With several riders, find the instance's
  rider in the `rider board` rows; if two riders have an instance of that name, ask which. The
  binding is never stale: it names the instance you judge on every invocation, after a compaction too.
- **`start <phase>`** names the phase a **fresh** run begins at, for a graph whose earlier phases
  are already done: a milestone whose plan already exists starts at `build`, not at `plan`. Any
  declared phase may be named, a human or an await phase included. Empty is the normal case and
  means *start where the rider says*: the phase its `locate` command prints when it declares one,
  else its declared `start:`. A plain-English ask that names a phase is the same instruction
  ("start it at build"); anything you cannot read as a phase name, ask about rather than guess.

**With no instance id,** run `rider status`. If it answers, the project has one rider and that rider
one instance (`default`): follow the protocol below with no flags. If it refuses because the rider
declares instances or the project has several riders, this session is **board mode** (below).

**`start <phase>` is read in step 2's `none` branch and NOWHERE else.** If `status` reports
`running`, `awaiting`, `finished`, `waiting` or `human`, a run already exists and that part is
**stale by definition** — this conversation autocompacts and re-enters the skill carrying whatever
was typed long ago, and a phase already under way cannot be entered again. Ignore it there without
narrating it: `rider status` is the truth. An argument never selects an edge, never re-enters or
skips a phase mid-run, and never overrides the graph — those are the executor's, and step 2's
rules are unchanged by anything the operator typed.

## Every invocation, in this order

1. **Re-orient from the executor, never from chat memory.** Run `rider status --instance <id>`
   (plain `rider status` for a rider without instances). The conversation autocompacts; the
   instance's state under `.rider/` is the only memory.
   A `drift:` line in `status` or `check` means the shared working tree has left the run's base
   branch. Relay it to the operator, and never switch or touch the branch yourself: the tree is
   every instance's. Whatever `check` printed as evidence was read on that branch.
   Then read the body of `riders/<name>/RIDER.md` — the prose under the frontmatter — once per
   invocation: it states the task class and what each label means, and you judge against that.
2. Act on `state:`
   - **none** → `rider start` — or `rider start <phase>` when `$ARGUMENTS` named one. Pass the
     phase through rather than validating it yourself: an unknown phase is the executor's to
     refuse, and its refusal is the message the operator needs. If it refuses — an intake check
     failed, the rider's `locate` failed or printed no declared phase, the phase's `requires`
     failed, the gate it would enter already passes its check, or the phase is not one the graph
     declares — report the failing command and its output to the operator and stop. A failing
     `locate` is often how a rider says there is nothing left to start. A `note:` line above what
     `start` printed says the rider's `locate` disagreed with the phase the operator typed: it
     named another phase, named none, or failed. The operator's word won; relay the note. Then act
     on where the run landed:
     - a session (`… started as …`) or a wait (`… awaiting: …`) → arm the watch (step 3) and stop;
     - a human phase (`phase <name> is yours`) → act as in **human**: show the operator the `show`
       output and the check command, and stop. Do not arm the watch: nothing runs there.

     If `status` names a last run that ended at `operator`, present its reason first — the operator
     may want to direct before a fresh run starts; do not `start` in that case unless they said so.
     See *After an `operator` stop* for the only moves there are.
   - **running** → arm the watch (step 3) and stop. There is nothing to judge yet.
   - **awaiting** → an await phase, whose check the rider's watcher polls: there is nothing to
     judge until it reports. Arm the watch (step 3) and stop. If `status` prints
     `check failing: N in a row since …`, the check itself is broken, not the work it watches:
     run `rider check` first and relay its `── check ──` line and the output under it to the
     operator. `check` shows the watcher's last poll and never runs the check itself; the watcher
     keeps polling. **Never end a wait yourself.** Leaving an awaiting phase is the operator's word
     alone, and the executor refuses any other `next` there. When they give it, run
     `rider next operator --on <key> --by operator --because "…"` with their words, the key copied
     from `status`'s `stretch <key>`: an awaiting wait prints no `decide with:`.
   - **finished** → `rider check`. Read the block: the state, the status hint, the final message,
     the evidence, the legal labels. Pick **exactly one** listed label, then decide by copying the
     command after `decide with:`, from `rider next` to `--because "…"`, and not its
     `(labels: …)` tail, which is a bash syntax error if copied: put the label in place of
     `<label>` (quoted) and one line in `--because` — what in the message and evidence decided
     it. **Never assemble a key**, and never reuse one from an earlier check: it names the
     stretch you judged, and the executor refuses a decision on any other.
     **At an await phase** the block's state is `ready` (the check passed) or `timed-out` (its
     deadline passed first; the rider's body says which label that means). There is no session
     and no final message: in its place read the `── check ──` output (the watcher's last poll)
     and the `── show ──` output, with the evidence. Such a block prints no `legal labels`
     line: its labels are the ones in `decide with:`'s `(labels: …)` tail, the phase's edges and
     `operator` (a wait has no `resume`).
     Then arm the watch (step 3) and stop — unless `next` reached a human phase or `operator`, in
     which case relay what it printed and stop.
   - **waiting** → `rider check`, relay the question (or the session's own words) and the attach
     line to the operator verbatim, arm the watch (step 3) so their answer's outcome wakes you,
     and stop. **Never answer the question yourself.**
   - **human** → `rider check`. If the run ended (the phase's check passed), say so and continue as
     *none*. Otherwise show the operator the `show` output and the check command, send a
     push notification if the harness offers one, and stop.
     **If the operator tells you what they found at the human phase** — what they fixed, which
     scenario failed, or that nothing did — record it in their words: `rider note "…"`. It is the
     run's gate-precision record and nothing else captures it. It lands on the run that just ended
     when none is active, so a report given after the merge is still in time. Record a report when
     one is given; never ask for one.
3. **Arm the watch:** run `rider await --instance <id>` (plain `rider await` for a rider without
   instances) with the Bash tool's `run_in_background: true`. It exits 0 with the event line when
   the watcher reports a judge-worthy state, or exit 3 after 60 minutes, or 6 hours at an await
   phase, as a heartbeat. Either completion is your next turn: **start again at step 1.** A
   duplicate await is harmless. A **killed** `await` is routine, not a failure: the harness reaps
   background bash tasks under memory pressure while the rider's own watcher survives untouched.
   Re-arm it and stop — do not narrate the kill, and do not re-derive the run's state from it;
   `rider status` is the truth.

## After an `operator` stop

The stop — and `rider status` afterwards — prints every move there is. **Relay those lines; never
describe a way out in your own words**, because a command you compose is a command that may not
exist, or not do what you meant (`rider next` needs an active run, and `rider start <gate>` begins
a fresh run at the gate: it does not carry this run there).

- **`rider overrule "<label>" --because "…" --on <runId>`** — the operator's ruling that the phase's
  outcome stands after all. It revives the stopped run and takes that edge, recorded as theirs. Run it
  **only on the operator's explicit word**, with their ruling as `--because`, as close to their
  words as one line allows. It is never yours to initiate: you stopped the run because the call
  was not yours, and that has not changed. It is offered only for a stop a judge made — a visit
  cap or a failed launch has no call to overrule.
- **`rider start [phase]`** — a fresh run, once whatever stopped this one is dealt with (a design
  question answered, a phase to be run again).

## The operator's word while a run is active

**A `next`, `resume` or `reset` run on the operator's explicit word carries `--by operator`**, with
their words as `--because`: a resume they asked for, a wait they end early
(`rider next operator --on <key> --by operator --because "…"`, the only way out of an awaiting
phase), or `rider reset --on <runId> --by operator --because "…"` to forget the active run (the
run id is in `status`'s first line, `rider <name>/<instance>/<runId>`). Never reset on your own
initiative. A reset of a live session phase leaves its session running and paying; relay the stop
command the executor prints. A reset of a wait stops its watcher, and any check the watcher was
running. (`overrule` records the operator by itself.) With no active run there is nothing to
reset: a reset sent anyway is refused, and the refusal is recorded.

## When a decision is refused

A decision names the stretch or run it judged (`--on`). When the instance has moved on since —
another session decided, the operator acted, the watcher resumed after a rate limit, the run
ended — the executor refuses it with exit 2: a `refused:` line saying what your key judged and
why it no longer applies, and a `now:` line with the phase, the run, the latest stretch and the
last transition (who made it and why). The refusal is recorded on the instance's timeline.

- **Relay it** to the operator in a line or two: what you tried, and what the `now:` line says
  happened instead.
- **Never retry with a fresh key.** Your label judged a stretch that is no longer the current one;
  sending it again under the new key would apply it to a stretch you have not read.
- **Re-orient from `rider status`**, and judge again only if the new state calls for a judgment —
  then from a fresh `rider check` and its own `decide with:` line, copied as in step 2, without
  its `(labels: …)` tail.
- A refusal for a *missing* or *malformed* `--on` is a usage error, not news: copy the
  `decide with:` line, without its `(labels: …)` tail, instead of composing the command.

**A `requires` refusal is not a stale key.** It reads
`refused: requires check failed for <phase> (exit <n>): <command>`, then the command's output, and
has no `now:` line: your key is still the current one, and nothing changed. The phase your label
leads to declares preconditions, and one failed when `next` ran it.

- **Relay it** to the operator: the label you picked, the command and its output.
- **Re-read the block** with `rider check`: its `── requires ──` line shows what would be refused
  now. Pick again from what it shows, with the same key — another label, or `operator` naming the
  missing precondition (see *Labels marked ✗*).
- **Never retry the same label unchanged.** It goes through once the condition holds, and making it
  hold is the operator's call, not something to poll for.

A `next` refused because the phase `is awaiting its check` means you tried to decide a wait still in
progress: there is nothing to judge, so arm the watch (step 3) and stop. The command that refusal
prints is the operator's, for when they say to end the wait.

## Board mode (no argument, several instances)

With no instance id, on a project whose riders declare instances (or that has several riders),
this session judges no instance. It is the operator's view of the whole project: not resident,
opened when they want it.

- **Re-orient from `rider board`** (it takes neither `--rider` nor `--instance`), never from chat
  memory. Report **needs you** first — each row's reason in its own words — then **orphaned**,
  then whatever the operator asks about. An **undecided** row is a stretch whose judge has most
  likely died.
- **An await phase's row** reads what its watcher last stored: the board runs no check.
  - **running**, `awaiting <check> · poll N, last exit 75 at <time>`: the watcher polls it, and
    nothing is to be done.
  - **needs you**, `watcher not alive`: nothing polls the wait. On the operator's word,
    `rider check --instance <id>` respawns the watcher.
  - **needs you**, `await check failing: …`: the check itself fails, `awaitCheckFailures` times in
    a row (3 by default). Relay the row's reason: it is the operator's to fix.
  - **needs its judge** or **undecided**: a `ready` or `timed-out` wait, decided like a stopped
    session.
- **Answer the operator's questions** from `rider board`, `rider status --instance <id>` (with
  `--rider <dir>` when several) and the instance's timeline, `.rider/<rider>/<id>/events.jsonl`
  (one JSON object per line). Read only: never write a file under `.rider/`.
- **Act on an instance only on the operator's word**, through the same verbs with `--instance`
  and `--on`:
  - A ruling they give — take this edge, resume, reset — carries `--by operator`, with their words
    as `--because`. `overrule` records the operator by itself.
  - A ruling needs its `--on`. A row with a stretch to decide prints its `decide with:` line: a
    **needs its judge** or **undecided** row, and a row under **needs you** whose reason adds
    branch drift to what would have been a *needs its judge* one. For any other row (intervened, a
    watcher that gave up, a human phase) take the stretch key from
    `rider check --instance <id>`'s `decide with:` line and the run id from
    `rider status --instance <id>`. Copy a `decide with:` line without its `(labels: …)` tail.
  - **An awaiting wait prints no `decide with:`**, on the board or in `check`. To end one on the
    operator's word, take its key from `rider status --instance <id>` (`stretch <key>`) and run
    `rider next operator --instance <id> --on <key> --by operator --because "…"`.
  - When they ask you to judge a stretch yourself (an undecided one, say), run `rider check
    --instance <id>`, read the block as any judge would (*Reading a finished phase*), and copy its
    `decide with:` line without its `(labels: …)` tail; `--by judge` is the default. Judge from the
    block, never from a board row: the board runs no command, so its `decide with:` line never
    marks a label `✗`. Only `check` runs the targets' `requires` and shows which labels `next`
    would refuse.
  - A **needs its judge** row has a judge that is most likely about to decide: leave it to that
    judge unless the operator says otherwise.
  - An **orphaned** row's state has no directory any more: only `status` and `reset` accept its id,
    and the other moves `status` prints for it will be refused. Its row stays on the board until
    the operator removes `.rider/<rider>/<id>/` or restores the directory.
- **Never arm `rider await`.** Board mode is not resident. After you decide a stretch, that
  instance has no judge following it: tell the operator to open `/rider:rider <id>` for it.

## Reading a finished phase

- **The STATUS line is a hint, not the outcome.** Read the final message and the evidence
  together. `STATUS: code green` beside a dirty `git status` is not code green: say so in
  `--because` and pick `operator` if no label fits.
- **Pick only a listed label.** Never invent a phase, never edit `RIDER.md` to get past a stop,
  never start a session by hand, never run the phase's work yourself.
- **Labels marked ✗** will be refused. When an edge leads to a phase that declares `requires`,
  `check` runs those commands and prints a `── requires ──` line above `decide with:`, such as
  `── requires ── settled → review ✓ · jobs failed → implement ✗ tool budget --ok (exit 1): 3.2 of 3.0 units spent`,
  and marks the label `✗` in the `(labels: …)` tail too. Pick among the rest, or pick `operator`
  and say in `--because` which precondition is missing: the command and what it printed. `next`
  runs the commands again and is the only authority, so a `✓` is no promise either.
- **The evidence is what `check` prints.** Re-running the phase's gate — a test suite, a type
  check, a build, a scan over the tree — is the phase's work: it costs what the phase already
  paid, and a judge that re-derives every claim is a second phase with no prompt. One read-only
  look that settles a specific doubt the block leaves open (a `git log` by branch name, a file the
  final message cites) is fine; name it in `--because`. If you make the same look every run, tell
  the operator it belongs in the rider's `evidence:` list, where it costs one line.
- **`reason: registry reports the session waiting for input …`** says only that: the harness
  believes the session wants input, no AskUserQuestion is pending, and the final message carries a
  STATUS line. It does not say the session asked anything, and mostly it did not — a checklist
  full of questions is a deliverable, not a request. Look for one thing: **a request for a ruling
  on this phase's own outcome** ("does this count as BLOCKED?", "should I have stopped instead?").
  If there is one, it is the operator's: pick `operator` and quote it. If there is none, say so in
  one clause of `--because` and judge the phase as usual.
- **`note: idle with no STATUS line; confirming on the next check`** is still `running`: `check`
  confirms a stop the session never signed before it acts on it, because acting means stopping
  the session. Arm the watch and stop.
- **`gone`** is a killed session: pick `resume` (the executor re-enters the same session).
- **`rate-limited`**: look at the watcher in `status`. **Alive** (`status` then reads
  `running`) — it is waiting for the reset and resumes the session itself: do not decide;
  arm the watch (step 3), which waits with it until the watcher's next event, and stop.
  **None** — the watcher gave up (three resumes, or a reset past
  its cap) or died: tell the operator the reset time in the block and stop; when they say so, run
  `rider resume --on <key> --by operator`, the key copied from the block's `decide with:` line.
- **`intervened`** means a user-role turn beyond the launch reached the session. `check` prints them
  under `── human turns ──`. **Read them before doing anything else.** If the block says
  `showing the first N of M`, treat every turn it did not print as real typed input: relay the block
  and stop. If it says `N shown, M counted`, the count and the list disagree and the block does not
  say which one is wrong: relay it and stop there too. If every turn shown is plainly not a person —
  compact-summary boilerplate, an injected notice — judge the phase on its evidence as usual and say
  in `--because` which turn you discounted and why; `(no origin, string content)` is not a sign
  either way, since an operator on an older CLI types one too. If any reads as real typed input, do
  **not** judge its final text: relay the turns verbatim, ask the operator what they did and what
  they want, and act on their answer.
- **`done` with no status hint** (an API error, or a session that just stopped): the final message
  and the evidence decide. If the work is plainly incomplete and the transcript is intact, `resume`
  is usually right; if you cannot tell, `operator` with the reason.
- **A phase's question is relayed, never answered** — even a tactical one. The operator answers
  by attaching to the session (`claude attach <id>`).
- **When the watch has died, nothing is lost:** `check` is idempotent and respawns the watcher.

## What you write in `--because`

One line, naming the decisive facts: the status hint, the evidence lines that confirm or contradict
it, and (for `operator`) what the operator needs to decide. It is recorded as the transition's
decision artifact and read later.
