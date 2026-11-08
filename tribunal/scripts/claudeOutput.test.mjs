import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { argsForLeg, runLeg, unwrapClaudeOutput, FABLE_PLAN_LIMIT_REPLY } from "./legRunner.mjs";
import { demotionWarnings, panelStatus } from "./run.mjs";
import { argvShapeHash } from "./isolationBinding.mjs";

const leg = { leg: "opus", id: "opus", runner: "claude-cli", envKeys: [] };
const findings = [{ title: "Missing ownership check", severity: "BLOCKER" }];
const envelope = { result: JSON.stringify({ findings }), modelUsage: { "claude-opus-5-5": {}, other: {} },
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 }, is_error: false };
function run(stdout, code = 0, stderr = "") {
  return runLeg(leg, "Review", { mkTemp: async () => ".", spawnFn: () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    setImmediate(() => { child.stdout.emit("data", stdout); child.stderr.emit("data", stderr); child.emit("close", code); });
    return child;
  } });
}

test("Claude JSON reports the first answering model, findings and token usage", async () => {
  const raw = JSON.stringify(envelope);
  assert.deepEqual(unwrapClaudeOutput(raw), { stdout: envelope.result, model: "claude-opus-5-5",
    usage: { tokensIn: 100, tokensOut: 20, tokensCached: 40 }, isError: false });
  const result = await run(raw);
  assert.equal(result.kind, "answered");
  assert.equal(result.model, "claude-opus-5-5");
  assert.deepEqual(result.findings, findings);
  assert.equal(result.raw, envelope.result);
  assert.equal(result.tokensIn, 100);
  assert.equal(result.tokensOut, 20);
  assert.equal(result.tokensCached, 40);
  assert.deepEqual(demotionWarnings([result], [leg]), []);
  assert.ok(panelStatus([{ ...result, effortShown: "max (set)" }]).includes("[panel] opus: claude-opus-5-5 · effort max (set)"));
});

test("wrapped plan-limit text stays not-run and wrapped crashes stay failed", async () => {
  const limit = JSON.stringify({ ...envelope, result: FABLE_PLAN_LIMIT_REPLY, is_error: true });
  for (const code of [0, 1]) assert.equal((await run(limit, code)).kind, "not-run");
  const trace = "Error: crash\n    at review (runner.js:12:3)";
  const crash = await run(JSON.stringify({ ...envelope, result: trace, is_error: true }), 1);
  assert.equal(crash.kind, "failed");
  assert.equal(crash.reason, "crashed");
  assert.equal((await run(limit, 1, trace)).reason, "crashed");
  assert.equal((await run(JSON.stringify({ ...envelope, is_error: true }))).kind, "failed");
});

test("non-envelope output is untouched; unknown models and usage stay absent", async () => {
  for (const stdout of [FABLE_PLAN_LIMIT_REPLY, envelope.result, "crash", "{", "null"]) {
    assert.deepEqual(unwrapClaudeOutput(stdout), { stdout, model: null, usage: null, isError: false });
  }
  assert.equal((await run(FABLE_PLAN_LIMIT_REPLY, 1)).kind, "not-run");
  assert.equal((await run(envelope.result)).model, "opus");
  const result = await run(JSON.stringify({ result: envelope.result }));
  assert.equal(result.model, "opus");
  assert.equal(result.tokensIn, null);
  assert.equal(result.tokensOut, null);
  assert.equal(result.tokensCached, null);
});

test("effort is sent only when explicitly set and Claude always requests JSON", () => {
  assert.ok(argsForLeg(leg).includes("--output-format"));
  assert.equal(argsForLeg(leg)[argsForLeg(leg).indexOf("--output-format") + 1], "json");
  assert.ok(!argsForLeg(leg).includes("--effort"));
  const claude = argsForLeg({ ...leg, effort: "max" });
  assert.equal(claude[claude.indexOf("--effort") + 1], "max");
  const codex = { runner: "codex-cli", id: "gpt-6-sol" };
  assert.ok(!argsForLeg(codex).includes("-c"));
  const args = argsForLeg({ ...codex, effort: "ultra" });
  assert.equal(args[args.indexOf("-c") + 1], 'model_reasoning_effort="ultra"');
  assert.equal(args.at(-1), "-");
  assert.equal(argvShapeHash(leg), argvShapeHash({ ...leg, id: "claude-opus-5-5" }));
});

test("the answering model is the one with the most output, not the first listed", () => {
  const out = JSON.stringify({ result: JSON.stringify({ findings }),
    modelUsage: { "claude-helper-small": { outputTokens: 12 }, "claude-opus-5-5": { outputTokens: 900 } } });
  assert.equal(unwrapClaudeOutput(out).model, "claude-opus-5-5");
});

test("a Claude alias seat is never reported as demoted, even if a fallback is configured", () => {
  assert.deepEqual(demotionWarnings([{ leg: "opus", kind: "answered", model: "claude-opus-5-5" }],
    [{ leg: "opus", id: "opus", runner: "claude-cli", fallback: "another-model" }]), []);
  assert.equal(demotionWarnings([{ leg: "gemini", kind: "answered", model: "gemini-b" }],
    [{ leg: "gemini", id: "gemini-a", runner: "genai-sdk", fallback: "gemini-b" }]).length, 1, "an SDK fallback still warns");
});
