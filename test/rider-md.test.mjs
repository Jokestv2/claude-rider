// test/rider-md.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRiders, legalLabels, loadRider, validateRider } from "../scripts/lib/rider-md.mjs";
import { parseFrontmatter } from "../scripts/lib/yaml-subset.mjs";
import { LEMMARIA_RIDER_MD } from "./helpers.mjs";

const { data } = parseFrontmatter(LEMMARIA_RIDER_MD);
const allPrompts = () => true;

test("the worked example validates", () => assert.deepEqual(validateRider(data, allPrompts), []));

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
