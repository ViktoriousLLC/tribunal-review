import test from "node:test";
import assert from "node:assert/strict";
import { BOT_LOGIN, PANEL_LEG_KEYS } from "./eval-reviewer.mjs";
import { dedupDecision, isPrNumber, reviewedShaFromComments, everyLegOk } from "./eval-dedup.mjs";

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

/** A record from a FULL-strength panel: every leg present and ok. */
const fullPanel = (extra = {}) => ({
  head_sha: "abc123",
  perModel: Object.fromEntries(PANEL_LEG_KEYS.map((k) => [k, { ok: true }])),
  ...extra,
});

test("matching bot SHA skips the review", () => {
  const reviewedSha = reviewedShaFromComments([comment(fullPanel())]);
  assert.deepEqual(dedupDecision({ headSha: "abc123", reviewedSha, force: false }), {
    skip: true,
    reason: "head-sha-match",
  });
});

test("different bot SHA runs the review", () => {
  const reviewedSha = reviewedShaFromComments([comment(fullPanel({ head_sha: "old-sha" }))]);
  assert.equal(dedupDecision({ headSha: "new-sha", reviewedSha, force: false }).skip, false);
});

test("a review by a PARTIAL panel does not count as having reviewed the commit", () => {
  // The only thing this dedup may refuse is a second identical review of identical code by
  // a fully working panel. A run where a leg was skipped or errored saw the commit with
  // fewer eyes, so the next request has to run it again rather than inherit that verdict.
  const failedLeg = fullPanel();
  failedLeg.perModel[PANEL_LEG_KEYS[0]] = { ok: false, error: "credential expired" };
  assert.equal(reviewedShaFromComments([comment(failedLeg)]), null, "a failed leg means re-review");

  // The sharper case: a leg that never ran at all leaves NO entry, so checking only the
  // keys that happen to be present read three ok legs as a complete panel.
  const missingLeg = fullPanel();
  delete missingLeg.perModel[PANEL_LEG_KEYS[PANEL_LEG_KEYS.length - 1]];
  assert.equal(reviewedShaFromComments([comment(missingLeg)]), null, "an absent leg means re-review");

  // Cannot-tell is false, never true: no block, an empty one, a leg missing its flag.
  assert.equal(everyLegOk(undefined), false);
  assert.equal(everyLegOk({ perModel: {} }), false);
  assert.equal(everyLegOk({ perModel: [] }), false, "an array is not a per-leg map");
  assert.equal(everyLegOk({ perModel: { claude: {} } }), false, "a leg with no ok flag is not an ok leg");
  assert.equal(everyLegOk(fullPanel()), true, "and a genuinely complete panel still counts");
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
