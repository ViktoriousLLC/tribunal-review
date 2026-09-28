// Quiet, complete reviews stop the loop; budgets and failed legs do not establish success.
//
// A dead leg is never a quiet round: silently accepting a missing reply would let the loop
// end early while appearing to have completed the expected review.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isActionable, summariseRound, isPassingRound, isRecordableRound, loopDecision, trendLine, soleFindsByLeg, CEILING } from "./panelLogic.mjs";

const leg = (name, answered = true, error = null) => ({ leg: name, answered, error });
const ALL_ANSWERED = [leg("opus"), leg("fable"), leg("sol"), leg("terra"), leg("gemini")];
const blocker = (cat = "correctness", by = ["opus"]) => ({ severity: "BLOCKER", category: cat, foundBy: by });

test("a BLOCKER in an actionable category is actionable, even from one leg", () => {
  for (const cat of ["correctness", "security", "money", "data-loss", "pii"]) {
    assert.equal(isActionable(blocker(cat)), true, cat);
  }
});

test("a blocker in a non-actionable category is not", () => {
  assert.equal(isActionable(blocker("style")), false);
  assert.equal(isActionable(blocker("perf")), false);
});

test("a LONE suggestion is not actionable; two independent legs make it so", () => {
  assert.equal(isActionable({ severity: "SUGGESTION", category: "security", foundBy: ["gemini"] }), false);
  assert.equal(isActionable({ severity: "SUGGESTION", category: "security", foundBy: ["gemini", "sol"] }), true);
});

test("nits and malformed findings are never actionable", () => {
  assert.equal(isActionable({ severity: "NIT", category: "correctness", foundBy: ["a", "b"] }), false);
  assert.equal(isActionable(null), false);
  assert.equal(isActionable({}), false);
});

test("a complete panel with no actionable finding is QUIET", () => {
  const s = summariseRound({ legs: ALL_ANSWERED, findings: [blocker("style")] });
  assert.equal(s.quiet, true);
  assert.equal(loopDecision({ round: 3, summary: s }).reason, "QUIET");
});

test("A DEAD LEG IS NEVER A QUIET ROUND, even with zero actionable findings", () => {
  // The whole file exists for this assertion.
  const legs = [leg("opus"), leg("fable"), leg("sol"), leg("terra"), leg("gemini", false, "exit 1: credential expired")];
  const s = summariseRound({ legs, findings: [] });
  assert.equal(s.actionableCount, 0);
  assert.equal(s.quiet, false, "zero findings from a partial panel must not read as quiet");
  const d = loopDecision({ round: 3, summary: s });
  assert.equal(d.reason, "PARTIAL");
  assert.match(d.why, /gemini \(exit 1: credential expired\)/);
});

test("a partial panel is reported as partial even when it DID find things", () => {
  const legs = [leg("opus"), leg("gemini", false, "timeout")];
  const d = loopDecision({ round: 1, summary: summariseRound({ legs, findings: [blocker()] }) });
  assert.equal(d.reason, "PARTIAL");
});

test("an empty leg list is not quiet either — no panel ran", () => {
  assert.equal(summariseRound({ legs: [], findings: [] }).quiet, false);
  assert.equal(summariseRound().quiet, false);
});

