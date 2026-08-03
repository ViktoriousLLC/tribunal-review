import test from "node:test";
import assert from "node:assert/strict";
import { BOT_LOGIN } from "./eval-reviewer.mjs";
import { dedupDecision, isPrNumber, reviewedShaFromComments } from "./eval-dedup.mjs";

const COMMENT_MARKER = "<!-- eval-reviewer:v1 -->";
const DATA_MARKER_OPEN = "<!-- eval-data:v1: ";
const DATA_MARKER_CLOSE = " :end -->";

function comment(record, login = BOT_LOGIN) {
  const payload = Buffer.from(JSON.stringify(record), "utf8").toString("base64");
  return {
    user: { login },
    body: `${COMMENT_MARKER}\n...\n${DATA_MARKER_OPEN}${payload}${DATA_MARKER_CLOSE}`,
  };
}

test("matching bot SHA skips the review", () => {
  const reviewedSha = reviewedShaFromComments([comment({ head_sha: "abc123" })]);
  assert.deepEqual(dedupDecision({ headSha: "abc123", reviewedSha, force: false }), {
    skip: true,
    reason: "head-sha-match",
  });
});

test("different bot SHA runs the review", () => {
  const reviewedSha = reviewedShaFromComments([comment({ head_sha: "old-sha" })]);
  assert.equal(dedupDecision({ headSha: "new-sha", reviewedSha, force: false }).skip, false);
});

test("a non-bot lookalike cannot suppress the review", () => {
  const reviewedSha = reviewedShaFromComments([comment({ head_sha: "abc123" }, "untrusted-user")]);
  assert.equal(reviewedSha, null);
  assert.equal(dedupDecision({ headSha: "abc123", reviewedSha, force: false }).skip, false);
});

test("a bot payload without head SHA runs the review", () => {
  const reviewedSha = reviewedShaFromComments([comment({ costUSD_total: 0 })]);
  assert.equal(reviewedSha, null);
  assert.equal(dedupDecision({ headSha: "abc123", reviewedSha, force: false }).skip, false);
});

test("malformed comment collections run the review", () => {
  for (const comments of [[], null, {}, [null]]) {
    const reviewedSha = reviewedShaFromComments(comments);
    assert.equal(reviewedSha, null);
    assert.equal(dedupDecision({ headSha: "abc123", reviewedSha, force: false }).skip, false);
  }
});

test("force and missing current SHA run the review", () => {
  assert.equal(dedupDecision({ headSha: "abc123", reviewedSha: "abc123", force: true }).skip, false);
  assert.equal(dedupDecision({ headSha: "", reviewedSha: "abc123", force: false }).skip, false);
});

test("SHA comparisons ignore case and surrounding whitespace", () => {
  assert.equal(dedupDecision({ headSha: "ABC123 ", reviewedSha: "abc123", force: false }).skip, true);
});

test("dedupDecision remains based on the supplied head SHA", () => {
  assert.deepEqual(dedupDecision({ headSha: "abc123", reviewedSha: "abc123", force: false }), {
    skip: true,
    reason: "head-sha-match",
  });
});

test("isPrNumber accepts only digits", () => {
  for (const value of ["1/../2", "", "abc"]) assert.equal(isPrNumber(value), false);
  assert.equal(isPrNumber("795"), true);
});
