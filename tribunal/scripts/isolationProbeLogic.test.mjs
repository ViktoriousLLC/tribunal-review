// The verdict wording for a silent negative control: a signed-out CLI must read as a login
// problem, not as a theory problem. RED-FIRST: the fixture fails when the hint is dropped.
import test from "node:test";
import assert from "node:assert/strict";
import { legVerdict } from "./isolationProbeLogic.mjs";
test("a VACUOUS verdict says what the control replied, or that it was silent (a signed-out CLI)", () => {
  // Mutation: drop the hint; a silent control then reads as a theory problem instead of a login problem.
  const silent = legVerdict({ controlLeaked: false, guardedLeaked: false, controlOut: "" });
  assert.equal(silent.verdict, "VACUOUS");
  assert.match(silent.why, /no output at all.*signed in/);
  const spoke = legVerdict({ controlLeaked: false, guardedLeaked: false, controlOut: "I cannot access files outside this directory." });
  assert.match(spoke.why, /the control replied: "I cannot access files/);
});
