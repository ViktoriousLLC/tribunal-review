// RED-FIRST mutation targets: omit the isolated transport; follow redirects or construct
// a proxy dispatcher; consult parent environment settings; omit default/row deadlines.
// All fetches below are in-memory stubs. This file grants no network access.
import test from "node:test";
import assert from "node:assert/strict";

const request = { endpoint: "https://compatible.invalid/v1/chat/completions", model: "fixture-model",
  content: "Review this fixture and return findings JSON.", keyName: "COMPATIBLE_API_KEY" };
const secret = "fixture-worker-key";

function timers(t) {
  const scheduled = [];
  const cleared = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const handle = { callback, delay };
    scheduled.push(handle);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => cleared.push(handle));
  return { scheduled, cleared };
}

test("worker transport mutation: one manual POST carries the model, user message and bearer key", async (t) => {
  const { requestCompletion } = await import("./openaiApiWorker.mjs");
  const calls = [];
  t.mock.method(globalThis, "fetch", async (endpoint, options) => {
    calls.push({ endpoint, options });
    return { status: 200, text: async () => "fixture response" };
  });
  const result = await requestCompletion(request, { [request.keyName]: secret });
  assert.deepEqual(result, { status: 200, body: "fixture response" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, request.endpoint);
  const options = calls[0].options;
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "manual");
  assert.equal(options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(options.body), { model: request.model,
    messages: [{ role: "user", content: request.content }] });
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok(!Object.hasOwn(options, "dispatcher"));
  assert.ok(!Object.hasOwn(options, "agent"));
});

test("worker environment mutation: transport reads only its declared key variable", async (t) => {
  const { requestCompletion } = await import("./openaiApiWorker.mjs");
  const reads = [];
  const source = new Proxy({}, { get(_target, name) {
    reads.push(name);
    assert.equal(name, request.keyName, "proxy, certificate, and other parent settings must not be consulted");
    return secret;
  } });
  t.mock.method(globalThis, "fetch", async () => ({ status: 200, text: async () => "ok" }));
  await requestCompletion(request, source);
  assert.deepEqual(reads, [request.keyName]);
});

test("worker status mutation: non-2xx statuses and bodies return without retries", async (t) => {
  const { requestCompletion } = await import("./openaiApiWorker.mjs");
  for (const status of [401, 500, 302]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_endpoint, options) => {
      calls++;
      assert.equal(options.redirect, "manual");
      return { status, text: async () => `response ${status}` };
    });
    assert.deepEqual(await requestCompletion(request, { [request.keyName]: secret }),
      { status, body: `response ${status}` });
    assert.equal(calls, 1);
  }
});

test("worker deadline mutation: default is 120 seconds, configured deadlines abort and are cleared", async (t) => {
  const { requestCompletion } = await import("./openaiApiWorker.mjs");
  const { scheduled, cleared } = timers(t);
  t.mock.method(globalThis, "fetch", async () => ({ status: 200, text: async () => "ok" }));
  await requestCompletion(request, { [request.keyName]: secret });
  assert.equal(scheduled[0].delay, 120000);
  assert.equal(cleared[0], scheduled[0]);
  t.mock.method(globalThis, "fetch", async (_endpoint, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("fixture aborted")), { once: true });
    scheduled.at(-1).callback();
  }));
  await assert.rejects(() => requestCompletion({ ...request, timeoutMs: 41 }, { [request.keyName]: secret }), /abort|timed out/i);
  assert.equal(scheduled[1].delay, 41);
  assert.equal(cleared[1], scheduled[1]);
});
