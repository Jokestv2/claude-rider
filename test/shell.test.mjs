// test/shell.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { capText, resolveShell, sh } from "../scripts/lib/shell.mjs";

const shell = resolveShell({});

test("sh runs a POSIX command through the resolved shell and captures exit + output", () => {
  assert.equal(sh("echo hi", { shell }).output, "hi");
  assert.equal(sh("exit 3", { shell }).status, 3);
  assert.equal(sh('test -z "$(echo)"', { shell }).status, 0);
  assert.equal(sh("echo out; echo err 1>&2", { shell }).output, "out\nerr");
});

test("sh forwards env, and omitting it still inherits the parent", () => {
  const withEnv = sh("echo \"[$RIDER_WORK_BRANCH]\"", { shell, env: { ...process.env, RIDER_WORK_BRANCH: "feature/r4-grounding" } });
  assert.equal(withEnv.status, 0);
  assert.equal(withEnv.output, "[feature/r4-grounding]");

  process.env.RIDER_SH_PROBE = "inherited";
  try {
    assert.equal(sh("echo \"$RIDER_SH_PROBE\"", { shell }).output, "inherited");
  } finally { delete process.env.RIDER_SH_PROBE; }
});

test("local.shell overrides; capText caps by bytes and says so", () => {
  assert.equal(resolveShell({ shell: "/custom/sh" }), "/custom/sh");
  assert.equal(capText("short", 100), "short");
  assert.match(capText("a".repeat(3000), 2048), /^a{2048}\n… capped at 2048 bytes$/);
});
