#!/usr/bin/env node
// scripts/rider.mjs — the executor's verbs (§4.1). Text out for the judge, --json for scripts.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { check } from "./lib/check.mjs";
import { createContext } from "./lib/context.mjs";
import { render } from "./lib/render.mjs";
import { discoverRiders, loadRider } from "./lib/rider-md.mjs";
import { ensureDirs, loadLocal, statePaths } from "./lib/state.mjs";
import * as verbs from "./lib/verbs.mjs";
import { awaitEvent, watchLoop } from "./lib/watch.mjs";

const USAGE = `rider — drive riders/<name>/RIDER.md one phase at a time (run from the project root)

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
exit: 0 ok · 2 refused or usage · 3 await timed out`;

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { rider: { type: "string" }, because: { type: "string" }, json: { type: "boolean" }, "dry-run": { type: "boolean" }, "max-minutes": { type: "string" }, binding: { type: "string" }, help: { type: "boolean", short: "h" } },
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
    const paths = statePaths(cwd, rider.name);
    ensureDirs(paths);
    const local = loadLocal(paths);
    const bindingPath = cli.flags.binding ?? process.env.RIDER_BINDING ?? null;
    const bindingUrl = bindingPath ? pathToFileURL(bindingPath).href : new URL("./bindings/claude-code.mjs", import.meta.url).href;
    const { createBinding } = await import(bindingUrl);
    const binding = createBinding({ claudePath: local.claudePath, advisor: local.advisor, permissionMode: local.permissionMode });
    // RIDER_NO_WATCHER=1: tests drive verbs from one process and must not get a real detached watcher
    // racing them over the same state files; the smoke tier keeps the real one on purpose.
    const ctx = createContext({ rider, root: cwd, paths, local, binding, ...(process.env.RIDER_NO_WATCHER ? { spawnWatcher: () => false } : {}) });
    const out = (r) => stdout(cli.flags.json ? JSON.stringify(r, null, 2) : render(cli.verb, r));
    const dryRun = !!cli.flags["dry-run"];
    let r;
    switch (cli.verb) {
      case "start": r = verbs.start(ctx, { phase: cli.args[0] ?? null, dryRun }); break;
      case "next": r = verbs.next(ctx, cli.args[0], { because: cli.flags.because ?? null, dryRun }); break;
      case "check": r = check(ctx); break;
      case "resume": r = verbs.resume(ctx, { reason: cli.flags.because ?? "judge", dryRun }); break;
      case "status": r = verbs.status(ctx); break;
      case "note": r = verbs.note(ctx, cli.args.join(" ")); break;
      case "reset": r = verbs.reset(ctx); break;
      case "await": r = awaitEvent(ctx, { maxMinutes }); out(r); return r.ok ? 0 : 3;
      case "watch": return runWatch(ctx, paths, local, stdout);
      default: return fail(`unknown verb "${cli.verb}"\n${USAGE}`);
    }
    out(r);
    return r.ok === false ? 2 : 0;
  } catch (e) {
    return fail(e.message);
  }
}

function runWatch(ctx, paths, local, stdout) {
  writeFileSync(paths.watchPid, String(process.pid));
  const log = (m) => stdout(`${new Date().toISOString()} ${m}`);
  try {
    watchLoop(ctx, { maxWaitHours: local.maxWaitHours, pollMs: local.pollSeconds * 1000, log });
    return 0;
  } finally {
    if (existsSync(paths.watchPid) && readFileSync(paths.watchPid, "utf8").trim() === String(process.pid)) rmSync(paths.watchPid, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(2); });
