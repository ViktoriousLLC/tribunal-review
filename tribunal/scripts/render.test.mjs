// Show missing reviewers and actionable findings before routine output.
//
// A lost leg appears ABOVE the fold because a missing reviewer changes the coverage of the
// review, and a thin panel must never read like a clean one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { render, verdictLine, costLine } from "./render.mjs";
import { summariseRound, loopDecision, clusterFindings, similarity, sameIssue } from "./panelLogic.mjs";

const artifact = { kind: "document", source: "x.md", title: "x.md", text: "" };
const legOk = (leg) => ({ leg, model: `${leg}-1`, answered: true, error: null });
const ALL = ["opus", "fable", "sol", "terra"].map(legOk);

function build({ clusters = [], legs = ALL, round = 1 }) {
  const summary = summariseRound({ legs: legs.map((l) => ({ leg: l.leg, answered: l.answered, error: l.error })), findings: clusters });
  const decision = loopDecision({ round, summary });
  return render({ artifact, clusters, summary, decision, legs, round, elapsedMs: 60000, disabled: [] });
}

const blocker = { title: "N+1 on the ownership check", severity: "BLOCKER", category: "correctness", file: "a.ts", line: 12, why: "loops a query", check: "count queries", foundBy: ["opus", "sol"] };
const nit = { title: "trailing whitespace", severity: "NIT", category: "style", file: "b.ts", why: "", check: "", foundBy: ["fable"] };

