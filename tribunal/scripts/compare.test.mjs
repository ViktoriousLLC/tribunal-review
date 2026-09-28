// Pin the equivalence gate independently of data collection to prevent a moving threshold.
//
// The gate's whole point is that it can fail. Two of these tests exist to prove it can: an
// UNMEASURABLE verdict when there is no floor, and a DIVERGENT one when local really differs.
// A gate that can only pass is decoration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agreement, siteAgreement, overlap, comparable, sites, noiseFloor, equivalenceVerdict, TOLERANCE, FLOOR_FLOOR } from "./compare.mjs";

const f = (title, file = "a.ts", severity = "BLOCKER", category = "correctness") => ({ title, file, severity, category, foundBy: ["x"] });

test("only ACTIONABLE findings are compared — nits are noise on both sides", () => {
  const list = [f("real bug"), { ...f("whitespace"), severity: "NIT", category: "style" }];
  assert.equal(comparable(list).length, 1);
});

test("identical panels agree perfectly", () => {
  const a = [f("N+1 in the ownership check"), f("missing null guard", "b.ts")];
  assert.equal(agreement(a, a).score, 1);
});

test("two panels that share nothing score zero", () => {
  assert.equal(agreement([f("alpha problem")], [f("completely different thing", "z.ts")]).score, 0);
});

test("both panels finding nothing actionable is agreement, and says so", () => {
  const r = agreement([], []);
  assert.equal(r.score, 1);
  assert.match(r.note, /both panels found nothing actionable/);
});

test("one panel finding nothing while the other finds something is NOT agreement", () => {
  // The dangerous direction: a dead or lazy local panel must not read as equivalent.
  assert.equal(agreement([], [f("a real blocker")]).score, 0);
});

test("matching is ONE-TO-ONE, so duplicates cannot inflate the overlap", () => {
  const a = [f("N+1 query in ownership check"), f("N+1 query in ownership check")];
  const b = [f("ownership check has an N+1 query")];
  assert.equal(overlap(a, b), 1, "three near-identical findings cannot all claim the same counterpart");
});

test("the matching rule is the PANEL's own, so a different file is a different finding", () => {
  assert.equal(agreement([f("missing null check", "a.ts")], [f("missing null check", "b.ts")]).score, 0);
});

test("partial overlap gives a Jaccard score, and reports what only one side saw", () => {
  const a = [f("shared bug"), f("only in CI", "c.ts")];
  const b = [f("shared bug"), f("only in local", "d.ts")];
  const r = agreement(a, b);
  assert.equal(r.shared, 1);
  assert.equal(r.onlyA, 1);
  assert.equal(r.onlyB, 1);
  assert.equal(r.score, 1 / 3);
});

test("the noise floor is the CI panel against ITSELF, averaged over pairs", () => {
  const run1 = [f("bug one"), f("bug two", "b.ts")];
  const run2 = [f("bug one")];
  const nf = noiseFloor([[run1, run2]]);
  assert.equal(nf.floor, 0.5);
  assert.match(nf.why, /1 CI self-comparison/);
});

test("NO FLOOR MEANS NO VERDICT — never a pass", () => {
  // "We could not measure it" and "it passed" are different answers.
  const nf = noiseFloor([]);
  assert.equal(nf.floor, null);
  const v = equivalenceVerdict({ floor: nf.floor, crossScores: [0.9] });
  assert.equal(v.ok, false);
  assert.equal(v.verdict, "UNMEASURABLE");
  assert.match(v.why, /run the CI panel twice/);
});

test("no cross-comparisons means no verdict either", () => {
  const v = equivalenceVerdict({ floor: 0.8, crossScores: [] });
  assert.equal(v.ok, false);
  assert.equal(v.verdict, "UNMEASURABLE");
});

test("local passes when it agrees with CI about as well as CI agrees with itself", () => {
  const v = equivalenceVerdict({ floor: 0.60, crossScores: [0.58, 0.62] });
  assert.equal(v.verdict, "EQUIVALENT");
  assert.ok(v.ok);
});

test("THE GATE CAN FAIL: local well below the bar is DIVERGENT, and it is not blamed on variance", () => {
  const v = equivalenceVerdict({ floor: 0.80, crossScores: [0.20, 0.25] });
  assert.equal(v.verdict, "DIVERGENT");
  assert.equal(v.ok, false);
  assert.match(v.why, /not model variance/);
});

