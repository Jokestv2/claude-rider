// test/yaml-subset.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
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
    check: "git merge-base --is-ancestor HEAD main",
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
