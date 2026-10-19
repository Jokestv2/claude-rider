#!/usr/bin/env node
// scripts/rider.mjs — the executor's verbs (§4.1). Text out for the judge, --json for scripts.
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { collectBoard, hasState } from "./lib/board.mjs";
import { check } from "./lib/check.mjs";
import { createContext } from "./lib/context.mjs";
import { render } from "./lib/render.mjs";
import { discoverRiders, listInstances, loadRider } from "./lib/rider-md.mjs";
import { loadLocal } from "./lib/state.mjs";
import { guardV3, instancePaths, readState, riderPaths } from "./lib/store.mjs";
import * as verbs from "./lib/verbs.mjs";
import { awaitEvent, watchLoop } from "./lib/watch.mjs";

const USAGE = `rider — drive riders/<name>/RIDER.md one phase at a time (run from the project root)

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
exit: 0 ok · 2 refused or usage · 3 await timed out`;

/** `--because "-x is missing"` is a value, not a flag; parseArgs alone calls it ambiguous and refuses.
 *  The token after `--because` is always its value — a judge's reason is free text. */
function joinBecause(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--because" && i + 1 < argv.length) out.push(`--because=${argv[++i]}`);
    else out.push(argv[i]);
  }
  return out;
}

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: joinBecause(argv), allowPositionals: true,
    options: { rider: { type: "string" }, instance: { type: "string" }, because: { type: "string" }, on: { type: "string" }, by: { type: "string" }, json: { type: "boolean" }, "dry-run": { type: "boolean" }, "max-minutes": { type: "string" }, binding: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [verb = "status", ...args] = positionals;
  return { verb, args, flags: { ...values } }; // parseArgs' values has a null prototype; deepEqual cares
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), stdout = console.log, stderr = console.error } = {}) {
  let cli;
  try { cli = parseCli(argv); } catch (e) { stderr(`${e.message}\n${USAGE}`); return 2; }
  if (cli.flags.help) { stdout(USAGE); return 0; }
  // Every failure before or during dispatch is a refusal: one line (a JSON object under --json), exit 2 — never a stack trace.
  const fail = (message) => { if (cli.flags.json) stdout(JSON.stringify({ ok: false, error: message })); else stderr(message); return 2; };
  // Every rider and every instance (§10): before a rider is picked, so --rider and --instance mean nothing here. A read:
  // no binding, no lock, no v3 guard written.
  if (cli.verb === "board") {
    try { const b = collectBoard(cwd); stdout(cli.flags.json ? JSON.stringify(b, null, 2) : render("board", b)); return 0; } catch (e) { return fail(e.message); }
  }
  // The executor records its own stops itself; by hand, a decision is a judge's or the operator's (§9).
  if (cli.flags.by !== undefined && cli.flags.by !== "judge" && cli.flags.by !== "operator") return fail(`--by is judge or operator, not "${cli.flags.by}"\n${USAGE}`);
  const riders = discoverRiders(cwd);
  const pick = cli.flags.rider ?? null;
  const found = pick ? riders.find((r) => r.name === pick) : riders.length === 1 ? riders[0] : null;
  if (!found) {
    const have = riders.map((r) => r.name).join(", ");
    if (pick) return fail(`no rider named ${pick}; have: ${have || "none"}`);
    return fail(riders.length ? `several riders here: ${have} — pass --rider <directory name>` : `no riders/*/RIDER.md under ${cwd}`);
  }
  const maxMinutes = Number(cli.flags["max-minutes"] ?? 60);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) return fail(`--max-minutes must be a positive number\n${USAGE}`);
  try {
    const rider = loadRider(found.file);
    const instance = resolveInstance(cwd, rider, cli.flags.instance);
    // An orphan can be inspected and cleared, nothing more (§9): nothing else may act for a directory that is gone.
    if (instance.orphaned && cli.verb !== "status" && cli.verb !== "reset") return fail(`instance ${instance.id} has state but no directory (orphaned) — only status and reset accept it`);
    const rp = riderPaths(cwd, rider.name);
    guardV3(rp);
    const local = loadLocal(rp);
    const bindingPath = cli.flags.binding ?? process.env.RIDER_BINDING ?? null;
    const bindingUrl = bindingPath ? pathToFileURL(bindingPath).href : new URL("./bindings/claude-code.mjs", import.meta.url).href;
    const { createBinding } = await import(bindingUrl);
    const binding = createBinding({ claudePath: local.claudePath, advisor: local.advisor, launchArgs: local.launchArgs, permissionMode: local.permissionMode });
    // RIDER_NO_WATCHER=1: tests drive verbs from one process and must not get a real detached watcher
    // racing them over the same state files; the smoke tier keeps the real one on purpose.
    const ctx = createContext({ rider, instance, root: cwd, local, binding, riderCount: riders.length, ...(process.env.RIDER_NO_WATCHER ? { spawnWatcher: () => false } : {}) });
    const out = (r) => stdout(cli.flags.json ? JSON.stringify(r, null, 2) : render(cli.verb, r));
    const dryRun = !!cli.flags["dry-run"];
    const { on, by } = cli.flags;
    const because = cli.flags.because ?? null;
    let r;
    switch (cli.verb) {
      case "start": r = verbs.start(ctx, { phase: cli.args[0] ?? null, dryRun }); break;
      case "next": r = verbs.next(ctx, cli.args[0], { on, because, by, dryRun }); break;
      case "check": r = check(ctx); break;
      case "resume": r = verbs.resume(ctx, { on, because, by, dryRun }); break;
      case "overrule": r = verbs.overrule(ctx, cli.args[0], { on, because, dryRun }); break;
      case "status": r = verbs.status(ctx); break;
      case "note": r = verbs.note(ctx, cli.args.join(" ")); break;
      case "reset": r = verbs.reset(ctx, { on, because, by }); break;
      case "await": r = awaitEvent(ctx, { maxMinutes }); out(r); return r.ok ? 0 : 3;
      case "watch": return runWatch(ctx, local, stdout);
      default: return fail(`unknown verb "${cli.verb}"\n${USAGE}`);
    }
    out(r);
    return r.ok === false ? 2 : 0;
  } catch (e) {
    return fail(e.message);
  }
}

