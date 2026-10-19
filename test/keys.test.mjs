// test/keys.test.mjs — decisions name the stretch they judged (§8): a stale one is refused, says what it missed, and leaves a trace
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../scripts/lib/check.mjs";
import { render, renderCheck } from "../scripts/lib/render.mjs";
import { next, overrule, reset, resume, start } from "../scripts/lib/verbs.mjs";
import { watchLoop } from "../scripts/lib/watch.mjs";
import { main, parseCli } from "../scripts/rider.mjs";
import { FakeBinding } from "./fake-binding.mjs";
import { FakeClock, INSTANCE_RIDER_MD, TEST_RIDER_MD, limitSoon, makeCtx, settled, tmpProject } from "./helpers.mjs";

const done = (status, extra = {}) => ({ statuses: ["done"], read: { lastText: `STATUS: ${status}\n<promise>X</promise>`, turns: 5, ...extra } });
/** A well-formed run id that is not `r`. */
const otherThan = (r) => (r === "0000" ? "0001" : "0000");

test("the stale decision of §8 is refused, names the new phase and the other actor's move, and leaves a trace", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const binding = new FakeBinding({ script: [done("planned"), done("code green")] });
  const judge = makeCtx({ root: p.root, binding });
  const board = makeCtx({ root: p.root, binding });
  const { runId: r } = start(judge);
  const judged = check(judge);
  assert.deepEqual([judged.state, judged.key], ["done", `${r}.1`]);
  // Another actor decides plan's stretch first, and build finishes before the judge's own call arrives.
  assert.equal(next(board, "planned", { on: `${r}.1`, because: "the plan stands", by: "operator" }).phase, "build");
  const built = check(board);
  assert.deepEqual([built.state, built.key], ["done", `${r}.2`]);
  const before = judge.readEvents().length;
  // `blocked` is an edge of build too: without the key it would land on the wrong phase.
  const late = next(judge, "blocked", { on: `${r}.1`, because: "BLOCKED: the plan is wrong" });
  assert.deepEqual([late.ok, late.stale], [false, true]);
  assert.match(late.error, /build/);
  assert.match(late.error, /by operator/);
  assert.equal(late.current.key, `${r}.2`);
  const events = judge.readEvents();
  assert.equal(events.length, before + 1);
  assert.deepEqual([events.at(-1).kind, events.at(-1).key, events.at(-1).text], ["refused", `${r}.1`, late.error]);
  const run = judge.loadRun();
  assert.deepEqual([run.phase, run.transitions.length, run.sessions.length], ["build", 1, 2], "nothing moved");
  assert.equal(render("next", late), `refused: ${late.error}\nnow: phase build · run ${r} · latest ${r}.2 (done) · last: plan —planned→ build by operator: the plan stands`);
});

test("resume, overrule and reset refuse a stale key", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const binding = new FakeBinding({ script: [done("planned"), done("BLOCKED — x")] });
  const ctx = makeCtx({ root: p.root, binding });
  const refused = (res, key) => {
    assert.deepEqual([res.ok, res.stale], [false, true], res.error);
    const e = ctx.readEvents().at(-1);
    assert.deepEqual([e.kind, e.key, e.text], ["refused", key, res.error]);
  };
  const { runId: r } = start(ctx);
  check(ctx);
  next(ctx, "planned", { on: `${r}.1`, because: "ok" });
  // resume: plan's stretch, once the run has gone on to build.
  refused(resume(ctx, { on: `${r}.1` }), `${r}.1`);
  assert.equal(binding.calls.filter((c) => c.call === "resume").length, 0, "a refused resume reaches no session");
  // reset: a run that is not the active one.
  refused(reset(ctx, { on: otherThan(r) }), otherThan(r));
  assert.equal(ctx.loadRun().runId, r, "the run is still active");
  check(ctx);
  assert.equal(next(ctx, "blocked", { on: `${r}.2`, because: "BLOCKED — x" }).state, "operator");
  // overrule: a run that is not the last ended one.
  refused(overrule(ctx, "code green", { on: otherThan(r), because: "x" }), otherThan(r));
  assert.equal(ctx.loadRun(), null, "nothing was revived");
  // reset with no active run: the run it names has ended (the controller's ruling on §8's table).
  refused(reset(ctx, { on: r }), r);
});