test("the first line after the title answers 'do I have to do anything' and nothing else", () => {
  const lines = build({ clusters: [blocker] }).split("\n");
  assert.match(lines[0], /^## 🧑‍⚖️ Tribunal/);
  assert.match(lines[2], /^⛔ 1 to act on/);
});

test("with nothing actionable the verdict line says so plainly", () => {
  assert.match(verdictLine([nit], 0), /^✅ Nothing to act on/);
});

test("A LOST LEG IS ABOVE THE FOLD, before any finding", () => {
  const legs = [...ALL, { leg: "gemini", model: "g", answered: false, error: "credential expired" }];
  const out = build({ clusters: [blocker], legs });
  const lostAt = out.indexOf("did not answer");
  const findingAt = out.indexOf("N+1 on the ownership check");
  assert.ok(lostAt > -1, "the lost leg must be named");
  assert.ok(lostAt < findingAt, "and it must come before the findings");
  assert.match(out, /NOT a verdict on the whole artifact/);
  assert.match(out, /credential expired/);
});

test("a section with no content is omitted entirely, never rendered empty", () => {
  const out = build({ clusters: [blocker] });
  assert.ok(!out.includes("### Suggestions"), "no empty Suggestions heading");
  assert.ok(!out.includes("nits</summary>"), "no empty nits block");
});

test("a finding says how many legs saw it, and names the leg when only one did", () => {
  const out = build({ clusters: [blocker, { ...nit, severity: "SUGGESTION", category: "security", title: "weak compare" }] });
  assert.match(out, /2 legs: opus, sol/);
  assert.match(out, /only fable/);
});

test("the blind-spot section exists, and says a lone finding is also what a hallucination looks like", () => {
  const out = build({ clusters: [{ ...blocker, foundBy: ["gemini"] }] });
  assert.match(out, /### What only one model saw/);
  assert.match(out, /hypothesis until checked/);
});

test("nits are folded away, not deleted", () => {
  const out = build({ clusters: [nit] });
  assert.match(out, /<details><summary>1 nits<\/summary>/);
});

test("the cost line is MEASURED, not asserted", () => {
  // An enabled metered leg must contribute its measured cost instead of inheriting the
  // plan-covered $0 label.
  const plan = { rows: [{ leg: "opus", usd: 0, basis: "plan (no key can reach this process)" }], totalUsd: 0, unmeasured: [] };
  assert.match(costLine(plan), /All legs plan-covered; \$0 metered this round\./);

  const spent = {
    rows: [{ leg: "opus", usd: 0, basis: "plan (no key)" }, { leg: "gemini", usd: 0.0148, basis: "estimated from the runner's own token counts" }],
    totalUsd: 0.0148, unmeasured: [],
  };
  assert.match(costLine(spent), /\$0\.0148 metered/);
  assert.ok(!/\$0 metered/.test(costLine(spent)), "real spend must never render as $0");
});

test("a metered leg with unknown usage or model price is 'not reported', never $0", () => {
  const unknown = {
    rows: [{ leg: "opus", usd: 0, basis: "plan (no key)" }, { leg: "gemini", usd: null, basis: "not reported by the runner" }],
    totalUsd: 0, unmeasured: ["gemini"],
  };
  const line = costLine(unknown);
  assert.match(line, /gemini cost is unknown \(usage or model price missing\)/);
  assert.match(line, /"not reported", not \$0/);
  // RED-FIRST mutation: lead an entirely unpriced round with a $0.0000 subtotal.
  assert.doesNotMatch(line, /\$0\.0000 metered/);
  assert.match(line, /UNPRICED/);
});

test("no cost information at all says so, rather than printing a zero", () => {
  assert.equal(costLine(null), "Cost: not reported.");
  assert.equal(costLine({ rows: [] }), "Cost: not reported.");
});

test("an UNREADABLE leg is named above the fold, so a short finding list is not believed", () => {
  const legs = ALL.map((l) => ({ ...l }));
  const summary = summariseRound({
    legs: [...legs.slice(0, 3).map((l) => ({ leg: l.leg, answered: true })), { leg: "terra", answered: true, parseFailed: true, error: "answered in prose" }],
    findings: [],
  });
  const out = render({ artifact, clusters: [], summary, decision: loopDecision({ round: 1, summary }), legs, round: 1, elapsedMs: 1000 });
  const noteAt = out.indexOf("could not be parsed");
  assert.ok(noteAt > -1, "the unreadable leg must be named");
  assert.ok(noteAt < out.indexOf("**Next:**"), "and it must come before the verdict");
  assert.match(out, /answered in prose/);
});

test("a disabled leg is NAMED as not-run and is not counted as missing", () => {
  const summary = summariseRound({ legs: ALL.map((l) => ({ leg: l.leg, answered: true })), findings: [] });
  const out = render({
    artifact, clusters: [], summary, decision: loopDecision({ round: 1, summary }),
    legs: ALL, round: 1, elapsedMs: 1000, disabled: ["gemini: no key on this machine."],
  });
  assert.match(out, /Not run, so not counted as missing/);
  assert.match(out, /gemini: no key on this machine\./);
  assert.ok(!out.includes("did not answer"), "disabled is not the same as lost");
});

test("clustering merges the same issue and keeps the WORST severity any leg gave it", () => {
  const clusters = clusterFindings([
    { leg: "opus", findings: [{ title: "N+1 query in the ownership check", severity: "SUGGESTION", category: "perf", file: "a.ts" }] },
    { leg: "sol", findings: [{ title: "ownership check does an N+1 query", severity: "BLOCKER", category: "correctness", file: "a.ts" }] },
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].foundBy, ["opus", "sol"]);
  assert.equal(clusters[0].severity, "BLOCKER", "a milder duplicate must not downgrade a blocker");
});

test("two findings naming DIFFERENT files are never merged, however similar the wording", () => {
  // Over-merging is the dangerous direction: it inflates the agreement count, and the
  // agreement count is what promotes a suggestion to actionable.
  assert.equal(sameIssue({ title: "missing null check", file: "a.ts" }, { title: "missing null check", file: "b.ts" }), false);
});

test("similarity ignores stopwords and is symmetric", () => {
  assert.ok(similarity("the query is in a loop", "query in loop") > 0.5);
  assert.equal(similarity("alpha beta", "beta alpha"), similarity("beta alpha", "alpha beta"));
  assert.equal(similarity("", "anything"), 0);
});

test("one leg reporting the same issue twice does not fake agreement with itself", () => {
  const clusters = clusterFindings([
    { leg: "opus", findings: [{ title: "N+1 in ownership check", file: "a.ts" }, { title: "ownership check N+1", file: "a.ts" }] },
  ]);
  assert.equal(clusters.length, 2, "a leg cannot corroborate itself, so the duplicate stays separate");
  assert.deepEqual(clusters[0].foundBy, ["opus"]);
});
