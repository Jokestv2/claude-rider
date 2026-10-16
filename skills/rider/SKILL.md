---
name: rider
description: "Drive the project's rider (riders/<name>/RIDER.md) one phase at a time. Use when the operator types /rider, or asks to start, continue, check, or resume the rider. You are the judge: you read a finished phase and pick one of its declared outcome labels; you never do the phase's work."
argument-hint: "[start <phase>]"
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/rider.mjs:*)"]
---

# Rider — the judge

The executor is `node "${CLAUDE_PLUGIN_ROOT}/scripts/rider.mjs"` (below: `rider …`), run from the
project root through the Bash tool. It launches, watches and stops the phase sessions; **you judge
between phases**. The graph is enforced by the executor: you can only pick a label it lists.

## What the operator typed

**`$ARGUMENTS` is an ENTRY instruction and nothing else.** The one form is `start <phase>` — e.g.
`/rider:rider start build` — naming the phase a **fresh** run begins at, for a graph whose earlier
phases are already done: a milestone whose plan already exists starts at `build`, not at `plan`.
Empty is the normal case and means *start at the graph's declared `start:`*. A plain-English ask
that names a phase is the same instruction ("start it at build"); anything you cannot read as a
phase name, ask about rather than guess.

**It is read in step 2's `none` branch and NOWHERE else.** If `status` reports `running`,
`finished`, `waiting` or `human`, a run already exists and the argument is **stale by
definition** — this conversation autocompacts and re-enters the skill carrying whatever was typed
long ago, and a phase already under way cannot be entered again. Ignore it there without
narrating it: `rider status` is the truth. An argument never selects an edge, never re-enters or
skips a phase mid-run, and never overrides the graph — those are the executor's, and step 2's
rules are unchanged by anything the operator typed.

## Every invocation, in this order

1. **Re-orient from the executor, never from chat memory.** Run `rider status`. The conversation
   autocompacts; `run.json` is the only memory.
   Then read the body of `riders/<name>/RIDER.md` — the prose under the frontmatter — once per
   invocation: it states the task class and what each label means, and you judge against that.
2. Act on `state:`
   - **none** → `rider start` — or `rider start <phase>` when `$ARGUMENTS` named one. Pass the
     phase through rather than validating it yourself: an unknown phase is the executor's to
     refuse, and its refusal is the message the operator needs. If it refuses (an intake check
     failed, or the phase is not one the graph declares), report the failing command
     and its output to the operator and stop. If it started a phase, arm the watch (step 3) and stop.
     If `status` names a last run that ended at `operator`, present its reason first — the operator
     may want to direct before a fresh run starts; do not `start` in that case unless they said so.
     See *After an `operator` stop* for the only moves there are.
   - **running** → arm the watch (step 3) and stop. There is nothing to judge yet.
   - **finished** → `rider check`. Read the block: the state, the status hint, the final message,
     the evidence, the legal labels. Pick **exactly one** listed label and run
     `rider next "<label>" --because "<one line: what in the message and evidence decided it>"`.
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
3. **Arm the watch:** run `rider await` with the Bash tool's `run_in_background: true`. It exits 0
   with the event line when the watcher reports a judge-worthy state, or exit 3 after 60 minutes as
   a heartbeat. Either completion is your next turn: **start again at step 1.** A duplicate await is
   harmless. A **killed** `await` is routine, not a failure: the harness reaps background bash
   tasks under memory pressure while the rider's own watcher survives untouched. Re-arm it and
   stop — do not narrate the kill, and do not re-derive the run's state from it; `rider status`
   is the truth.

## After an `operator` stop

The stop — and `rider status` afterwards — prints every move there is. **Relay those lines; never
describe a way out in your own words**, because a command you compose is a command that may not
exist (`rider start` refuses a human phase, and `rider next` needs an active run).

- **`rider overrule "<label>" --because "…"`** — the operator's ruling that the phase's outcome
  stands after all. It revives the stopped run and takes that edge, recorded as theirs. Run it
  **only on the operator's explicit word**, with their ruling as `--because`, as close to their
  words as one line allows. It is never yours to initiate: you stopped the run because the call
  was not yours, and that has not changed. It is offered only for a stop a judge made — a visit
  cap or a failed launch has no call to overrule.
- **`rider start [phase]`** — a fresh run, once whatever stopped this one is dealt with (a design
  question answered, a phase to be run again).

## Reading a finished phase

- **The STATUS line is a hint, not the outcome.** Read the final message and the evidence
  together. `STATUS: code green` beside a dirty `git status` is not code green: say so in
  `--because` and pick `operator` if no label fits.
- **Pick only a listed label.** Never invent a phase, never edit `RIDER.md` to get past a stop,
  never start a session by hand, never run the phase's work yourself.
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
- **`rate-limited`** means the watcher gave up (three resumes, or a reset past its cap). Tell the
  operator the reset time in the block and stop; run `rider resume` when they say so.
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
