// The mechanism key and the stop-patching comparison, without a panel. convergence.test.mjs t8
// runs them through main(). RED-FIRST mutations: key on the title instead of the file; drop the
// path normalisation; compare against round N-2; let a fileless finding match another;
// accept a placeholder such as "N/A" as a file.
import test from "node:test";
import assert from "node:assert/strict";
import { mechanismKey, stopPatchingSignals, renderStopPatching } from "./run.mjs";
import { nextLine } from "./render.mjs";

const f = (title, file) => ({ title, file, severity: "BLOCKER", category: "security" });

test("the key is the normalised file, and a fileless finding has none", () => {
  for (const file of ["src/check.mjs", "./src/check.mjs", "src\\check.mjs", "src/check.mjs:41", "Src/Check.mjs:41-60"]) {
    assert.equal(mechanismKey(f("x", file)), "src/check.mjs", file);
  }
  for (const file of [null, undefined, "", "  ", "null", "N/A", "n/a", "NA", "-", "--", "None", "(none)", "multiple", "Various",
    "The release plan", "goal statement"]) assert.equal(mechanismKey(f("x", file)), null, String(file));
  for (const file of ["Makefile", "Dockerfile", "a.mjs"]) assert.equal(mechanismKey(f("x", file)), file.toLowerCase(), file);
  assert.equal(mechanismKey(f("x", "src/My Component.js")), "src/my component.js");
  for (const file of ["a/src/check.mjs", "b/src/check.mjs"]) assert.equal(mechanismKey(f("x", file)), "src/check.mjs", file);
});

test("two consecutive rounds on one file signal, whatever the titles say", () => {
  const previous = { runnerRound: 5, actionableFindings: [f("the first fix misses a case", "src/check.mjs")] };
  const signals = stopPatchingSignals(previous, [f("A second spelling slips through", "b/src/check.mjs:90")], 6);
  assert.deepEqual(signals.map(({ mechanism, rounds }) => ({ mechanism, rounds })), [{ mechanism: "src/check.mjs", rounds: [5, 6] }]);
  assert.deepEqual(signals[0].titles, { 5: ["the first fix misses a case"], 6: ["A second spelling slips through"] });
  const text = renderStopPatching(signals);
  assert.match(text, /^STOP PATCHING: src\/check\.mjs$/m);
  assert.match(text, /Round 5: the first fix misses a case/);
});

test("different files, a missing previous round, or fileless findings do not signal", () => {
  const previous = { runnerRound: 1, actionableFindings: [f("a", "a.mjs"), f("b", null)] };
  assert.deepEqual(stopPatchingSignals(previous, [f("c", "c.mjs"), f("d", null)], 2), []);
  assert.deepEqual(stopPatchingSignals(undefined, [f("a", "a.mjs")], 1), []);
  assert.deepEqual(stopPatchingSignals({ runnerRound: 1, actionableFindings: [] }, [f("a", "a.mjs")], 2), []);
  const placeholders = { runnerRound: 3, actionableFindings: [f("a", "N/A"), f("b", "-")] };
  assert.deepEqual(stopPatchingSignals(placeholders, [f("c", "N/A"), f("d", "-")], 4), [], "two rounds of N/A are not one mechanism");
});

test("the Next line changes only from CONTINUE, and still names the verdict", () => {
  const signals = [{ mechanism: "a.mjs", rounds: [1, 2] }];
  const go = { action: "CONTINUE", reason: "ACTIONABLE", why: "1 actionable finding(s) to fix, then round 3." };
  assert.match(nextLine(go, signals), /^\*\*Next:\*\* STOP PATCHING — `a\.mjs` drew actionable findings in rounds 1 and 2\./);
  assert.match(nextLine(go, signals), /Verdict unchanged: CONTINUE\/ACTIONABLE/);
  assert.equal(nextLine(go, []), `**Next:** CONTINUE — ${go.why}`);
  for (const decision of [{ action: "STOP", reason: "PARTIAL", why: "lost a leg" }, { action: "REDO", reason: "FIX_DID_NOT_LAND", why: "still there" },
    { action: "STOP", reason: "CEILING", why: "ten" }]) {
    assert.equal(nextLine(decision, signals), `**Next:** ${decision.action} — ${decision.why}`);
  }
});
