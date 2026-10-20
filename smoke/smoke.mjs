#!/usr/bin/env node
// Live smoke: the real CLI against the real binding, in temp copies of smoke/rider and smoke/instances. usage: npm run smoke
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAlive, sleepSync } from "../scripts/lib/proc.mjs";
import { defaultClaudePath } from "../scripts/bindings/claude-code.mjs";

const CLAUDE = defaultClaudePath(); // spawnSync("claude") does not resolve the .cmd shim on Windows
const HERE = fileURLToPath(new URL(".", import.meta.url));
const RIDER = join(HERE, "..", "scripts", "rider.mjs");
// Two projects: the first holds one rider, so its commands need no --rider; the second holds the instance rider.
const root = mkdtempSync(join(tmpdir(), "rider-smoke-"));
mkdirSync(join(root, "riders"));
cpSync(join(HERE, "rider"), join(root, "riders", "smoke"), { recursive: true });
const root2 = mkdtempSync(join(tmpdir(), "rider-smoke-pair-"));
const INSTANCES = ["a", "b"];
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`); if (!ok) fails++; };
// Every session any verb reports, recorded the moment the verb returns: the cleanup at the bottom stops and removes
// each one, so a section that throws before its last check still strands no paid session.
const launched = new Set();
const cli = (cwd) => (...args) => {
  const r = spawnSync(process.execPath, [RIDER, ...args, "--json"], { cwd, encoding: "utf8", timeout: 180_000 });
  let out;
  try { out = JSON.parse(r.stdout); } catch { return { parseError: r.stdout, stderr: r.stderr, code: r.status }; }
  if (out?.session?.shortId) launched.add(out.session.shortId);
  return out;
};
const rider = cli(root);
const pair = cli(root2);
// bounded by iterations, not wall time: each pass is a 5 s sleep plus one `check`, which may itself settle for ~10 s
const until = (pred, seconds) => { for (let i = 0; i < seconds; i += 5) { const r = rider("check"); if (pred(r)) return r; sleepSync(5000); } return rider("check"); };
const waitFor = (pred, seconds) => { for (let i = 0; i < seconds && !pred(); i += 5) sleepSync(5000); return pred(); };
/** A decision names the stretch it judged: `--on` is the key of the check just before it. Without one the section stops here. */
const keyFrom = (r) => { if (!r?.key) throw new Error(`no decision key to pass as --on: ${JSON.stringify(r).slice(0, 200)}`); return r.key; };
/** events.jsonl is one JSON object per line; a torn last line (a crash mid-append) is skipped, as the executor's readers skip it. */
const readEvents = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n") : []).flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
const instanceFile = (dir, riderName, instance, file) => join(dir, ".rider", riderName, instance, file);
const pidDead = (file) => { try { return !isAlive(Number(readFileSync(file, "utf8"))); } catch { return true; } };
// A rider without `instances` has the one instance `default`.
const paths = { events: instanceFile(root, "smoke", "default", "events.jsonl"), pid: instanceFile(root, "smoke", "default", "watch.pid") };
const watcherDead = () => pidDead(paths.pid);

// Every step runs inside a try so the cleanup at the bottom always runs: a thrown TypeError must never
// strand a paid session or a detached watcher (a waiting session is polled forever).
let awaiting;
try {
  // 1. phase one finishes
  const s = rider("start");
  check("phase one launched", s.state === "running", JSON.stringify(s).slice(0, 200));
  const one = until((r) => r.state !== "running", 180);
  check("finished session is done", one.state === "done", one.state);
  check("status hint read", one.statusHint === "STATUS: done", one.statusHint);
  check("cost came from the cost line", typeof one.cost === "number" && one.cost > 0, `$${one.cost}`);
  check("turns counted", (one.turns ?? 0) >= 1, one.turns);

  // 5. the detached watcher outlived `start` (a separate process that has exited) and appended the event; it does so
  //    on its next poll after the stop (pollSeconds, 30 s by default), then exits
  const doneEvent = () => readEvents(paths.events).find((e) => e.kind === "done" && e.key === one.key);
  waitFor(() => doneEvent() && watcherDead(), 90);
  check("the watcher, spawned by an exited process, appended the done event", !!doneEvent(), JSON.stringify(readEvents(paths.events).at(-1) ?? null));
  check("the watcher exited after its event", watcherDead(), "watch.pid gone or dead");

  // 3. resuming phase one's STOPPED (finished) session keeps its id and reads a NEW cost line —
  //    v2's smoke #3; a resumed asking session would just ask again, so phase one is the one resumed.
  //    `resumed` is the stored id (tautological on its own); the registry id the CLI printed for the resume is the evidence.
  const rs = rider("resume", "--on", keyFrom(one), "--because", "smoke");
  check("resume keeps the session id (run record and CLI registry agree)", rs.resumed === one.session?.id && rs.session?.shortId === one.session?.shortId, `${rs.session?.shortId ?? rs.error} vs ${one.session?.shortId}`);
  const resumed = until((r) => r.state !== "running", 180);
  check("resumed session finished and a NEW cost line was read", resumed.state === "done" && resumed.cost > 0 && resumed.resumes === 1, `${resumed.state} $${resumed.cost} this stretch, ${resumed.resumes} resume(s), first stretch $${one.cost}`);

  // 2. phase two asks; 6. `rider await`, as its own process, returns with the waiting event.
  //    The resume pushed a stretch, so the key decided on is the resumed check's, not phase one's first.
  const n2 = rider("next", "done", "--on", keyFrom(resumed), "--because", "smoke");
  check("phase two launched", n2.state === "running", n2.state ?? n2.error);
  awaiting = spawn(process.execPath, [RIDER, "await", "--max-minutes", "5", "--json"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let awaitOut = "";
  awaiting.stdout.on("data", (d) => { awaitOut += d; });
  const two = until((r) => r.state !== "running", 180);
  check("asking session is waiting", two.state === "waiting", two.state);
  check("if a turn was flushed, the question is captured", two.turns === 0 || two.question?.questions?.[0]?.question === "A or B?" || (two.finalText ?? "").length > 0, two.turns === 0 ? "0 turns: nothing flushed before the registry flipped" : JSON.stringify(two.question ?? two.finalText).slice(0, 80));
  const awaitCode = await new Promise((res) => { const t = setTimeout(() => res("timeout"), 120_000); awaiting.on("close", (c) => { clearTimeout(t); res(c); }); }); // close, not exit: stdout is drained
  if (awaitCode === "timeout") awaiting.kill();
  let awaited = null;
  try { awaited = JSON.parse(awaitOut); } catch { /* reported below */ }
  check("rider await exited 0 with the waiting event", awaitCode === 0 && !!awaited?.events?.some((e) => e.kind === "waiting"), `${awaitCode}: ${awaitOut.replace(/\s+/g, " ").trim().slice(0, 160)}`);
  if (two.session?.shortId) spawnSync(CLAUDE, ["stop", two.session.shortId], { stdio: "ignore", timeout: 60_000 });
  sleepSync(5000);
  const stoppedTwo = until((r) => r.state !== "waiting" && r.state !== "running", 60);
  check("a stopped asking session re-classifies as stopped (gone by §5; done if the CLI marks it) with no status hint", ["gone", "done"].includes(stoppedTwo.state) && stoppedTwo.statusHint === null, `${stoppedTwo.state} / ${stoppedTwo.statusHint}`);
  const skip = rider("next", "operator", "--on", keyFrom(stoppedTwo), "--because", "smoke: skip to phase three");
  const s3 = rider("start", "three");
  check("skipped to phase three", skip.state === "operator" && s3.state === "running", `${skip.state ?? skip.error} / ${s3.state ?? s3.error}`);

  // 4. a pending subagent keeps the session busy
  let sawRunningWithText = 0;
  for (let i = 0; i < 40; i++) { const r = rider("check"); if (r.state === "running" && /STATUS: done/.test(r.finalText ?? "")) sawRunningWithText++; if (r.state !== "running") break; sleepSync(3000); }
  const three = until((r) => r.state !== "running", 240);
  check("a pending subagent keeps the session BUSY (running after its final text)", sawRunningWithText >= 1, `${sawRunningWithText} samples`);
  check("…and it is done once the subagent finishes; the cost line was written", three.state === "done" && typeof three.cost === "number", `${three.state} $${three.cost}`);
} catch (e) {
  check("smoke ran to the end", false, e.stack ?? e.message);
}

// 7. two instances driven at once: one rider, two directories under work/, each with its own state, events, watcher
//    and session. Its own try, so a failure above does not skip it.
try {
  cpSync(join(HERE, "instances"), join(root2, "riders", "pair"), { recursive: true });
  for (const id of INSTANCES) mkdirSync(join(root2, "work", id), { recursive: true });
  const started = Object.fromEntries(INSTANCES.map((id) => [id, pair("start", "--rider", "pair", "--instance", id)]));
  check("both instances launched", INSTANCES.every((id) => started[id].state === "running"), INSTANCES.map((id) => `${id}: ${started[id].state ?? started[id].error ?? JSON.stringify(started[id]).slice(0, 120)}`).join(", "));
  // Both sessions run at once; each check is its own instance's locked write. Bounded like `until`.
  const last = {};
  for (let i = 0; i < 180; i += 5) {
    for (const id of INSTANCES) if (!last[id] || last[id].state === "running") last[id] = pair("check", "--rider", "pair", "--instance", id);
    if (INSTANCES.every((id) => last[id].state !== "running")) break;
    sleepSync(5000);
  }
  const [a, b] = INSTANCES.map((id) => last[id]);
  check("both instances are done, with distinct session ids", a.state === "done" && b.state === "done" && !!a.session?.id && !!b.session?.id && a.session.id !== b.session.id, `a: ${a.state} ${a.session?.id}, b: ${b.state} ${b.session?.id}`);
  // Each instance's watcher appends its wake event on its next poll after the stop.
  const doneEvent = (id) => readEvents(instanceFile(root2, "pair", id, "events.jsonl")).find((e) => e.kind === "done" && e.instance === id && e.key === last[id].key);
  waitFor(() => INSTANCES.every(doneEvent), 90);
  check("each instance has its own done wake event", INSTANCES.every(doneEvent), INSTANCES.map((id) => `${id}: ${doneEvent(id) ? `key ${doneEvent(id).key}` : "none"}`).join(", "));
  const board = pair("board");
  const judged = (board.rows ?? []).filter((r) => r.rider === "pair" && r.category === "needs its judge").map((r) => r.instance).sort();
  check("rider board lists both under \"needs its judge\"", judged.join(",") === INSTANCES.join(","), board.rows ? board.rows.map((r) => `${r.instance}: ${r.category}`).join(", ") : JSON.stringify(board).slice(0, 200));
} catch (e) {
  check("the two-instance section ran to the end", false, e.stack ?? e.message);
}

// A section that threw while `rider await` was armed leaves it blocking for its five minutes; it decides nothing.
if (awaiting && awaiting.exitCode === null && awaiting.signalCode === null) awaiting.kill();
// Stop, then remove: `claude rm`'s help promises only that it also works on exited sessions, and a section that failed
// midway may have left one running.
for (const id of launched) for (const verb of ["stop", "rm"]) spawnSync(CLAUDE, [verb, id], { stdio: "ignore", timeout: 60_000 });
// a watcher may still be polling from inside its root; give the watchers one tick to exit before their cwd is removed
const pids = [paths.pid, ...INSTANCES.map((id) => instanceFile(root2, "pair", id, "watch.pid"))];
for (let i = 0; i < 7 && !pids.every(pidDead); i++) sleepSync(5000);
// One still alive is in a wait (a rate-limit reset, a session the stop above left listed): at the reset it would resume a
// session this cleanup stopped, and pay with nothing tracking it. SIGTERM, then SIGKILL after a short grace.
for (const file of pids) {
  if (pidDead(file)) continue;
  // A watcher that exits between the two reads removes its pid file: nothing to kill, and nothing to throw over.
  let pid;
  try { pid = Number(readFileSync(file, "utf8")); } catch { continue; }
  let signal = "SIGTERM";
  try { process.kill(pid, signal); } catch { continue; }
  for (let i = 0; i < 10 && isAlive(pid); i++) sleepSync(500);
  if (isAlive(pid)) { signal = "SIGKILL"; try { process.kill(pid, signal); } catch { /* exited meanwhile */ } }
  console.log(`killed watcher pid ${pid} (${signal}), still alive after the wait: ${file}`);
}
console.log(fails ? `smoke: ${fails} FAILED  (state kept at ${root} and ${root2})` : "smoke: PASS");
if (!fails) for (const dir of [root, root2]) { try { rmSync(dir, { recursive: true, force: true }); } catch (e) { console.log(`(could not remove ${dir}: ${e.message})`); } }
process.exit(fails ? 1 : 0);
