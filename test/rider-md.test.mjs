// test/rider-md.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRiders, legalLabels, listInstances, loadRider, onwardEdges, overrulable, validateRider } from "../scripts/lib/rider-md.mjs";
import { parseFrontmatter } from "../scripts/lib/yaml-subset.mjs";
import { INSTANCE_RIDER_MD, LEMMARIA_RIDER_MD, TEST_RIDER_MD, tmpProject } from "./helpers.mjs";

const { data } = parseFrontmatter(LEMMARIA_RIDER_MD);
const allPrompts = () => true;

test("the worked example validates", () => assert.deepEqual(validateRider(data, allPrompts), []));

test("a phase name that is not a safe token is refused", () => {
  // phase names become path segments (the harvest log's file name) and event-line tokens
  for (const name of ["../escape", "two words", "a/b", "phase.1"]) {
    const bad = structuredClone(data);
    bad.phases[name] = { model: "opus", edges: { planned: "build" } };
    const errs = validateRider(bad, allPrompts);
    assert.ok(errs.some((e) => e.startsWith(`phases.${name}: name must be`)), `expected a name error for "${name}"; got ${errs.join(" | ")}`);
  }
  const ok = structuredClone(data);
  ok.phases["re_check-2"] = { model: "opus", edges: { planned: "build" } };
  assert.deepEqual(validateRider(ok, allPrompts), []);
});

test("every structural error is named", () => {
  const bad = structuredClone(data);
  bad.start = "merge";                          // human start
  bad.phases.operator = { human: true, check: "true" };
  bad.phases.plan.edges.resume = "build";       // reserved label
  bad.phases.close.edges["gate green"] = "ship"; // undeclared target
  delete bad.phases.build.model;
  delete bad.phases.merge.check;
  bad.limits = { visits: 0 };
  const errs = validateRider(bad, allPrompts);
  for (const re of [/start: "merge" is a human phase/, /phases\.operator: reserved/, /reserved label/, /"ship" is not a declared phase/, /phases\.build: model is required/, /human phase needs a check/, /limits\.visits/]) {
    assert.ok(errs.some((e) => re.test(e)), `expected ${re}; got ${errs.join(" | ")}`);
  }
});

test("requires: a list of non-empty commands on a session phase, normalized to [] when absent", (t) => {
  // §5.1. The block form, the flow form and an empty list all read as lists.
  for (const requires of [["tool budget --ok"], ["tool gate approved --current", "tool budget --ok"], []]) {
    const ok = structuredClone(data);
    ok.phases.build.requires = requires;
    assert.deepEqual(validateRider(ok, allPrompts), [], JSON.stringify(requires));
  }
  for (const requires of ["tool budget --ok", ["tool budget --ok", 3], [""], [null], { a: "x" }]) {
    const bad = structuredClone(data);
    bad.phases.build.requires = requires;
    assert.deepEqual(validateRider(bad, allPrompts), ["phases.build: requires must be a list of shell commands"], JSON.stringify(requires));
  }
  const human = structuredClone(data);
  human.phases.merge.requires = ["tool budget --ok"];
  assert.deepEqual(validateRider(human, allPrompts), ["phases.merge: requires is not allowed on a human phase"]);

  const md = TEST_RIDER_MD.replace("\n  build:\n", "\n  build:\n    requires:\n      - test -f ok.flag\n      - tool budget --ok\n").replace("\n  close:\n", "\n  close:\n    requires: [ test -d riders ]\n");
  const p = tmpProject({ riderMd: md });
  t.after(p.cleanup);
  const rider = loadRider(p.file);
  assert.deepEqual([rider.phases.plan.requires, rider.phases.build.requires, rider.phases.close.requires], [[], ["test -f ok.flag", "tool budget --ok"], ["test -d riders"]]);
  assert.equal("requires" in rider.phases.merge, false, "a human phase has none");
});

test("a missing prompt file is an error; prompt defaults to <phase>.md", () => {
  const errs = validateRider(data, (p) => p !== "build.md");
  assert.deepEqual(errs, ["phases.build: prompt file build.md not found"]);
});

test("discover + load from a temp project", () => {
  const root = mkdtempSync(join(tmpdir(), "rider-md-"));
  const dir = join(root, "riders", "lemmaria");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "RIDER.md"), LEMMARIA_RIDER_MD);
  for (const p of ["plan", "build", "close"]) writeFileSync(join(dir, `${p}.md`), `${p} prompt`);
  mkdirSync(join(root, "riders", "not-a-rider"));
  const found = discoverRiders(root);
  assert.deepEqual(found.map((r) => r.name), ["lemmaria"]);
  const rider = loadRider(found[0].file);
  assert.equal(rider.phases.plan.kind, "session");
  assert.equal(rider.phases.plan.prompt, join(dir, "plan.md"));
  assert.equal(rider.phases.merge.kind, "human");
  assert.equal(rider.limits.visits, 3);
  assert.deepEqual(legalLabels(rider, "build"), [
    { label: "code green", to: "close" }, { label: "blocked", to: "operator" },
    { label: "resume", to: "build" }, { label: "operator", to: "operator" },
  ]);
  assert.deepEqual(legalLabels(rider, "merge"), []);
  writeFileSync(join(dir, "RIDER.md"), LEMMARIA_RIDER_MD.replace("start: plan", "start: nowhere"));
  assert.throws(() => loadRider(found[0].file), /start: "nowhere" is not a declared phase/);
  assert.deepEqual(discoverRiders(join(root, "nothing-here")), []);
  rmSync(root, { recursive: true, force: true });
});

