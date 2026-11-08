// RED-first mutation targets for convergence and admission behavior:
// t1: disable the unchanged-QUIET refusal condition.
// t2: disable the history.length >= 10 refusal condition.
// t3: treat a latest PARTIAL row as QUIET; separately allow an unreadable leg to be QUIET.
// t4: assign round = 1 instead of 1 + max runnerRound; separately accept --round.
// t5: ignore tribunal.config.json by assigning config = {}.
// t6: return no recurring findings instead of emitting titles seen in >=3 rows.
// t7: replace exclusive lock open mode "wx" with "w", admitting overlapping attempts.
// t8: return no stop-patching signals, or compare against any earlier round instead of the previous one.
// Like localProof.test, inject a capturing callback at the model-call boundary. Real CLI,
// artifact, policy, gate, ledger, rendering and exit-code behavior run in a child process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadRegistry } from "./registry.mjs";
import { argsForLeg } from "./legRunner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(process.env.TRIBUNAL_TEST_RUNNER || join(HERE, "run.mjs"));
const title = "Ownership check allows another user to overwrite a record";
const finding = { title, severity: "BLOCKER", category: "security", file: "record.js", foundBy: ["stub"] };
// A different spelling on the SAME mechanism, and a finding on a different one.
const sameFile = { title: "Escaped quote lets a second record id through the check", severity: "BLOCKER", category: "security", file: "./record.js:88", foundBy: ["stub"] };
const otherFile = { title: "Session cookie outlives logout", severity: "BLOCKER", category: "security", file: "session.js", foundBy: ["stub"] };
const hash = (text) => createHash("sha256").update(text).digest("hex");

