#!/usr/bin/env node
// Live smoke: the real CLI against the real binding, in a temp copy of smoke/rider. usage: npm run smoke
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
const root = mkdtempSync(join(tmpdir(), "rider-smoke-"));
mkdirSync(join(root, "riders"));
cpSync(join(HERE, "rider"), join(root, "riders", "smoke"), { recursive: true });
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`); if (!ok) fails++; };
const rider = (...args) => { const r = spawnSync(process.execPath, [RIDER, ...args, "--json"], { cwd: root, encoding: "utf8", timeout: 180_000 }); try { return JSON.parse(r.stdout); } catch { return { parseError: r.stdout, stderr: r.stderr, code: r.status }; } };
// bounded by iterations, not wall time: each pass is a 5 s sleep plus one `check`, which may itself settle for ~10 s
const until = (pred, seconds) => { for (let i = 0; i < seconds; i += 5) { const r = rider("check"); if (pred(r)) return r; sleepSync(5000); } return rider("check"); };
const paths = { events: join(root, ".rider", "smoke", "events.log"), pid: join(root, ".rider", "smoke", "watch.pid") };
const watcherDead = () => !existsSync(paths.pid) || !isAlive(Number(readFileSync(paths.pid, "utf8")));

// Every step runs inside one try so the cleanup at the bottom always runs: a thrown TypeError must never
// strand a paid session or a detached watcher (a waiting session is polled forever).
let one, two, resumed, three, awaiting;
try {
  // 1. phase one finishes
  const s = rider("start");
  check("phase one launched", s.state === "running", JSON.stringify(s).slice(0, 200));
  one = until((r) => r.state !== "running", 180);
  check("finished session is done", one.state === "done", one.state);
  check("status hint read", one.statusHint === "STATUS: done", one.statusHint);
  check("cost came from the cost line", typeof one.cost === "number" && one.cost > 0, `$${one.cost}`);
  check("turns counted", (one.turns ?? 0) >= 1, one.turns);

  // 5. the detached watcher outlived `start` (a separate process that has exited) and appended the event
  sleepSync(35_000);
  const events = existsSync(paths.events) ? readFileSync(paths.events, "utf8").trim().split("\n") : [];
  check("the watcher, spawned by an exited process, appended the done event", events.some((l) => / done smoke\//.test(l)), events.at(-1));
  check("the watcher exited after its event", watcherDead(), "watch.pid gone or dead");

  // 3. resuming phase one's STOPPED (finished) session keeps its id and reads a NEW cost line —
  //    v2's smoke #3; a resumed asking session would just ask again, so phase one is the one resumed.
  //    `resumed` is the stored id (tautological on its own); the registry id the CLI printed for the resume is the evidence.
  const rs = rider("resume", "--because", "smoke");
  check("resume keeps the session id (run record and CLI registry agree)", rs.resumed === one.session?.id && rs.session?.shortId === one.session?.shortId, `${rs.session?.shortId} vs ${one.session?.shortId}`);
  resumed = until((r) => r.state !== "running", 180);
  check("resumed session finished and a NEW cost line was read", resumed.state === "done" && resumed.cost > 0 && resumed.resumes === 1, `${resumed.state} $${resumed.cost} this stretch, ${resumed.resumes} resume(s), first stretch $${one.cost}`);

  // 2. phase two asks; 6. `rider await`, as its own process, returns with the waiting event
  const n2 = rider("next", "done", "--because", "smoke");
  check("phase two launched", n2.state === "running", n2.state);
  awaiting = spawn(process.execPath, [RIDER, "await", "--max-minutes", "5", "--json"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let awaitOut = "";
  awaiting.stdout.on("data", (d) => { awaitOut += d; });
  two = until((r) => r.state !== "running", 180);
  check("asking session is waiting", two.state === "waiting", two.state);
  check("if a turn was flushed, the question is captured", two.turns === 0 || two.question?.questions?.[0]?.question === "A or B?" || (two.finalText ?? "").length > 0, two.turns === 0 ? "0 turns: nothing flushed before the registry flipped" : JSON.stringify(two.question ?? two.finalText).slice(0, 80));
  const awaitCode = await new Promise((res) => { const t = setTimeout(() => res("timeout"), 120_000); awaiting.on("close", (c) => { clearTimeout(t); res(c); }); }); // close, not exit: stdout is drained
  if (awaitCode === "timeout") awaiting.kill();
  check("rider await exited 0 with the waiting event", awaitCode === 0 && /waiting/.test(awaitOut), `${awaitCode}: ${awaitOut.trim().slice(0, 120)}`);
  if (two.session?.shortId) spawnSync(CLAUDE, ["stop", two.session.shortId], { stdio: "ignore", timeout: 60_000 });
  sleepSync(5000);
  const stoppedTwo = until((r) => r.state !== "waiting" && r.state !== "running", 60);
  check("a stopped asking session re-classifies as stopped (gone by §5; done if the CLI marks it) with no status hint", ["gone", "done"].includes(stoppedTwo.state) && stoppedTwo.statusHint === null, `${stoppedTwo.state} / ${stoppedTwo.statusHint}`);
  const skip = rider("next", "operator", "--because", "smoke: skip to phase three");
  const s3 = rider("start", "three");
  check("skipped to phase three", skip.state === "operator" && s3.state === "running", `${skip.state ?? skip.error} / ${s3.state ?? s3.error}`);

  // 4. a pending subagent keeps the session busy
  let sawRunningWithText = 0;
  for (let i = 0; i < 40; i++) { const r = rider("check"); if (r.state === "running" && /STATUS: done/.test(r.finalText ?? "")) sawRunningWithText++; if (r.state !== "running") break; sleepSync(3000); }
  three = until((r) => r.state !== "running", 240);
  check("a pending subagent keeps the session BUSY (running after its final text)", sawRunningWithText >= 1, `${sawRunningWithText} samples`);
  check("…and it is done once the subagent finishes; the cost line was written", three.state === "done" && typeof three.cost === "number", `${three.state} $${three.cost}`);
} catch (e) {
  check("smoke ran to the end", false, e.stack ?? e.message);
}

for (const l of [one, two, resumed, three]) if (l?.session?.shortId) spawnSync(CLAUDE, ["rm", l.session.shortId], { stdio: "ignore", timeout: 60_000 });
// phase three's watcher may still be polling from inside root; give it one tick to exit before its cwd is removed
for (let i = 0; i < 7 && !watcherDead(); i++) sleepSync(5000);
console.log(fails ? `smoke: ${fails} FAILED  (state kept at ${root})` : "smoke: PASS");
if (!fails) { try { rmSync(root, { recursive: true, force: true }); } catch (e) { console.log(`(could not remove ${root}: ${e.message})`); } }
process.exit(fails ? 1 : 0);
