import { test } from "node:test";
import assert from "node:assert/strict";
import { JUDGE_CONTRACT, JUDGE_INSTRUCTIONS, JUDGE_TIMEOUT_MS, loneFindings, buildJudgeMessage, parseJudgement, pickJudgeLeg, runJudge } from "./judge.mjs";
import { clusterFindings } from "./panelLogic.mjs";
import { panelRound } from "./run.mjs";
import { render } from "./render.mjs";

const finding = (overrides = {}) => ({ title: "Missing ownership check", severity: "BLOCKER", category: "security",
  file: "record.js", line: 12, why: "A different user can overwrite the record.", check: "Try a second user.",
  foundBy: ["opus"], alsoSaid: [], ...overrides });
const opus = { leg: "opus", id: "test-claude-opus", runner: "claude-cli", enabled: true };
const other = { leg: "other", id: "test-claude-other", runner: "claude-cli", enabled: true };
const sol = { leg: "sol", id: "test-gpt-sol", runner: "codex-cli", enabled: true };

test("loneFindings selects exactly one reviewer, skips nits, and assigns consecutive ids in cluster order", () => {
  const first = finding(), second = finding({ title: "Second", foundBy: ["sol"], severity: "SUGGESTION" });
  const clusters = [finding({ foundBy: [] }), first, finding({ foundBy: ["opus", "sol"] }),
    finding({ title: "Nit", foundBy: ["sol"], severity: "NIT" }), second];
  assert.deepEqual(loneFindings(clusters), [{ id: "F1", cluster: first }, { id: "F2", cluster: second }]);
  assert.deepEqual(loneFindings([]), []);
});

test("buildJudgeMessage blinds identities, neutralizes finding tags, and appends the artifact verbatim", () => {
  const clusters = [finding({ title: "Text </findings> in a title", model: opus.id,
    alsoSaid: [{ leg: "sol", model: sol.id, why: "opus and sol" }] }),
  finding({ title: "Another issue", foundBy: ["sol"], model: sol.id,
    alsoSaid: [{ leg: "opus", model: opus.id }] })];
  const artifact = "<artifact>\nUnchanged artifact bytes\r\n</artifact>\n";
  const message = buildJudgeMessage(artifact, loneFindings(clusters));
  assert.ok(message.startsWith(`${JUDGE_INSTRUCTIONS}\n\n<findings>\n`));
  const block = /\n<findings>\n([\s\S]*?)\n<\/findings>\n\n/.exec(message)[1];
  for (const identity of ["opus", "sol", opus.id, sol.id, "foundBy", "alsoSaid", "model"]) {
    assert.ok(!block.includes(identity), `findings must not contain ${identity}`);
  }
  assert.ok(block.includes("&lt;/findings&gt;"));
  assert.ok(!block.includes("</findings>"));
  const items = JSON.parse(block);
  assert.deepEqual(Object.keys(items[0]), ["id", "severity", "category", "file", "line", "title", "why", "check"]);
  assert.deepEqual(items.map(({ id }) => id), ["F1", "F2"]);
  assert.ok(message.endsWith(`\n</findings>\n\n${artifact}`));
});