test("a missing or malformed --on is a usage refusal with no event", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [done("planned")] }) });
  const { runId: r } = start(ctx);
  check(ctx);
  const events = ctx.readEvents().length;
  const version = ctx.readState().version;
  const usage = (res, what) => {
    assert.equal(res.ok, false, what);
    assert.ok(!res.stale, what);
    assert.match(res.error, /--on/, what);
  };
  for (const on of [undefined, "3f2a", "3f2a.0", "x.1", "3f2a.1.2"]) {
    usage(next(ctx, "planned", { on, because: "ok" }), `next --on ${on}`);
    usage(resume(ctx, { on }), `resume --on ${on}`);
  }
  for (const on of [undefined, `${r}.1`, "x", "3F2A"]) {
    usage(reset(ctx, { on }), `reset --on ${on}`);
    usage(overrule(ctx, "planned", { on, because: "x" }), `overrule --on ${on}`);
  }
  assert.equal(ctx.readEvents().length, events, "no refused event");
  assert.equal(ctx.readState().version, version, "no state change");
  assert.deepEqual([ctx.loadRun().phase, ctx.loadRun().transitions.length], ["plan", 0]);
});

test("--by is recorded; judge by default; the executor's own stops and resume say executor", async (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const clock = new FakeClock();
  const binding = new FakeBinding({ script: [done("planned"), done("code green")] });
  const ctx = makeCtx({ root: p.root, binding, clock });
  const { runId: r } = start(ctx);
  check(ctx);
  next(ctx, "planned", { on: `${r}.1`, because: "ruled in a terminal", by: "operator" });
  assert.equal(ctx.loadRun().transitions.at(-1).by, "operator");
  check(ctx);
  // close hits a rate limit; the watcher waits it out and resumes on its own.
  binding.s.scripts.push({ statuses: ["done"], read: { lastText: null, signal: limitSoon(clock), turns: 20 } }, done("gate green", { turns: 35 }));
  next(ctx, "code green", { on: `${r}.2`, because: "tests green" });
  assert.equal(ctx.loadRun().transitions.at(-1).by, "judge");
  assert.equal(watchLoop(ctx, { pollMs: 30_000 }).state, "done");
  const resumed = ctx.loadRun().transitions.at(-1);
  assert.deepEqual([resumed.from, resumed.label, resumed.to, resumed.by], ["close", "resume", "close", "executor"]);
  assert.equal(ctx.loadRun().sessions.at(-1).resumeReason, "rate-limit");

  // The visit cap: nobody judged that stop.
  const md = TEST_RIDER_MD.replace("edges: { planned: build, blocked: operator }", "edges: { retry: plan, planned: build }").replace("intake:", "limits:\n  visits: 1\nintake:");
  const q = tmpProject({ riderMd: md });
  t.after(q.cleanup);
  const qctx = makeCtx({ root: q.root, binding: new FakeBinding({ script: [done("retry")] }) });
  const { runId: s } = start(qctx);
  check(qctx);
  assert.equal(next(qctx, "retry", { on: `${s}.1`, because: "once more" }).state, "operator");
  assert.deepEqual(qctx.lastEndedRun().transitions.map((x) => x.by), ["judge", "executor"]);

  // Through the CLI: --on and --by are flags, and only a judge or the operator decides by hand.
  assert.deepEqual(parseCli(["next", "planned", "--on", "3f2a.1", "--by", "operator"]).flags, { on: "3f2a.1", by: "operator" });
  const err = [];
  assert.equal(await main(["next", "planned", "--on", `${r}.2`, "--by", "executor"], { cwd: p.root, stdout: () => {}, stderr: (m) => err.push(m) }), 2);
  assert.match(err.join("\n"), /--by is judge or operator/);
});

test("a resume is a transition", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const clock = new FakeClock();
  const ctx = makeCtx({ root: p.root, clock, binding: new FakeBinding({ script: [{ statuses: ["gone"] }, { statuses: ["running"] }] }) });
  const { runId: r } = start(ctx);
  assert.equal(settled(check, ctx).state, "gone");
  assert.equal(next(ctx, "resume", { on: `${r}.1`, because: "killed; transcript intact" }).state, "running");
  assert.deepEqual(ctx.loadRun().transitions.at(-1), { at: clock.now().toISOString(), from: "plan", label: "resume", to: "plan", because: "killed; transcript intact", by: "judge" });
});

test("check prints the exact decide-with line", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const ctx = makeCtx({ root: p.root, binding: new FakeBinding({ script: [{ statuses: ["running", "done"], read: { lastText: "STATUS: planned\n<promise>X</promise>", turns: 5 } }] }) });
  const { runId: r } = start(ctx);
  const running = check(ctx);
  assert.deepEqual([running.state, running.key, running.decideWith ?? null], ["running", `${r}.1`, null], "nothing to decide while it runs");
  assert.doesNotMatch(renderCheck(running), /decide with/);
  const c = check(ctx);
  assert.equal(c.state, "done");
  assert.equal(c.key, `${r}.1`);
  assert.equal(c.decideWith, 'decide with:  rider next <label> --on ' + `${r}.1` + ' --because "…"     (labels: planned · blocked · resume · operator)');
  assert.equal(renderCheck(c).split("\n").at(-1), c.decideWith, "the last line of the block");

  // Several riders and a rider that declares instances: the line carries both flags, so it can be copied verbatim.
  const q = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a"] });
  t.after(q.cleanup);
  const a = makeCtx({ root: q.root, instance: "a", riderCount: 2, binding: new FakeBinding({ script: [done("planned")] }) });
  const { runId: s } = start(a);
  const ca = check(a);
  assert.ok(ca.decideWith.includes(` --rider lemmaria --instance a --on ${s}.1 `), ca.decideWith);
});