test("instances: the glob's directories are the instances, sorted, with their scopes", () => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["b", "a", ".hidden"] });
  try {
    writeFileSync(join(p.root, "nodes", "x.txt"), "a file is not an instance");
    const rider = loadRider(p.file);
    assert.equal(rider.instances, "nodes/*");
    const r = listInstances(p.root, rider);
    assert.equal(r.declared, true);
    assert.deepEqual(r.instances, [{ id: "a", scope: "nodes/a" }, { id: "b", scope: "nodes/b" }]);
    assert.deepEqual(r.skipped, [], "a dot-directory is never matched, so it is not reported either");
  } finally { p.cleanup(); }
  // Nothing created yet is no instances, not an error: creating the directory is what creates one.
  const q = tmpProject({ riderMd: INSTANCE_RIDER_MD });
  try { assert.deepEqual(listInstances(q.root, loadRider(q.file)), { declared: true, instances: [], skipped: [] }); } finally { q.cleanup(); }
});

test("the last segment matches literally apart from *, and a glob with no parent scopes to the root", () => {
  const root = mkdtempSync(join(tmpdir(), "rider-md-"));
  try {
    for (const d of ["w/v1.a", "w/v1xa", "w/v2.b", "top"]) mkdirSync(join(root, d), { recursive: true });
    assert.deepEqual(listInstances(root, { instances: "w/v1.*" }).instances, [{ id: "v1.a", scope: "w/v1.a" }], "the . is literal");
    assert.deepEqual(listInstances(root, { instances: "t*" }).instances, [{ id: "top", scope: "top" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a match that is not a safe id, or a reserved one, is skipped and reported", () => {
  const p = tmpProject({ riderMd: INSTANCE_RIDER_MD, instances: ["a", "bad name", "run.json"] });
  try {
    const r = listInstances(p.root, loadRider(p.file));
    assert.deepEqual(r.instances, [{ id: "a", scope: "nodes/a" }]);
    // `run.json` is a safe id; it is skipped because the name is already used at the rider level.
    assert.deepEqual(r.skipped, [
      { path: "nodes/bad name", reason: "not a safe id (letters, digits, _, . and -; not starting with .)" },
      { path: "nodes/run.json", reason: "reserved name" },
    ]);
  } finally { p.cleanup(); }
});

test("a rider without instances has one instance, default, at the root", () => {
  const p = tmpProject({ instances: ["a"] });
  try {
    const rider = loadRider(p.file);
    assert.equal(rider.instances, null);
    assert.deepEqual(listInstances(p.root, rider), { declared: false, instances: [{ id: "default", scope: "." }], skipped: [] });
  } finally { p.cleanup(); }
});

test("instances must be one relative glob with * only in the last segment", () => {
  for (const v of ["/abs/*", "a/*/b", "../x/*", "a/b?", 42, "a\\*", "x/..", "x/[ab]", "x/{a,b}"]) {
    const errs = validateRider({ ...structuredClone(data), instances: v }, allPrompts);
    assert.ok(errs.some((e) => e.startsWith("instances:")), `expected an instances error for ${JSON.stringify(v)}; got ${errs.join(" | ")}`);
  }
  for (const v of ["nodes/*", "*", "work/v1..2-*", "nodes/fixed"]) assert.deepEqual(validateRider({ ...structuredClone(data), instances: v }, allPrompts), [], v);
});

test("a rider whose name differs from its directory is refused", () => {
  const p = tmpProject({ name: "other" });
  try {
    assert.match(TEST_RIDER_MD, /^name: lemmaria$/m);
    assert.throws(() => loadRider(p.file), /name "lemmaria" must equal its directory name "other"/);
  } finally { p.cleanup(); }
});

test("overrulable lists onward edges only after a judge's operator stop", () => {
  const p = tmpProject();
  try {
    const rider = loadRider(p.file);
    // `operator` again is no ruling, and `resume` would tell the session the environment cut it short.
    assert.deepEqual(onwardEdges(rider, "close"), [{ label: "gate green", to: "merge" }]);
    assert.deepEqual(onwardEdges(rider, "merge"), [], "a human phase has no edges");
    const stopped = (phase, extra = {}, stop = {}) => ({ phase, endedBy: "operator", transitions: [{ at: "t", from: phase, label: "operator", to: "operator", because: "x", ...stop }], ...extra });
    assert.deepEqual(overrulable(rider, stopped("close")), ["gate green"]);
    assert.deepEqual(overrulable(rider, stopped("plan")), ["planned"]);
    assert.deepEqual(overrulable(rider, stopped("plan", {}, { by: "executor" })), [], "nobody judged a visit-cap stop");
    assert.deepEqual(overrulable(rider, stopped("close", { endedBy: "reset" })), []);
    assert.deepEqual(overrulable(rider, stopped("merge", { endedBy: "done" }, { label: "gate green", to: "merge" })), []);
    assert.deepEqual(overrulable(rider, stopped("close", { endedBy: undefined })), [], "an active run has no stop to overrule");
    assert.deepEqual(overrulable(rider, stopped("close", {}, { label: "gate green", to: "merge" })), [], "the last call must be the stop");
    assert.deepEqual(overrulable(rider, { phase: "close", endedBy: "operator", transitions: [] }), []);
    assert.deepEqual(overrulable(rider, null), []);
  } finally { p.cleanup(); }
});