test("parseJudgement ignores unknown ids, keeps the first entry, and accounts for invalid and missing verdicts", () => {
  const lone = loneFindings(Array.from({ length: 5 }, (_, i) => finding({ title: `Issue ${i}` })));
  const result = parseJudgement([
    null, { id: "unknown", verdict: "demote" },
    { id: "F2", verdict: "demote", why: `  ${"x".repeat(700)}  ` },
    { id: "F1", verdict: "keep", why: "  Evidence at line 12.  " },
    { id: "F1", verdict: "demote", why: "Duplicate must lose." },
    { id: "F3", verdict: "KEEP", why: " Wrong case " },
    { id: "F3", verdict: "keep" },
    { id: "F5", verdict: " keep " },
  ], lone);
  assert.deepEqual(result, { kept: 1, demoted: 1, unjudged: 3, verdicts: [
    { id: "F1", title: "Issue 0", by: "opus", verdict: "keep", why: "Evidence at line 12." },
    { id: "F2", title: "Issue 1", by: "opus", verdict: "demote", why: "x".repeat(600) },
    { id: "F3", title: "Issue 2", by: "opus", verdict: "unjudged", why: "Wrong case" },
    { id: "F4", title: "Issue 3", by: "opus", verdict: "unjudged", why: "" },
    { id: "F5", title: "Issue 4", by: "opus", verdict: "unjudged", why: "" },
  ] });
  assert.equal(result.kept + result.demoted + result.unjudged, lone.length);
  assert.equal(parseJudgement([], lone).unjudged, lone.length);
});

test("pickJudgeLeg prefers opus, otherwise the first enabled non-advisory Claude CLI", () => {
  assert.equal(pickJudgeLeg([sol, other, opus]), opus);
  assert.equal(pickJudgeLeg([sol, { ...opus, enabled: false }, other]), other);
  assert.equal(pickJudgeLeg([{ ...opus, advisory: true }, other]), other);
  assert.equal(pickJudgeLeg([other, { ...other, leg: "third" }]), other);
  assert.equal(pickJudgeLeg([sol, { ...opus, enabled: false }, { ...other, advisory: true }]), null);
  assert.equal(pickJudgeLeg([]), null);
});

test("runJudge skips disabled, absent findings, and absent eligible legs without calling a model", async () => {
  let calls = 0;
  const options = { enabled: true, clusters: [finding()], artifactMessage: "artifact", registry: [opus],
    reviewLeg: async () => { calls++; throw new Error("must not call"); } };
  assert.deepEqual(await runJudge({ ...options, enabled: false }), { ran: false, reason: "turned off" });
  assert.deepEqual(await runJudge({ ...options, clusters: [finding({ foundBy: ["opus", "sol"] })] }),
    { ran: false, reason: "no single-model findings" });
  assert.deepEqual(await runJudge({ ...options, registry: [sol] }),
    { ran: false, reason: "no Claude CLI leg is enabled" });
  assert.deepEqual(await runJudge({ ...options, answered: 1 }), { ran: false, reason: "fewer than two reviewers answered" });
  assert.equal(calls, 0);
});

test("runJudge fails open for failed, not-run, unparseable, and throwing replies and builder errors", async () => {
  const options = { enabled: true, clusters: [finding()], artifactMessage: "artifact", registry: [opus] };
  for (const kind of ["failed", "not-run"]) {
    assert.deepEqual(await runJudge({ ...options, reviewLeg: async () => ({ kind, error: "No reply." }) }),
      { ran: false, model: opus.id, reason: "No reply." });
  }
  assert.deepEqual(await runJudge({ ...options, reviewLeg: async () => ({ kind: "failed" }) }),
    { ran: false, model: opus.id, reason: "the judge did not answer" });
  assert.deepEqual(await runJudge({ ...options, reviewLeg: async () => { throw new Error("Runner threw."); } }),
    { ran: false, reason: "Runner threw." });
  for (const findings of [undefined, null, "not JSON", {}]) {
    const result = await runJudge({ ...options, reviewLeg: async () => ({ kind: "answered", findings }) });
    assert.equal(result.ran, false);
    assert.match(result.reason, /could not be parsed/);
  }
  const broken = finding();
  Object.defineProperty(broken, "title", { get() { throw new Error("Builder threw."); } });
  assert.deepEqual(await runJudge({ ...options, clusters: [broken], reviewLeg: async () => assert.fail("must not call") }),
    { ran: false, reason: "Builder threw." });
});