test("the tolerance is stated once and applied, not chosen after seeing the numbers", () => {
  assert.equal(TOLERANCE, 0.10);
  // Exactly at the bar passes; a hair under does not.
  assert.equal(equivalenceVerdict({ floor: 0.5, crossScores: [0.4] }).ok, true);
  assert.equal(equivalenceVerdict({ floor: 0.5, crossScores: [0.39] }).ok, false);
});

test("a noisy CI panel lowers the bar rather than failing local for CI's own variance", () => {
  // If CI cannot reproduce itself, demanding that local reproduce CI is demanding the impossible.
  assert.equal(equivalenceVerdict({ floor: 0.30, crossScores: [0.25] }).verdict, "EQUIVALENT");
});

test("A ZERO FLOOR IS UNMEASURABLE, NOT A FREE PASS", () => {
  // A zero floor minus tolerance produces a negative bar that every possible score clears,
  // including an empty local panel. The floor must be rejected before computing that bar.
  const v = equivalenceVerdict({ floor: 0, crossScores: [0] });
  assert.equal(v.ok, false);
  assert.equal(v.verdict, "UNMEASURABLE");
  assert.match(v.why, /agrees with ITSELF/);
  assert.match(v.why, /proves nothing in either direction/);
});

test("a floor just above zero is equally broken and equally refused", () => {
  assert.equal(equivalenceVerdict({ floor: 0.05, crossScores: [0.9] }).verdict, "UNMEASURABLE");
  assert.equal(equivalenceVerdict({ floor: FLOOR_FLOOR, crossScores: [0.9] }).verdict, "UNMEASURABLE");
});

test("a believable floor still produces a real verdict, both ways", () => {
  assert.equal(equivalenceVerdict({ floor: 0.60, crossScores: [0.58] }).verdict, "EQUIVALENT");
  assert.equal(equivalenceVerdict({ floor: 0.60, crossScores: [0.10] }).verdict, "DIVERGENT");
});

test("a perfect local score cannot buy a pass off a broken floor", () => {
  // The dangerous direction: without the floor-of-the-floor, a broken ruler plus a lucky number
  // would certify the migration.
  assert.equal(equivalenceVerdict({ floor: 0, crossScores: [1] }).ok, false);
});

test('siteAgreement compares WHERE and WHAT KIND, not wording', () => {
  const ci = [{ title: 'Cost line and ledger hardcode zero despite a metered leg', file: 'scripts/run.mjs', severity: 'BLOCKER', category: 'correctness', foundBy: ['x'] }];
  const local = [{ title: 'meteredUsd is hardcoded and the footer asserts no spend unconditionally', file: 'scripts/run.mjs', severity: 'BLOCKER', category: 'correctness', foundBy: ['y'] }];
  assert.equal(siteAgreement(ci, local).score, 1);
  assert.equal(agreement(ci, local).score, 0);
});

test('a finding with no file is skipped, because it cannot be corroborated', () => {
  const withFile = [{ title: 'a', file: 'x.ts', severity: 'BLOCKER', category: 'correctness', foundBy: ['x'] }];
  const noFile = [{ title: 'a', file: null, severity: 'BLOCKER', category: 'correctness', foundBy: ['x'] }];
  assert.equal(sites(noFile).size, 0);
  assert.equal(siteAgreement(withFile, noFile).score, 0);
});

test('site paths are normalised, so a Windows path matches a POSIX one', () => {
  // Build from parts so an escape such as \t cannot silently turn a path separator into a tab.
  const winPath = ["scripts", "Run.mjs"].join("\\");
  const a = [{ title: 'a', file: winPath, severity: 'BLOCKER', category: 'correctness', foundBy: ['x'] }];
  const b = [{ title: 'b', file: 'scripts/run.mjs', severity: 'BLOCKER', category: 'correctness', foundBy: ['y'] }];
  assert.equal(siteAgreement(a, b).score, 1);
});

test('the same file with a DIFFERENT category is not the same site', () => {
  const a = [{ title: 'a', file: 'x.ts', severity: 'BLOCKER', category: 'correctness', foundBy: ['x'] }];
  const b = [{ title: 'b', file: 'x.ts', severity: 'BLOCKER', category: 'security', foundBy: ['y'] }];
  assert.equal(siteAgreement(a, b).score, 0);
});

test('siteAgreement still refuses to call a silent panel equivalent', () => {
  const found = [{ title: 'a', file: 'x.ts', severity: 'BLOCKER', category: 'correctness', foundBy: ['x'] }];
  assert.equal(siteAgreement([], found).score, 0);
});
