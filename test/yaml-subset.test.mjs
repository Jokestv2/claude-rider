// test/yaml-subset.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { parseFrontmatter, parseYamlSubset } from "../scripts/lib/yaml-subset.mjs";
import { LEMMARIA_RIDER_MD } from "./helpers.mjs";

test("the worked example (§2.4) parses verbatim", () => {
  const { data, body } = parseFrontmatter(LEMMARIA_RIDER_MD);
  assert.equal(data.name, "lemmaria");
  assert.equal(data.start, "plan");
  assert.deepEqual(data.phases.plan, { model: "fable", edges: { planned: "build", blocked: "operator" } });
  assert.deepEqual(data.phases.build.edges, { "code green": "close", blocked: "operator" });
  assert.deepEqual(data.phases.merge, {
    human: true,
    check: "test -n \"$RIDER_WORK_TIP\" && git merge-base --is-ancestor \"$RIDER_WORK_TIP\" main",
    show: "git diff --stat main...HEAD -- Lemmaria-design-doc/tests/",
  });
  assert.deepEqual(data.intake, [
    'test -z "$(git status --porcelain)"',
    "test -f Lemmaria-design-doc/docs/progress.md",
    "git branch --show-current | grep -Eq '^(main|feature/)'",
  ]);
  assert.equal(data.evidence.length, 3);
  assert.match(body, /^One milestone of the Lemmaria build/);
});

test("scalars are typed; quoted strings unescape", () => {
  const d = parseYamlSubset('a: true\nb: 3\nc: "x \\"y\\" z"\nd: \'it\'\'s\'\ne: null\nf: bare text: with colon');
  assert.deepEqual(d, { a: true, b: 3, c: 'x "y" z', d: "it's", e: null, f: "bare text: with colon" });
});

test("nested block maps and a limits block", () => {
  const d = parseYamlSubset("limits:\n  visits: 2\nphases:\n  plan:\n    model: opus\n    edges: { retry: plan }");
  assert.deepEqual(d, { limits: { visits: 2 }, phases: { plan: { model: "opus", edges: { retry: "plan" } } } });
});

test("a flow map may span lines and nest", () => {
  const d = parseYamlSubset("p: { model: a,\n     edges: { ok: b, bad: operator } }");
  assert.deepEqual(d.p, { model: "a", edges: { ok: "b", bad: "operator" } });
});

test("flow sequences and comment lines", () => {
  const d = parseYamlSubset("# comment\nlist: [ a, b, 'c, d' ]\nempty: {}");
  assert.deepEqual(d, { list: ["a", "b", "c, d"], empty: {} });
});

test("errors name the line", () => {
  assert.throws(() => parseYamlSubset("ok: 1\n  bad line"), /line 2/);
  assert.throws(() => parseYamlSubset("x: { a: 1"), /unterminated/);
  assert.throws(() => parseFrontmatter("no frontmatter"), /frontmatter/);
});

/** The parse in a worker with a small heap and a deadline: a reader that loops fails the test, instead of eating the
 *  machine's memory or hanging the suite. A worker that outgrows its heap is ended, not the process, so no core is dumped. */
function parseBounded(text, ms = 5000) {
  const url = new URL("../scripts/lib/yaml-subset.mjs", import.meta.url).href;
  const code = `const { parentPort, workerData } = require("node:worker_threads");
import(workerData.url).then(({ parseYamlSubset }) => {
  try { parentPort.postMessage({ value: parseYamlSubset(workerData.text) }); } catch (e) { parentPort.postMessage({ error: e.message }); }
});`;
  return new Promise((resolve) => {
    const worker = new Worker(code, { eval: true, workerData: { url, text }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
    const timer = setTimeout(() => { worker.terminate(); resolve({ hung: `no answer in ${ms} ms` }); }, ms);
    worker.on("message", (m) => { clearTimeout(timer); resolve(m); });
    worker.on("error", (e) => { clearTimeout(timer); resolve({ hung: e.code ?? e.message }); });
  });
}

test("an unquoted ] or } inside a flow-list item is an error that names the fix, never a hang", async () => {
  for (const line of ["a: [ test ${X} = y ]", "a: [ grep x}y f ]", "requires: [ test -f ok.flag, test -f ${RIDER_SCOPE}/approved ]"]) {
    assert.deepEqual(await parseBounded(line), { error: 'yaml: unexpected "}" in a flow list at line 1 — quote the item or use a block list' }, line);
  }
  assert.deepEqual(await parseBounded('a: [ "test ${X} = y", b ]'), { value: { a: ["test ${X} = y", "b"] } });
  // A flow map takes only a comma or its closing brace after a value, alike.
  assert.deepEqual(await parseBounded("m: { a: x]y, b: z }"), { error: 'yaml: unexpected "]" in a flow map at line 1 — quote the value or use a block map' });
  assert.deepEqual(await parseBounded('m: { a: "x]y", b: z }'), { value: { m: { a: "x]y", b: "z" } } });
  assert.match((await parseBounded("x: [ a, b")).error, /unterminated \[/);
});