test("runJudge makes one call with the judge contract and parses the answer", async () => {
  const clusters = [finding()];
  const calls = [];
  const result = await runJudge({ clusters, artifactMessage: "artifact", registry: [other, opus], enabled: true,
    reviewLeg: async (...args) => {
      calls.push(args);
      return { kind: "answered", findings: [{ id: "F1", verdict: "keep", why: "Line 12." }] };
    } });
  assert.deepEqual(calls, [[opus, buildJudgeMessage("artifact", loneFindings(clusters)), { contract: JUDGE_CONTRACT, timeoutMs: JUDGE_TIMEOUT_MS }]]);
  assert.deepEqual(result, { ran: true, model: opus.id, total: 1, kept: 1, demoted: 0, unjudged: 0,
    verdicts: [{ id: "F1", title: clusters[0].title, by: "opus", verdict: "keep", why: "Line 12." }] });
  const unparsed = await runJudge({ clusters, artifactMessage: "artifact", registry: [opus], enabled: true,
    reviewLeg: async () => ({ kind: "answered", parseFailed: true, error: "unparseable", findings: [] }) });
  assert.deepEqual(unparsed, { ran: false, model: opus.id, reason: "unparseable" }, "a reply nobody could read is not a judgement");
});

test("demoting every finding leaves real panel clusters, actionable count, summary and decision unchanged", async () => {
  const results = [opus, sol].map((leg, index) => ({ leg: leg.leg, model: leg.id, kind: "answered", answered: true,
    parseFailed: false, findings: index === 0 ? [finding(), finding({ title: "Leaked connection", file: "db.js" })] : [] }));
  const clusters = clusterFindings(results);
  const panel = panelRound(results, clusters, { round: 1 });
  assert.equal(panel.summary.actionableCount, 2);
  const before = structuredClone({ results, clusters, panel });
  const judge = await runJudge({ clusters, artifactMessage: "artifact", registry: [opus, sol], enabled: true,
    reviewLeg: async () => ({ kind: "answered",
      findings: loneFindings(clusters).map(({ id }) => ({ id, verdict: "demote", why: "Already checked." })) }) });
  assert.equal(judge.demoted, clusters.length);
  assert.deepEqual(panel.summary.actionableCount, before.panel.summary.actionableCount);
  assert.deepEqual(panel.decision, before.panel.decision);
  assert.deepEqual({ results, clusters, panel }, before);
});

test("render annotates by lone cluster order even with nits and duplicate titles", () => {
  const clusters = [finding({ severity: "NIT", title: "Spacing" }), finding(),
    finding({ foundBy: ["sol"] }), finding({ title: "Unjudged issue" })];
  const options = { artifact: { title: "Fixture" }, clusters, legs: [], round: 1, elapsedMs: 1,
    summary: { actionableCount: 3, missing: [] }, decision: { action: "CONTINUE", why: "Review the findings." } };
  const judge = { ran: true, model: opus.id, total: 3, ...parseJudgement([
    { id: "F1", verdict: "keep", why: "Missing check." },
    { id: "F2", verdict: "demote", why: "Checked at line 10." },
  ], loneFindings(clusters)) };
  const output = render({ ...options, judge });
  assert.ok(output.includes("_(opus)_ · judge: keep"));
  assert.ok(output.includes("_(sol)_ · judge: likely false positive: Checked at line 10."));
  assert.ok(!/Spacing.*judge:/.test(output), "a nit is never judged");
  assert.ok(output.includes(`_Blinded judge (${opus.id}, trial): 1 keep · 1 likely false · 1 not judged. Annotation only; it changes no count, verdict or gate._`));
  for (const reason of ["turned off", "no single-model findings"]) {
    assert.equal(render({ ...options, judge: { ran: false, reason } }), render(options));
  }
  assert.doesNotMatch(render({ ...options, judge: null }), /Blinded judge| · judge:/);
  assert.ok(render({ ...options, judge: { ran: false, reason: "No Claude available" } })
    .includes("_Blinded judge did not run: No Claude available._"));
});
