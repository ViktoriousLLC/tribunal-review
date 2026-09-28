// Define the equivalence quantity, matching rule and threshold independently of the results
// so comparisons cannot be accepted or rejected by changing the gate after measurement.
//
//   THE QUANTITY: the set of defect sites a panel produced for one artifact.
//   THE MATCHING RULE: the same normalized file and category. Title-based matching remains
//     available for within-round comparisons and uses panelLogic's own `sameIssue` rule.
//   THE STATISTIC: Jaccard agreement, |intersection| / |union|, over ACTIONABLE sites only.
//     Nits and style are noise on both sides and would inflate agreement without meaning.
//   THE NOISE FLOOR: the CI panel compared against ITSELF across two runs on one pull request.
//     That is the honest bar. Model output is not deterministic, so demanding that local match
//     CI more closely than CI matches itself would be demanding something CI cannot do.
//   THE VERDICT: local passes when agreement(CI, local) >= noiseFloor - TOLERANCE.
//
// TOLERANCE exists because a floor measured from a single pair is itself a sample of one. It is
// stated here, once, rather than chosen later to make a number pass.

import { sameIssue, isActionable } from "./panelLogic.mjs";

export const TOLERANCE = 0.10;

/**
 * The floor below which the FLOOR itself is not believable.
 *
 * If the CI panel cannot reproduce its own findings from one run to the next, no comparison
 * against it means anything. Set above zero rather than at it, because a floor of 0.05 is just
 * as broken as a floor of 0 and would otherwise buy a passing grade.
 */
export const FLOOR_FLOOR = 0.15;

/** Actionable findings only. Comparing nits would inflate agreement without meaning. */
export function comparable(findings) {
  return (findings || []).filter(isActionable);
}

/**
 * How many findings in A have a counterpart in B, under the panel's OWN matching rule.
 *
 * Greedy and one-to-one: a matched finding in B is consumed, so three near-identical findings
 * on one side cannot each claim the same single finding on the other and inflate the overlap.
 */
export function overlap(a, b) {
  const remaining = [...b];
  let matched = 0;
  for (const f of a) {
    const i = remaining.findIndex((g) => sameIssue(f, g));
    if (i !== -1) { remaining.splice(i, 1); matched += 1; }
  }
  return matched;
}

/**
 * THE CROSS-PANEL UNIT: a defect SITE, `file|category`, not a finding title.
 *
 * Panels can describe the same defect using different titles, so cross-panel comparisons ask
 * whether both found an actionable problem of the same KIND in the same FILE. This is weaker
 * than identifying the same finding: two different correctness bugs in one file collapse to
 * one site, which biases the score toward agreement. The self-comparison floor must still
 * clear FLOOR_FLOOR before this more generous matching rule can support a verdict.
 *
 * A finding with no file is skipped: it cannot be located, so it cannot be corroborated.
 */
export function sites(findings) {
  const result = new Set();
  for (const f of comparable(findings)) {
    // Findings located in a PR description can have a null file. Normalize that to an empty
    // string before trimming so unlocatable findings are skipped without throwing.
    const file = (f.file || "").trim().replace(/\\/g, "/").toLowerCase();
    if (!file) continue;
    result.add(`${file}|${(f.category || "").toLowerCase()}`);
  }
  return result;
}

/** Jaccard over defect SITES. This is what the equivalence gate compares. */
export function siteAgreement(findingsA, findingsB) {
  const A = sites(findingsA), B = sites(findingsB);
  if (A.size === 0 && B.size === 0) return { score: 1, shared: 0, onlyA: 0, onlyB: 0, note: "both panels found nothing actionable with a locatable file" };
  let shared = 0;
  for (const site of A) {
    if (B.has(site)) shared += 1;
  }
  const union = A.size + B.size - shared;
  return { score: union === 0 ? 1 : shared / union, shared, onlyA: A.size - shared, onlyB: B.size - shared, note: null };
}

/** Jaccard over actionable findings matched by TITLE. Kept for within-round clustering. */
export function agreement(findingsA, findingsB) {
  const A = comparable(findingsA), B = comparable(findingsB);
  if (A.length === 0 && B.length === 0) return { score: 1, shared: 0, onlyA: 0, onlyB: 0, note: "both panels found nothing actionable" };
  const shared = overlap(A, B);
  const union = A.length + B.length - shared;
  return { score: union === 0 ? 1 : shared / union, shared, onlyA: A.length - shared, onlyB: B.length - shared, note: null };
}

/**
 * The noise floor: what the CI panel scores against itself, across pairs of runs on the same
 * artifact. Averaged when there is more than one pair.
 */
export function noiseFloor(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return { floor: null, why: "no CI self-comparison was run, so there is no floor and no verdict is possible" };
  }
  // Use the same site matching rule for the self-comparison floor and cross-panel scores;
  // title differences alone must not make equivalent defect sites appear disjoint.
  const scores = pairs.map(([a, b]) => siteAgreement(a, b).score);
  return { floor: scores.reduce((s, x) => s + x, 0) / scores.length, scores, why: `${pairs.length} CI self-comparison(s)` };
}

/**
 * The verdict. Refuses rather than guesses when the floor is unknown, because "we could not
 * measure it" and "it passed" are different answers and only one of them is honest.
 */
export function equivalenceVerdict({ floor, crossScores }) {
  if (floor == null) return { ok: false, verdict: "UNMEASURABLE", why: "no noise floor: run the CI panel twice on one pull request first" };
  if (!Array.isArray(crossScores) || crossScores.length === 0) {
    return { ok: false, verdict: "UNMEASURABLE", why: "no CI-versus-local comparisons were run" };
  }

  // A FLOOR AT OR NEAR ZERO MEANS THE RULER IS BROKEN, NOT THAT EVERYTHING PASSES.
  //
  // With floor 0 the bar becomes -0.10 and every possible result clears it, including a local
  // panel that returned nothing at all. Reject a near-zero floor before applying tolerance so
  // the gate cannot certify equivalence from an uninformative self-comparison.
  //
  // The honest reading is that a matcher unable to recognise a panel's own findings from one
  // run to the next cannot certify anything about a different panel. So it refuses.
  if (floor <= FLOOR_FLOOR) {
    return {
      ok: false,
      verdict: "UNMEASURABLE",
      floor,
      why: `the CI panel agrees with ITSELF at only ${floor.toFixed(2)} — two runs of the same panel on the same commit. A ruler that reads zero on a known-identical pair cannot certify a different panel, so this comparison proves nothing in either direction. Fix the comparison method before reading any number from it`,
    };
  }
  const mean = crossScores.reduce((s, x) => s + x, 0) / crossScores.length;
  const bar = floor - TOLERANCE;
  return {
    ok: mean >= bar,
    verdict: mean >= bar ? "EQUIVALENT" : "DIVERGENT",
    mean, floor, bar,
    why: mean >= bar
      ? `local agrees with CI at ${mean.toFixed(2)}, against a bar of ${bar.toFixed(2)} (CI agrees with itself at ${floor.toFixed(2)}, tolerance ${TOLERANCE})`
      : `local agrees with CI at only ${mean.toFixed(2)}, below the bar of ${bar.toFixed(2)}. CI agrees with itself at ${floor.toFixed(2)}, so this is a real difference and not model variance`,
  };
}