/** The instance a verb acts on (§9). Matched against the directories that exist, never just checked for shape: the
 *  id becomes a path under .rider/, and a guess at an id must not create state for an instance nobody declared. An id
 *  with state but no directory (renamed or deleted) is an orphan: `main` lets only status and reset take it. */
export function resolveInstance(root, rider, id = null) {
  const { declared, instances } = listInstances(root, rider);
  if (!declared && (id == null || id === "default")) return { id: "default", scope: ".", declared: false };
  const found = declared ? instances.find((i) => i.id === id) : null;
  if (found) return { id: found.id, scope: found.scope, declared: true };
  if (hasState(root, rider.name, id)) return { id, scope: readState(instancePaths(root, rider.name, id))?.scope ?? null, declared: true, orphaned: true };
  if (!declared) throw new Error(`${rider.name} declares no instances — omit --instance`);
  const have = instances.map((i) => i.id).join(", ") || "none";
  if (id == null) throw new Error(`${rider.name} declares instances — pass --instance <id>; have: ${have}`);
  throw new Error(`${rider.name} has no instance "${id}" — pass --instance <id>; have: ${have}`);
}

/** The watcher process. Its pid file is written and removed under the instance lock, like every other write; the
 *  removal stays conditional, since by then the file may name a newer watcher. */
function runWatch(ctx, local, stdout) {
  const { watchPid } = ctx.paths;
  const mine = String(process.pid);
  ctx.update(() => writeFileSync(watchPid, mine));
  const log = (m) => stdout(`${new Date().toISOString()} ${m}`);
  try {
    watchLoop(ctx, { maxWaitHours: local.maxWaitHours, pollMs: local.pollSeconds * 1000, log });
    return 0;
  } finally {
    ctx.update(() => { if (existsSync(watchPid) && readFileSync(watchPid, "utf8").trim() === mine) rmSync(watchPid, { force: true }); });
  }
}

/** Was this file the entry point? A symlinked or junctioned install (`npm i -g`, a plugin cache copy)
 *  hands argv[1] a path that never equals import.meta.url, so compare resolved paths too. */
export function isEntryPoint(moduleUrl, argv1) {
  if (!argv1) return false;
  if (moduleUrl === pathToFileURL(argv1).href) return true;
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  return real(fileURLToPath(moduleUrl)) === real(argv1);
}

if (isEntryPoint(import.meta.url, process.argv[1])) main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(2); });