test("the watcher's resume after the run moved on is refused quietly", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const clock = new FakeClock();
  const binding = new FakeBinding();
  binding.s.scripts.push({ statuses: ["done"], read: { lastText: null, signal: limitSoon(clock), turns: 20 } });
  const watcher = makeCtx({ root: p.root, binding, clock });
  const judge = makeCtx({ root: p.root, binding, clock });
  const { runId: r } = start(watcher);
  // The judge decides after the watcher's last look during the wait and before its resume takes the instance: the
  // seam is the watcher's first hold once the rate limit is on file, which is the resume's own.
  const update = watcher.update;
  let decided = false;
  watcher.update = (fn) => {
    if (!decided && judge.loadRun().sessions[0].outcome === "rate-limited") {
      decided = true;
      assert.equal(next(judge, "blocked", { on: `${r}.1`, because: "the limit will not lift today" }).state, "operator");
    }
    return update(fn);
  };
  const logs = [];
  assert.equal(watchLoop(watcher, { pollMs: 30_000, log: (m) => logs.push(m) }), null);
  assert.equal(decided, true);
  assert.equal(binding.calls.filter((c) => c.call === "resume").length, 0, "no resume reaches the binding");
  assert.ok(logs.includes("the run moved on while waiting; exiting"), logs.join("\n"));
  const last = watcher.readEvents().at(-1);
  assert.deepEqual([last.kind, last.key], ["refused", `${r}.1`], "the watcher's refused resume is on file like any other");
});

test("a reset between the watcher's check and its wait ends the watch quietly", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const clock = new FakeClock();
  const binding = new FakeBinding();
  binding.s.scripts.push({ statuses: ["done"], read: { lastText: null, signal: limitSoon(clock), turns: 20 } });
  const watcher = makeCtx({ root: p.root, binding, clock });
  const operator = makeCtx({ root: p.root, binding, clock });
  const { runId: r } = start(watcher);
  // The operator resets the moment the rate limit is on file, before the watcher has read the run to wait on it.
  const update = watcher.update;
  let wasReset = false;
  watcher.update = (fn) => {
    const out = update(fn);
    if (!wasReset && operator.loadRun()?.sessions[0].outcome === "rate-limited") { wasReset = true; assert.equal(reset(operator, { on: r, by: "operator" }).ok, true); }
    return out;
  };
  const logs = [];
  assert.equal(watchLoop(watcher, { pollMs: 30_000, log: (m) => logs.push(m) }), null);
  assert.equal(wasReset, true);
  assert.ok(logs.includes("the run moved on while waiting; exiting"), logs.join("\n"));
  assert.equal(binding.calls.filter((c) => c.call === "resume").length, 0);
});

test("through the CLI both refusals exit 2: a malformed key leaves no trace, a stale one prints where the instance is now", (t) => {
  const p = tmpProject();
  t.after(p.cleanup);
  const fake = join(p.root, "fake-state.json");
  writeFileSync(fake, JSON.stringify({ scripts: [done("planned"), { statuses: ["running"] }] }));
  const env = { ...process.env, RIDER_BINDING: fileURLToPath(new URL("./fake-binding.mjs", import.meta.url)), RIDER_FAKE_STATE: fake, RIDER_NO_WATCHER: "1" };
  const rider = fileURLToPath(new URL("../scripts/rider.mjs", import.meta.url));
  const run = (...args) => { const r = spawnSync(process.execPath, [rider, ...args], { cwd: p.root, env, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const json = (...args) => { const r = run(...args, "--json"); return { ...r, v: JSON.parse(r.out) }; };
  const { runId: r } = json("start").v;
  assert.equal(json("check").v.key, `${r}.1`);
  const events = () => json("status").v.lastEvent.seq;
  const before = events();
  const malformed = json("next", "planned", "--on", r, "--because", "ok");
  assert.deepEqual([malformed.code, malformed.v.ok, malformed.v.stale], [2, false, undefined]);
  assert.equal(events(), before, "no refused event");
  assert.equal(json("next", "planned", "--on", `${r}.1`, "--because", "ok", "--by", "operator").v.phase, "build");
  const stale = run("next", "blocked", "--on", `${r}.1`, "--because", "late");
  assert.equal(stale.code, 2);
  assert.match(stale.out, new RegExp(`^refused: .*\\nnow: phase build · run ${r} · latest ${r}\\.2 \\(running\\) · last: plan —planned→ build by operator: ok\\n?$`));
  assert.equal(json("status").v.lastEvent.kind, "refused");
});