function fixture(t, { modelsCache = { client_version: "0.163.0", models: loadRegistry()
  .filter((leg) => leg.runner === "codex-cli").map((leg) => ({ slug: leg.id, default_reasoning_level: "low" })) },
  codexVersion = "0.163.0", actualClaudeModel = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tribunal-conversion-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const ledger = join(root, "ledger");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(ledger);
  const file = join(repo, "goal.md");
  writeFileSync(file, "A testable goal.");
  const config = { ledgerHome: ledger };
  writeFileSync(join(repo, "tribunal.config.json"), JSON.stringify(config));
  const cliLegs = [...new Map(loadRegistry()
    .filter((leg) => leg.enabled && ["claude-cli", "codex-cli"].includes(leg.runner))
    .map((leg) => [leg.runner, leg])).values()];
  const executables = Object.fromEntries(cliLegs.map((leg) => [leg.runner.replace(/-cli$/, ""),
    join(root, leg.runner.replace(/-cli$/, ""))]));
  const probeOptions = `{ resolveExecutable: (cmd) => ({ file: ${JSON.stringify(executables)}[cmd], prefix: [], found: true }),
    spawnVersion: () => ({ status: 0, stdout: "fixture-cli 1.0\\n", stderr: "" }) }`;
  const probeRecord = {
    schemaVersion: 1,
    probeVersion: JSON.parse(readFileSync(join(HERE, "..", ".claude-plugin", "plugin.json"), "utf8")).version,
    measuredAt: new Date().toISOString(),
    enabledCliRunners: cliLegs.map((leg) => leg.runner),
    cli: Object.fromEntries(cliLegs.map((leg) => [leg.runner, {
      executablePath: executables[leg.runner.replace(/-cli$/, "")], executablePrefix: [],
      version: "fixture-cli 1.0", argvShapeHash: hash(JSON.stringify(argsForLeg({ ...leg, id: "" }))),
      verdict: "PASS", why: "control leaked; guarded did not",
    }])),
    overall: { ok: true, verdict: "PASS", why: "every probed leg refused the injected read while its control leaked" },
  };
  writeFileSync(join(ledger, "isolation-probe.md"), `OVERALL: PASS\n\n\`\`\`json\n${JSON.stringify(probeRecord, null, 2)}\n\`\`\`\n`);
  const wrapper = join(root, "invoke.mjs");
  writeFileSync(wrapper, `import { main } from ${JSON.stringify(pathToFileURL(RUNNER).href)};
    await main({ probeOptions: ${probeOptions}, policyOptions: ${probeOptions}, modelOptions: {
      spawnSyncFn: () => ({ status: 0, stdout: ${JSON.stringify(`codex-cli ${codexVersion}`)} }),
      readFile: () => ${JSON.stringify(JSON.stringify(modelsCache))},
    }, reviewLeg: async (leg, message, options) => {
      const model = leg.runner === "claude-cli" ? ${JSON.stringify(actualClaudeModel)} || leg.id : leg.id;
      if (options?.contract) return { kind: "answered", model, findings: [{ id: "F1", verdict: "demote", why: "Already handled in the artifact." }] };
      const partial = process.env.TRIBUNAL_STUB === "partial";
      return { leg: leg.leg, model, kind: "answered", answered: true,
        parseFailed: partial, error: partial ? "unparseable test response" : null,
        raw: "stub", findings: process.env.TRIBUNAL_STUB === "finding"
          || (process.env.TRIBUNAL_STUB === "lone" && leg.leg === "opus") ? [${JSON.stringify(finding)}]
          : process.env.TRIBUNAL_STUB === "other-file" ? [${JSON.stringify(otherFile)}] : [] };
    }});`);
  const invoke = (args = [], mode = "quiet", cli = false) => spawnSync(process.execPath,
    [cli ? RUNNER : wrapper, ...args], { cwd: repo, encoding: "utf8", timeout: 15000,
      env: { ...process.env, TRIBUNAL_STUB: mode } });
  const rows = () => readdirSync(ledger).filter((name) => name.endsWith(".ndjson")).sort()
    .flatMap((name) => readFileSync(join(ledger, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
  const seed = (round, { month = "2026-01", reason = "ACTIONABLE", contentHash = hash("A testable goal."), findings = [], kind = "document" } = {}) => {
    const record = { artifact: { kind, source: file }, runnerRound: round, round,
      contentHash, decision: { action: reason === "ACTIONABLE" ? "CONTINUE" : "STOP", reason },
      actionableFindings: findings, actionable: findings.length, legs: [] };
    writeFileSync(join(ledger, `${month}.ndjson`), JSON.stringify(record) + "\n", { flag: "a" });
  };
  return { root, repo, ledger, file, config, invoke, rows, seed, probeOptions };
}

test("resolved models and effort reach reviews, judge, status, footer and ledger", (t) => {
  const f = fixture(t, { actualClaudeModel: "claude-opus-5-5", modelsCache: {
    client_version: "0.163.0", models: [
      { slug: "gpt-6.1-sol", default_reasoning_level: "low" },
      { slug: "gpt-6-astra", default_reasoning_level: "medium" },
    ],
  } });
  const registry = loadRegistry();
  registry.find((leg) => leg.leg === "astra").effort = "high";
  writeFileSync(join(f.repo, "models.json"), JSON.stringify({ legs: registry }));
  writeFileSync(join(f.repo, "tribunal.config.json"), JSON.stringify({ ...f.config, modelsFile: "models.json" }));
  const result = f.invoke(["--file", f.file, "--json"], "lone");
  assert.equal(result.status, 1, result.stderr);
  const row = f.rows().at(-1);
  assert.deepEqual(row.legs.map(({ leg, model, effort }) => ({ leg, model, effort })), [
    { leg: "opus", model: "claude-opus-5-5", effort: "medium (model default)" },
    { leg: "sol", model: "gpt-6.1-sol", effort: "low (model default)" },
    { leg: "astra", model: "gpt-6-astra", effort: "high (set)" },
  ]);
  assert.equal(row.judge.model, "claude-opus-5-5");
  assert.equal(row.judge.ran, true);
  assert.doesNotMatch(result.stderr, /DEMOTED/);
  for (const entry of row.legs) {
    assert.ok(result.stderr.includes(`[panel] ${entry.leg}: ${entry.model} · effort ${entry.effort}`));
  }
  const human = f.invoke(["--file", f.file], "lone");
  assert.equal(human.status, 1, human.stderr);
  for (const entry of row.legs) {
    assert.ok(human.stdout.includes(`${entry.leg} (${entry.model}, effort ${entry.effort})`));
  }
});

test("an older Codex runs and banks the pinned model and prints the upgrade notice", (t) => {
  const f = fixture(t, { codexVersion: "0.157.1", modelsCache: { client_version: "0.163.0", models: [
    { slug: "gpt-6-sol", default_reasoning_level: "low" },
    { slug: "gpt-5.6-sol", default_reasoning_level: "medium" },
    { slug: "gpt-6-astra", default_reasoning_level: "low" },
  ] } });
  const result = f.invoke(["--file", f.file, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[models\] sol: Codex CLI 0\.157\.1 is older/);
  const sol = f.rows().at(-1).legs.find((leg) => leg.leg === "sol");
  assert.equal(sol.model, "gpt-5.6-sol");
  assert.equal(sol.effort, "medium (model default)");
});

test("blinded judge banks annotations without changing actionable findings, decision or exit code", (t) => {
  const f = fixture(t);
  const legs = loadRegistry().filter((leg) => ["opus", "sol"].includes(leg.leg))
    .map((leg) => ({ ...leg, enabled: true, envKeys: [], requiredEnv: [] }));
  assert.equal(legs.length, 2);
  writeFileSync(join(f.repo, "models.json"), JSON.stringify({ legs }));
  const config = { ...f.config, modelsFile: "models.json" };
  writeFileSync(join(f.repo, "tribunal.config.json"), JSON.stringify(config));
  const plain = f.invoke(["--file", f.file, "--json", "--no-judge"], "lone");
  assert.equal(plain.status, 1, plain.stderr);
  const baseline = JSON.parse(plain.stdout);
  assert.equal(baseline.record.actionable, 1);
  assert.deepEqual(baseline.record.judge, { ran: false, model: null, reason: "turned off" });
  assert.doesNotMatch(plain.stderr, /\[judge\]/);

  const judged = f.invoke(["--file", f.file, "--json"], "lone");
  assert.equal(judged.status, plain.status, judged.stderr);
  const output = JSON.parse(judged.stdout);
  const row = f.rows().at(-1);
  assert.equal(row.legs.length, 2, "the judge is never a counted reviewer");
  assert.deepEqual(row.judge, { ran: true, model: legs.find((leg) => leg.leg === "opus").id,
    reason: null, total: 1, kept: 0, demoted: 1, unjudged: 0, verdicts: [{ id: "F1", title, by: "opus", verdict: "demote", why: "Already handled in the artifact." }] });
  assert.equal(row.actionable, baseline.record.actionable);
  // Omitting the banked list breaks this join even if the displayed judge is correct.
  assert.equal(row.findingList.length, row.clusters);
  assert.equal(row.findingList[0].judgeId, row.judge.verdicts[0].id);
  assert.equal(row.findingList[0].title, row.judge.verdicts[0].title);
  assert.match(judged.stderr, /\[scorecard\].*so far: 2 findings, 1 unique problems, 0 of 1 marked/);
  assert.deepEqual(row.decision, baseline.record.decision);
  assert.deepEqual(row.actionableFindings, baseline.record.actionableFindings);
  assert.deepEqual(output.clusters, baseline.clusters);
  assert.deepEqual(output.summary, baseline.summary);
  // The human explanation names the next round, which advances between these runs.
  assert.deepEqual({ action: output.decision.action, reason: output.decision.reason }, baseline.record.decision);
  assert.equal(output.judge.verdicts[0].why, "Already handled in the artifact.");
  assert.match(judged.stderr, /\[judge\] .*: 0 keep, 1 demote, 0 not judged of 1 single-model finding\(s\)/);

  writeFileSync(join(f.repo, "tribunal.config.json"), JSON.stringify({ ...config, judge: false }));
  const disabled = f.invoke(["--file", f.file, "--json"], "lone");
  assert.equal(disabled.status, plain.status, disabled.stderr);
  assert.deepEqual(f.rows().at(-1).judge, baseline.record.judge);
});

test("t1 quiet unchanged refuses; override runs and banks its reason", (t) => {
  const f = fixture(t);
  const first = f.invoke(["--file", f.file, "--json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(f.rows()[0].contentHash, hash("A testable goal."));
  const refused = f.invoke(["--file", f.file]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /already quiet on unchanged content/);
  assert.equal(refused.stderr.trim().split(/\r?\n/).length, 1);
  assert.equal(f.rows().length, 1, "refusal makes no model attempt and adds no row");
  const overridden = f.invoke(["--file", f.file, "--override", "Audit after a reviewer update", "--json"]);
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(f.rows().at(-1).override, "Audit after a reviewer update");
  assert.equal(f.rows().at(-1).runnerRound, 2);
  writeFileSync(f.file, "A changed, testable goal.");
  assert.equal(f.invoke(["--file", f.file]).status, 0, "changed content resumes normally");
});

test("t2 the eleventh row refuses even when its content changes", (t) => {
  const f = fixture(t);
  for (let round = 1; round <= 10; round++) f.seed(round, { month: round <= 5 ? "2025-12" : "2026-01" });
  writeFileSync(f.file, "Changed after ten attempts.");
  const refused = f.invoke(["--file", f.file]);
  assert.equal(refused.status, 3, refused.stderr);
  assert.match(refused.stderr, /10 or more recorded rows/);
  assert.equal(refused.stderr.trim().split(/\r?\n/).length, 1);
  assert.equal(f.rows().length, 10);
  assert.equal(f.invoke(["--file", f.file, "--override", "Investigate the remaining blocker"]).status, 0);
  assert.equal(f.rows().at(-1).runnerRound, 11);
  assert.equal(f.rows().at(-1).override, "Investigate the remaining blocker");
});

test("t3 PARTIAL unchanged never refuses as quiet or gets banked as QUIET", (t) => {
  const f = fixture(t);
  f.seed(1, { reason: "QUIET" });
  f.seed(2, { reason: "PARTIAL" });
  const result = f.invoke(["--file", f.file, "--json"], "partial");
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.record.decision.reason, "PARTIAL");
  assert.equal(output.summary.quiet, false);
  assert.equal(output.summary.complete, false);
  assert.equal(f.rows().at(-1).decision.reason, "PARTIAL");
  assert.equal(f.rows().length, 3, "latest PARTIAL wins over an older same-hash QUIET");
  assert.equal(f.invoke(["--file", f.file]).status, 0, "a repaired leg may finish the loop");
});

test("t4 runnerRound is monotonic across months and caller --round is refused", (t) => {
  const f = fixture(t);
  f.seed(9, { month: "2025-12" });
  f.seed(4, { month: "2026-01" });
  f.seed(99, { kind: "other" });
  const result = f.invoke(["--file", f.file, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).record.runnerRound, 10);
  for (const args of [["--round", "1"], ["--round=1"]]) {
    const refused = f.invoke(args, "quiet", true);
    assert.equal(refused.status, 4, refused.stderr);
    assert.match(refused.stderr, /runnerRound/);
    assert.equal(refused.stderr.trim().split(/\r?\n/).length, 1);
  }
});

test("t5 --print-policy resolves independent repo paths and enabled leg overrides", (t) => {
  const a = fixture(t), b = fixture(t);
  for (const f of [a, b]) {
    writeFileSync(join(f.repo, "models.json"), JSON.stringify({ legs: [
      { leg: "stub", id: "fake", vendor: "openai", runner: "codex-cli", billing: "plan", envKeys: [], enabled: false },
    ] }));
    writeFileSync(join(f.repo, "reviewer.md"), "Review only this repository's invariants.");
    writeFileSync(join(f.repo, "tribunal.config.json"), JSON.stringify({ ...f.config,
      modelsFile: "models.json", reviewerPromptPath: "reviewer.md", enabledLegs: ["stub"] }));
  }
  const policies = [a, b].map((f) => {
    const output = f.invoke(["--print-policy"], "quiet", true);
    assert.equal(output.status, 0, output.stderr);
    const policy = JSON.parse(output.stdout);
    assert.equal(policy.repoRoot, f.repo);
    assert.equal(policy.modelsFile, join(f.repo, "models.json"));
    assert.equal(policy.reviewerPromptPath, join(f.repo, "reviewer.md"));
    assert.equal(policy.ledgerHome, f.ledger);
    assert.equal(policy.probeRecord, join(f.ledger, "isolation-probe.md"));
    assert.equal(policy.registry[0].enabled, true);
    assert.equal(f.rows().length, 0, "printing policy invokes no panel and banks nothing");
    return policy;
  });
  for (const key of ["reviewerPromptPath", "modelsFile", "ledgerHome"]) assert.notEqual(policies[0][key], policies[1][key]);
});

test("t6 recurrence signal includes exact title and rounds in JSON and human output", (t) => {
  const f = fixture(t);
  f.seed(1, { findings: [finding, finding] });
  f.seed(2, { findings: [{ ...finding, title: title.toLowerCase() }] });
  assert.deepEqual(JSON.parse(f.invoke(["--file", f.file, "--json"], "finding").stdout).recurrence, [], "duplicates in one row and case changes do not count");
  const json = f.invoke(["--file", f.file, "--json"], "finding");
  assert.equal(json.status, 1, json.stderr);
  assert.match(JSON.parse(json.stdout).recurrenceSignal, /RECURRING FINDING \(channel signal\)/);
  assert.match(JSON.parse(json.stdout).recurrenceSignal, /Rounds: 1, 3, 4/);
  assert.deepEqual(JSON.parse(json.stdout).recurrence, [
    { channel: "signal", label: "RECURRING FINDING", title, rounds: [1, 3, 4] },
  ]);
  const human = f.invoke(["--file", f.file], "finding");
  assert.equal(human.status, 1, human.stderr);
  assert.match(human.stdout, /RECURRING FINDING \(channel signal\)/);
  assert.ok(human.stdout.includes(title));
  assert.match(human.stdout, /Rounds: 1, 3, 4, 5/);
});

test("t7 concurrent attempts cannot duplicate runnerRound or bypass the ten-row ceiling", { timeout: 20000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const f = fixture(t);
  for (let round = 1; round <= 9; round++) f.seed(round);
  const wrapper = join(f.root, "concurrent-invoke.mjs");
  writeFileSync(wrapper, `import { main } from ${JSON.stringify(pathToFileURL(RUNNER).href)};
    const released = new Promise((resolve) => process.once("message", resolve));
    let announced = false;
    await main({ probeOptions: ${f.probeOptions}, policyOptions: ${f.probeOptions}, reviewLeg: async (leg) => {
      if (!announced) { announced = true; process.send("reviewing"); }
      await released;
      return { leg: leg.leg, model: leg.id, kind: "answered", answered: true,
        parseFailed: false, error: null, raw: "stub", findings: [${JSON.stringify(finding)}] };
    }});
    if (process.connected) process.disconnect();`);
  const first = spawn(process.execPath, [wrapper, "--file", f.file, "--json"], {
    cwd: f.repo, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  first.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  first.stdout.resume();
  const finished = once(first, "close");
  try {
    const [ready] = await once(first, "message", { signal: AbortSignal.timeout(15000) });
    assert.equal(ready, "reviewing", "the first process has reached the model boundary while holding admission");
    assert.equal(f.rows().length, 9, "the first process has not banked yet");
    const concurrent = f.invoke(["--file", f.file]);
    assert.equal(concurrent.status, 6, concurrent.stderr);
    assert.match(concurrent.stderr, /another attempt holds this artifact lock/);
    assert.equal(f.rows().length, 9, "a refused overlapping attempt adds no row");
    first.send("release");
    const [code] = await finished;
    assert.equal(code, 1, stderr);
    assert.deepEqual(f.rows().map((row) => row.runnerRound), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok(!readdirSync(f.ledger).some((name) => name.endsWith(".lock")), "the completed attempt releases admission");
    const ceiling = f.invoke(["--file", f.file]);
    assert.equal(ceiling.status, 3, ceiling.stderr);
    assert.equal(f.rows().length, 10, "a later attempt cannot bypass the ceiling either");
    const overridden = f.invoke(["--file", f.file, "--override", "Investigate after the overlapping attempt"], "finding");
    assert.equal(overridden.status, 1, overridden.stderr);
    assert.equal(f.rows().at(-1).runnerRound, 11);
    assert.equal(f.rows().at(-1).override, "Investigate after the overlapping attempt");
  } finally {
    if (first.exitCode === null && first.signalCode === null) first.kill();
    await finished;
  }
});

test("t8 STOP PATCHING prints when two consecutive rounds hit one mechanism, and changes no verdict", (t) => {
  const f = fixture(t);
  f.seed(1, { findings: [sameFile] });
  const json = f.invoke(["--file", f.file, "--json"], "finding");
  assert.equal(json.status, 1, json.stderr);
  const output = JSON.parse(json.stdout);
  assert.deepEqual(output.stopPatching.map(({ label, mechanism, rounds }) => ({ label, mechanism, rounds })),
    [{ label: "STOP PATCHING", mechanism: "record.js", rounds: [1, 2] }]);
  assert.match(output.stopPatchingSignal, /^STOP PATCHING: record\.js/);
  assert.ok(output.stopPatchingSignal.includes(sameFile.title) && output.stopPatchingSignal.includes(title));
  assert.match(output.stopPatchingSignal, /Cut it: revert/);
  assert.match(output.stopPatchingSignal, /only if the redesign REMOVES machinery/);
  assert.match(output.stopPatchingSignal, /off by default/);
  // Advice only: the banked decision is the ordinary one and the exit code is the ordinary 1.
  assert.deepEqual(output.record.decision, { action: "CONTINUE", reason: "ACTIONABLE" });
  assert.deepEqual(f.rows().at(-1).stopPatching, [{ mechanism: "record.js", rounds: [1, 2] }]);
  const human = f.invoke(["--file", f.file], "finding");
  assert.equal(human.status, 1, human.stderr);
  assert.match(human.stdout, /^STOP PATCHING: record\.js$/m);
  assert.match(human.stdout, /Rounds 2 and 3 both drew actionable findings/);
  assert.match(human.stdout, /\*\*Next:\*\* STOP PATCHING — `record\.js` drew actionable findings in rounds 2 and 3\./);
  assert.match(human.stdout, /Verdict unchanged: CONTINUE\/ACTIONABLE/);
  assert.doesNotMatch(human.stdout, /\*\*Next:\*\* CONTINUE/);
});

test("t8 different mechanisms, one round, or a gap between rounds print no STOP PATCHING", (t) => {
  const f = fixture(t);
  const first = JSON.parse(f.invoke(["--file", f.file, "--json"], "finding").stdout);
  assert.deepEqual(first.stopPatching, [], "one round has nothing to compare against");
  assert.equal(first.stopPatchingSignal, null);
  const other = f.invoke(["--file", f.file], "other-file");
  assert.equal(other.status, 1, other.stderr);
  assert.doesNotMatch(other.stdout, /STOP PATCHING/, "record.js then session.js are two mechanisms");
  assert.match(other.stdout, /\*\*Next:\*\* CONTINUE/);
  assert.deepEqual(f.rows().at(-1).stopPatching, []);
  assert.equal(f.invoke(["--file", f.file], "quiet").status, 0);
  writeFileSync(f.file, "A changed, testable goal.");
  const afterGap = JSON.parse(f.invoke(["--file", f.file, "--json"], "other-file").stdout);
  assert.equal(afterGap.record.runnerRound, 4, "the comparison really spans a gap");
  assert.deepEqual(afterGap.stopPatching, [], "session.js in rounds 2 and 4 is not two rounds running");
});
