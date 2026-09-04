// test/markers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtCost, fmtDuration, formatFinal, formatQuestion, hasPromise, signedOff, statusHint, waitingIsDone } from "../scripts/lib/markers.mjs";

const green = "Gate record closed.\nSTATUS: gate green\n<promise>MILESTONE GATE GREEN</promise>";

test("statusHint is the LAST STATUS line, any wording", () => {
  assert.equal(statusHint("STATUS: planned\nmore\nSTATUS: BLOCKED — needs a decision"), "STATUS: BLOCKED — needs a decision");
  assert.equal(statusHint(green), "STATUS: gate green");
  assert.equal(statusHint("working on it"), null);
  assert.equal(statusHint(null), null);
});

test("signedOff needs both markers; waitingIsDone needs only the STATUS line and no question", () => {
  assert.equal(hasPromise(green), true);
  assert.equal(signedOff(green), true);
  assert.equal(signedOff("STATUS: planned"), false);
  assert.equal(signedOff("<promise>MILESTONE PLANNED</promise>"), false);
  assert.equal(waitingIsDone({ question: null, lastText: "STATUS: planned\nShall I go on?" }), true);
  assert.equal(waitingIsDone({ question: { questions: [] }, lastText: "STATUS: planned" }), false);
  assert.equal(waitingIsDone({ question: null, lastText: "Shall I disable the guard?" }), false);
  assert.equal(waitingIsDone(null), false);
});

test("formatting helpers", () => {
  assert.deepEqual(formatQuestion({ questions: [{ question: "A or B?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }] }), ['  "A or B?"  Choice: A / B']);
  assert.deepEqual(formatQuestion(null), []);
  assert.equal(formatFinal("hello", 100), "hello");
  assert.match(formatFinal("x".repeat(50), 10), /^xxxxxxxxxx\n… truncated at 10 of 50 chars/);
  assert.equal(formatFinal(null, 10), "(no final message)");
  assert.equal(fmtDuration(25 * 60_000), "25m");
  assert.equal(fmtDuration(95 * 60_000), "1h 35m");
  assert.equal(fmtDuration(6 * 3600_000), "6h");
  assert.equal(fmtDuration(-5000), "0m");
  assert.equal(fmtCost(null), "$?");
  assert.equal(fmtCost(1.5), "$1.50");
});
