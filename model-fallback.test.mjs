import test from "node:test";
import assert from "node:assert/strict";
import { isModelRejection, spawnWithModelFallback } from "./model-fallback.mjs";

const MODEL = "claude-opus-5";
const FALLBACK = "claude-opus-4-8";
const rejected = { status: 1, stdout: "", stderr: `unknown model: ${MODEL}` };

test("success on the first attempt does not retry", () => {
  const calls = [];
  const result = spawnWithModelFallback((model) => { calls.push(model); return { status: 0, stdout: "ok" }; }, { model: MODEL, fallbackModel: FALLBACK });
  assert.deepEqual(calls, [MODEL]);
  assert.equal(result.modelUsed, MODEL);
  assert.equal(result.retried, false);
});

test("a model rejection retries once on the fallback", () => {
  const calls = [];
  const fallbackResult = { status: 0, stdout: "ok" };
  const result = spawnWithModelFallback((model) => { calls.push(model); return model === MODEL ? rejected : fallbackResult; }, { model: MODEL, fallbackModel: FALLBACK, log: () => {} });
  assert.deepEqual(calls, [MODEL, FALLBACK]);
  assert.equal(result.result, fallbackResult);
  assert.equal(result.modelUsed, FALLBACK);
  assert.equal(result.retried, true);
});

test("a generic failure that does not name the model does not retry", () => {
  const calls = [];
  const failure = { status: 1, stderr: "connection reset by peer" };
  const result = spawnWithModelFallback((model) => { calls.push(model); return failure; }, { model: MODEL, fallbackModel: FALLBACK });
  assert.deepEqual(calls, [MODEL]);
  assert.equal(result.result, failure);
  assert.equal(result.retried, false);
});

test("a rejection naming a different model does not retry", () => {
  const calls = [];
  const failure = { status: 1, stderr: "claude-opus-6 does not support --tools" };
  const result = spawnWithModelFallback((model) => { calls.push(model); return failure; }, { model: MODEL, fallbackModel: FALLBACK });
  assert.deepEqual(calls, [MODEL]);
  assert.equal(result.result, failure);
  assert.equal(result.retried, false);
});

test("a model id containing regex metacharacters is matched literally", () => {
  const literalModel = "claude-opus-5.0+beta";
  assert.equal(isModelRejection({ status: 1, stderr: `unknown model: ${literalModel}` }, literalModel), true);
  assert.equal(isModelRejection({ status: 1, stderr: "unknown model: claude-opus-5x000beta" }, literalModel), false);
});

test("a rate-limit failure does not retry", () => {
  const calls = [];
  const result = spawnWithModelFallback((model) => { calls.push(model); return { status: 1, stderr: `rate limit reached for ${MODEL}` }; }, { model: MODEL, fallbackModel: FALLBACK });
  assert.deepEqual(calls, [MODEL]);
  assert.equal(result.retried, false);
});

test("an identical fallback model does not retry", () => {
  const calls = [];
  const result = spawnWithModelFallback((model) => { calls.push(model); return rejected; }, { model: MODEL, fallbackModel: MODEL });
  assert.deepEqual(calls, [MODEL]);
  assert.equal(result.retried, false);
});

test("an absent fallback model does not retry", () => {
  const calls = [];
  const result = spawnWithModelFallback((model) => { calls.push(model); return rejected; }, { model: MODEL });
  assert.deepEqual(calls, [MODEL]);
  assert.equal(result.retried, false);
});

test("a failed fallback result is returned without a third attempt", () => {
  const calls = [];
  const failedFallback = { status: 1, stderr: `invalid model ${FALLBACK}` };
  const result = spawnWithModelFallback((model) => { calls.push(model); return model === MODEL ? rejected : failedFallback; }, { model: MODEL, fallbackModel: FALLBACK, log: () => {} });
  assert.deepEqual(calls, [MODEL, FALLBACK]);
  assert.equal(result.result, failedFallback);
  assert.equal(result.retried, true);
});

test("the detector rejects successful, empty, and spawn-error results", () => {
  assert.equal(isModelRejection(null, MODEL), false);
  assert.equal(isModelRejection({ status: 0 }, MODEL), false);
  assert.equal(isModelRejection({ status: 1, stdout: "", stderr: "" }, MODEL), false);
  assert.equal(isModelRejection({ status: 1, error: new Error("ENOENT"), stderr: `unknown model ${MODEL}` }, MODEL), false);
});

test("the detector fails closed when no attempted model is provided", () => {
  assert.equal(isModelRejection(rejected), false);
  assert.equal(isModelRejection(rejected, ""), false);
});