test("a fix that did not land triggers REDO, not a new round", () => {
  const s = summariseRound({ legs: ALL_ANSWERED, findings: [blocker()] });
  const d = loopDecision({ round: 4, summary: s, previousActionable: [blocker(), blocker()], stillPresent: [blocker()] });
  assert.equal(d.action, "REDO");
  assert.equal(d.reason, "FIX_DID_NOT_LAND");
  assert.match(d.why, /1 of the previous round's 2/);
});

test("REDO outranks QUIET: a quiet round means nothing if the last fix never landed", () => {
  const s = summariseRound({ legs: ALL_ANSWERED, findings: [] });
  assert.equal(s.quiet, true);
  const d = loopDecision({ round: 4, summary: s, previousActionable: [blocker()], stillPresent: [blocker()] });
  assert.equal(d.action, "REDO");
});

test("PARTIAL outranks REDO: an incomplete panel cannot judge whether a fix landed", () => {
  const legs = [leg("opus"), leg("sol", false, "boom")];
  const d = loopDecision({ round: 4, summary: summariseRound({ legs, findings: [] }), previousActionable: [blocker()], stillPresent: [blocker()] });
  assert.equal(d.reason, "PARTIAL");
});

test("the loop CONTINUES while a complete panel keeps producing actionable findings", () => {
  const d = loopDecision({ round: 2, summary: summariseRound({ legs: ALL_ANSWERED, findings: [blocker()] }) });
  assert.equal(d.action, "CONTINUE");
  assert.match(d.why, /round 3/);
});

test("the ceiling stops the loop and says plainly that this is NOT a clean bill", () => {
  const d = loopDecision({ round: CEILING, summary: summariseRound({ legs: ALL_ANSWERED, findings: [blocker()] }) });
  assert.equal(d.action, "STOP");
  assert.equal(d.reason, "CEILING");
  assert.match(d.why, /not a clean bill/);
});

test("an actionable round below the ceiling continues", () => {
  assert.equal(loopDecision({ round: CEILING - 1, summary: summariseRound({ legs: ALL_ANSWERED, findings: [blocker()] }) }).action, "CONTINUE");
});

test("loopDecision refuses to guess without a summary", () => {
  assert.throws(() => loopDecision({ round: 1 }), /needs a round summary/);
});

test("the trend line appears every fifth round and names a RISING rate loudly", () => {
  assert.equal(trendLine([3, 2, 1]), null);
  assert.match(trendLine([4, 4, 3, 2, 1]), /falling/);
  assert.match(trendLine([1, 1, 2, 4, 5]), /RISING/);
  assert.match(trendLine([1, 1, 2, 4, 5]), /still changing under the review/);
  assert.equal(trendLine([1, 1, 1, 1, 1, 1]), null, "only every fifth round");
});

test("soleFindsByLeg counts only findings exactly one leg saw", () => {
  const counts = soleFindsByLeg([
    { foundBy: ["gemini"] }, { foundBy: ["gemini"] }, { foundBy: ["opus", "sol"] }, { foundBy: [] },
  ]);
  assert.deepEqual(counts, { gemini: 2 });
});

test("A PANEL NOBODY COULD PARSE IS NOT A QUIET ROUND", () => {
  // An unreadable leg is answered:true and contributes zero findings. A panel-wide parse
  // failure therefore needs its own check so it cannot be mistaken for a quiet round.
  const legs = ALL_ANSWERED.map((l) => ({ ...l, parseFailed: true, error: "could not parse findings JSON" }));
  const s = summariseRound({ legs, findings: [] });
  assert.equal(s.complete, true, "every leg did answer");
  assert.equal(s.actionableCount, 0);
  assert.equal(s.noneReadable, true);
  assert.equal(s.quiet, false, "zero findings from an unreadable panel must not read as quiet");
  const d = loopDecision({ round: 2, summary: s });
  assert.equal(d.reason, "UNREADABLE");
  assert.match(d.why, /not that the artifact is clean/);
});

test("ONE unreadable leg among readable ones still allows a quiet round, and names it", () => {
  const legs = [...ALL_ANSWERED.slice(0, 4), { ...leg("gemini"), parseFailed: true, error: "prose" }];
  const s = summariseRound({ legs, findings: [] });
  assert.equal(s.noneReadable, false, "four legs were readable");
  assert.equal(s.quiet, true);
  assert.equal(s.unreadable.length, 1);
  assert.equal(s.unreadable[0].leg, "gemini");
});

test("PARTIAL still outranks UNREADABLE", () => {
  const legs = [{ ...leg("opus"), parseFailed: true }, leg("sol", false, "boom")];
  assert.equal(loopDecision({ round: 1, summary: summariseRound({ legs, findings: [] }) }).reason, "PARTIAL");
});

test("the trend line reads REAL history, so a falling rate is not reported as flat", () => {
  // Array(round).fill(thisRoundsCount) would make the two halves identical by construction
  // and always report "flat". Varied history must preserve both rising and falling trends.
  assert.match(trendLine([9, 7, 5, 3, 2]), /falling/);
  assert.match(trendLine([2, 2, 2, 2, 2]), /flat/);
  assert.match(trendLine([1, 1, 3, 4, 6]), /RISING/);
});

test("isPassingRound: only QUIET is a pass, and the other three STOPs are not", () => {
  // Checking only `action === "STOP"` would certify panels that lost a leg. Passing proof
  // requires the specific QUIET reason, independently of the loop stopping.
  assert.equal(isPassingRound({ action: "STOP", reason: "QUIET" }), true);
  for (const reason of ["PARTIAL", "UNREADABLE", "CEILING"]) {
    assert.equal(isPassingRound({ action: "STOP", reason }), false,
      `${reason} is a STOP but it is NOT a pass, and loopDecision's own text says so`);
  }
  assert.equal(isPassingRound({ action: "CONTINUE", reason: "ACTIONABLE" }), false);
  assert.equal(isPassingRound({ action: "REDO", reason: "FIX_DID_NOT_LAND" }), false);
  assert.equal(isPassingRound(null), false);
  assert.equal(isPassingRound(undefined), false);
});

test("isPassingRound agrees with loopDecision on every reason loopDecision can return", () => {
  // Pinned against the REAL producer, not a hand-written list: a reason renamed in loopDecision
  // and not here would otherwise leave the predicate silently rejecting every round, or worse
  // accepting one it should not. Only the quiet round may pass.
  const complete = { complete: true, missing: [], quiet: false, actionableCount: 2, noneReadable: false, unreadable: [] };
  const cases = [
    [{ ...complete, complete: false, missing: [{ leg: "sol", error: "timeout" }] }, 1, false],
    [{ ...complete, noneReadable: true, unreadable: [{ leg: "sol", error: "no json" }] }, 1, false],
    [{ ...complete, quiet: true }, 1, true],
    [complete, CEILING, false],
    [complete, 1, false],
  ];
  for (const [summary, round, expected] of cases) {
    const decision = loopDecision({ round, summary });
    assert.equal(isPassingRound(decision), expected,
      `loopDecision returned ${decision.action}/${decision.reason}; expected pass=${expected}`);
  }
});

test("isRecordableRound: a complete, readable round is recordable whatever it found", () => {
  // A complete, readable review is recordable even with findings; requiring QUIET would
  // conflate evidence that a review ran with evidence that it passed.
  assert.equal(isRecordableRound({ complete: true, noneReadable: false, actionableCount: 7 }), true);
  assert.equal(isRecordableRound({ complete: true, noneReadable: false, actionableCount: 0 }), true);
  // The two disqualifiers survive: a lost leg and a panel nobody could parse are not reviews.
  assert.equal(isRecordableRound({ complete: false, noneReadable: false }), false);
  assert.equal(isRecordableRound({ complete: true, noneReadable: true }), false);
  assert.equal(isRecordableRound(null), false);
});

test("recordable and passing are DIFFERENT questions, and both keep their meaning", () => {
  // A round with findings was reviewed but did not pass; the predicates must distinguish those states.
  const withFindings = { complete: true, noneReadable: false, actionableCount: 7, missing: [], quiet: false };
  const decision = loopDecision({ round: 2, summary: withFindings });
  assert.equal(isRecordableRound(withFindings), true, "reviewed");
  assert.equal(isPassingRound(decision), false, "but not passed");
});
