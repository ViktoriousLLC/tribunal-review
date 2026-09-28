// RED-FIRST mutation targets: omit openai-api dispatch; read a key before trust; authorize
// only by host; follow redirects; inherit proxy/CA settings; swallow HTTP status/body;
// drop usage or cache counts; price unknown usage as zero; ignore timeout/tier pins.
// Trust checks must bind scheme, host and port, enforce HTTPS except literal loopback, and
// reject absent authorization before reading credentials. Worker isolation requires exactly
// one child carrying only its declared key; unknown costs and API deadlines stay distinct
// from zero-cost or CLI defaults.
// The real loopback server belongs ONLY to this suite. noTelemetry keeps socket denial.
import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import http from "node:http";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import * as runner from "./legRunner.mjs";

const KEY = "COMPATIBLE_API_KEY";
const SECRET = "fixture-key-never-a-real-credential";
const nativeFetch = globalThis.fetch;
const nativeSpawn = childProcess.spawn;
const reply = (usage = { prompt_tokens: 1000, completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 250 } }) => ({
  choices: [{ message: { role: "assistant", content: '{"findings":[]}' } }], usage,
});
const row = (baseUrl, extra = {}) => ({
  leg: "compatible", id: "fake-model", vendor: "fixture", runner: "openai-api",
  baseUrl, billing: "metered", envKeys: [KEY], requiredEnv: [KEY], enabled: true,
  pricesUSDPer1M: { "fake-model": { in: 2, out: 10 } }, ...extra,
});

function homeFixture(t) {
  const root = mkdtempSync(join(os.tmpdir(), "tribunal-openai-api-"));
  const original = { env: process.env, argv: process.argv, cwd: process.cwd(), exitCode: process.exitCode };
  t.mock.method(os, "homedir", () => root);
  syncBuiltinESMExports();
  process.env = { ...original.env, HOME: root, USERPROFILE: root, [KEY]: SECRET };
  t.after(() => {
    process.env = original.env;
    process.argv = original.argv;
    process.chdir(original.cwd);
    process.exitCode = original.exitCode;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.ok(resolve(root).startsWith(resolve(os.tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const trustPath = join(root, ".tribunal", "trust.json");
  mkdirSync(join(root, ".tribunal"));
  return { root, trustPath, trust: (...bindings) => writeFileSync(trustPath, JSON.stringify({ bindings })) };
}

async function fakeServer(t, respond = (_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(reply()));
}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    respond(request, response);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => new Promise((resolveClose) => {
    server.closeAllConnections();
    server.close(resolveClose);
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchOptions = [];
  const workers = [];
  t.mock.method(childProcess, "spawn", (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.equal(args.length, 1, "the worker inherits no parent Node startup flags");
    assert.match(args[0], /openaiApiWorker\.mjs$/);
    assert.ok(!args.join(" ").includes(SECRET));
    workers.push({ args, options });
    return nativeSpawn(executable, args, options);
  });
  syncBuiltinESMExports();
  t.mock.method(globalThis, "fetch", (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.origin, origin, "the fixture permits only its own loopback server");
    fetchOptions.push(options);
    return nativeFetch(input, options);
  });
  return { origin, baseUrl: `${origin}/v1`, requests, fetchOptions, workers };
}

async function runAPI(leg, options = {}) {
  assert.equal(typeof runner.runOpenAIAPILeg, "function", "openai-api must have a dedicated runner");
  return runner.runOpenAIAPILeg(leg, "Review the fixture artifact.", { sourceEnv: { [KEY]: SECRET }, ...options });
}

test("dispatch/pricing mutations: full API rounds bank measured cost and render missing pins loudly", async (t) => {
  const f = homeFixture(t);
  const fake = await fakeServer(t);
  f.trust({ env: KEY, origin: fake.origin });
  mkdirSync(join(f.root, ".git"));
  mkdirSync(join(f.root, "ledger"));
  writeFileSync(join(f.root, "models.json"), JSON.stringify({ legs: [row(fake.baseUrl)] }));
  writeFileSync(join(f.root, "tribunal.config.json"), JSON.stringify({ modelsFile: "models.json", ledgerHome: "ledger" }));
  writeFileSync(join(f.root, "artifact.md"), "An offline compatible API review fixture.");
  const probe = { schemaVersion: 1, probeVersion: "fixture", measuredAt: new Date().toISOString(),
    enabledCliRunners: [], cli: {}, overall: { ok: true, verdict: "NO-AGENT-BOUNDARY" } };
  writeFileSync(join(f.root, "ledger", "isolation-probe.md"), `\`\`\`json\n${JSON.stringify(probe)}\n\`\`\`\n`);
  process.chdir(f.root);
  process.argv = [process.execPath, "fixture", "--file", join(f.root, "artifact.md"), "--json"];
  const outputs = [];
  t.mock.method(console, "log", (value) => outputs.push(value));
  t.mock.method(console, "error", () => {});
  const { main } = await import("./run.mjs");
  await main();
  assert.equal(process.exitCode, 0);
  const output = JSON.parse(outputs.at(-1));
  assert.equal(output.record.legs[0].kind, "answered");
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/chat/completions");
  assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
  const body = JSON.parse(request.body);
  assert.equal(body.model, "fake-model");
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.match(body.messages[0].content, /offline compatible API review fixture/);
  assert.ok(body.messages[0].content.includes(runner.FINDING_CONTRACT));
  const bankFiles = readdirSync(join(f.root, "ledger")).filter((name) => name.endsWith(".ndjson"));
  assert.equal(bankFiles.length, 1);
  const bank = JSON.parse(readFileSync(join(f.root, "ledger", bankFiles[0]), "utf8").trim());
  const metered = bank.metered.rows[0];
  assert.equal(metered.tokensIn, 1000);
  assert.equal(metered.tokensOut, 100);
  assert.equal(metered.tokensCached, 250);
  assert.equal(metered.usd, 0.003);
  assert.equal(bank.metered.totalUsd, 0.003);
  assert.ok(!JSON.stringify(bank).includes(SECRET), "the ledger never contains credentials");
  writeFileSync(join(f.root, "models.json"), JSON.stringify({ legs: [row(fake.baseUrl, { pricesUSDPer1M: {} })] }));
  process.argv = [process.execPath, "fixture", "--file", join(f.root, "artifact.md"), "--override", "Verify an unpriced round"];
  await main();
  assert.equal(process.exitCode, 0);
  assert.match(outputs.at(-1), /compatible cost is unknown/);
  assert.match(outputs.at(-1), /not reported/);
  const unpricedBank = JSON.parse(readFileSync(join(f.root, "ledger", bankFiles[0]), "utf8").trim().split("\n").at(-1));
  assert.equal(unpricedBank.metered.rows[0].usd, null);
  assert.equal(unpricedBank.metered.rows[0].tokensIn, 1000);
  assert.equal(fake.requests.length, 2, "each round performs exactly one request");
});

test("trust-order mutation: refusal reads neither the secret nor parent settings, and explains the exact binding", async (t) => {
  const f = homeFixture(t);
  const { openaiApiEnvironment } = await import("./openaiApi.mjs");
  const accesses = [];
  const source = new Proxy({}, { get(_target, key) { accesses.push(key); throw new Error("secret read before authorization"); } });
  const leg = row("https://compatible.example.invalid/v1");
  const result = openaiApiEnvironment(leg, source);
  assert.deepEqual(accesses, []);
  assert.deepEqual(result.env, {});
  assert.match(result.refusal, /COMPATIBLE_API_KEY/);
  assert.match(result.refusal, /https:\/\/compatible\.example\.invalid/);
  assert.ok(result.refusal.includes(JSON.stringify({ env: KEY, origin: "https://compatible.example.invalid" })));
  assert.ok(result.refusal.includes(f.trustPath));
  assert.match(result.refusal, /stop and think/i);
  assert.match(result.refusal, /copied config/i);
  assert.match(result.refusal, /stolen|steal/i);
  assert.doesNotMatch(result.refusal, /add this line/i);
  t.mock.method(globalThis, "fetch", () => assert.fail("an unauthorized leg made a request"));
  const refused = await runAPI(leg, { sourceEnv: source });
  assert.equal(refused.kind, "not-run");
  assert.equal(refused.answered, false);
  assert.deepEqual(accesses, []);
});

test("admission mutation: a full untrusted round banks the named refusal without reading the credential", async (t) => {
  const f = homeFixture(t);
  const leg = row("https://compatible.example.invalid/v1");
  mkdirSync(join(f.root, ".git"));
  mkdirSync(join(f.root, "ledger"));
  writeFileSync(join(f.root, "models.json"), JSON.stringify({ legs: [leg] }));
  writeFileSync(join(f.root, "tribunal.config.json"), JSON.stringify({ modelsFile: "models.json", ledgerHome: "ledger" }));
  writeFileSync(join(f.root, "artifact.md"), "An untrusted API review fixture.");
  const probe = { schemaVersion: 1, probeVersion: "fixture", measuredAt: new Date().toISOString(),
    enabledCliRunners: [], cli: {}, overall: { ok: true, verdict: "NO-AGENT-BOUNDARY" } };
  writeFileSync(join(f.root, "ledger", "isolation-probe.md"), `\`\`\`json\n${JSON.stringify(probe)}\n\`\`\`\n`);
  process.chdir(f.root);
  process.argv = [process.execPath, "fixture", "--file", join(f.root, "artifact.md"), "--json"];
  let reads = 0;
  process.env = new Proxy(process.env, { get(target, key, receiver) {
    if (key === KEY) { reads++; throw new Error("admission read an unauthorized credential"); }
    return Reflect.get(target, key, receiver);
  } });
  t.mock.method(globalThis, "fetch", () => assert.fail("an untrusted round made a request"));
  const outputs = [];
  t.mock.method(console, "log", (value) => outputs.push(value));
  t.mock.method(console, "error", () => {});
  const { main } = await import("./run.mjs");
  await main();
  assert.equal(reads, 0);
  assert.equal(process.exitCode, 1);
  const output = JSON.parse(outputs.at(-1));
  assert.equal(output.record.legs[0].leg, "compatible");
  assert.equal(output.record.legs[0].kind, "not-run");
  assert.match(output.record.notRun.join("\n"), /stop and think/);
  assert.match(output.record.notRun.join("\n"), /COMPATIBLE_API_KEY/);
  const bankFile = readdirSync(join(f.root, "ledger")).find((name) => name.endsWith(".ndjson"));
  const bank = JSON.parse(readFileSync(join(f.root, "ledger", bankFile), "utf8").trim());
  assert.equal(bank.legs[0].kind, "not-run");
  assert.equal(bank.metered.rows[0].usd, null);
  assert.ok(!JSON.stringify(bank).includes(SECRET));
});

test("origin mutation: bindings match variable, scheme and port, while URL path is irrelevant", async (t) => {
  const f = homeFixture(t);
  const { openaiApiEnvironment } = await import("./openaiApi.mjs");
  f.trust({ env: KEY, origin: "https://compatible.example.invalid:8443" });
  let reads = 0;
  const source = { get [KEY]() { reads++; return SECRET; }, get OTHER_API_KEY() { reads++; return SECRET; } };
  for (const leg of [row("https://compatible.example.invalid/v1"),
    row("http://compatible.example.invalid:8443/v1"),
    row("https://compatible.example.invalid:8443/v1", { envKeys: ["OTHER_API_KEY"], requiredEnv: ["OTHER_API_KEY"] })]) {
    assert.ok(openaiApiEnvironment(leg, source).refusal);
  }
  assert.equal(reads, 0);
  const allowed = openaiApiEnvironment(row("https://compatible.example.invalid:8443/other/prefix"), source);
  assert.ok(!allowed.refusal);
  assert.deepEqual(allowed.env, { [KEY]: SECRET });
  assert.ok(reads > 0);
});

test("scheme mutation: remote HTTP is refused before key access and loopback HTTP is permitted", async (t) => {
  const f = homeFixture(t);
  const { openaiApiEnvironment } = await import("./openaiApi.mjs");
  // localhost is a NAME: a hosts-file entry can point it anywhere, so it gets no http exception.
  const origins = ["http://compatible.example.invalid", "http://localhost:8103", "http://127.0.0.1:8101", "http://[::1]:8102"];
  f.trust(...origins.map((origin) => ({ env: KEY, origin })));
  let reads = 0;
  const source = { get [KEY]() { reads++; return SECRET; } };
  for (const origin of origins.slice(0, 2)) assert.ok(openaiApiEnvironment(row(`${origin}/v1`), source).refusal, origin);
  assert.equal(reads, 0);
  for (const origin of origins.slice(2)) assert.ok(!openaiApiEnvironment(row(`${origin}/v1`), source).refusal);
});

test("trust-file mutation: absent, malformed and differently shaped trust files fail closed", async (t) => {
  const f = homeFixture(t);
  const { openaiApiEnvironment } = await import("./openaiApi.mjs");
  const leg = row("https://compatible.example.invalid/v1");
  const source = { get [KEY]() { assert.fail("an invalid trust file unlocked the key"); } };
  assert.ok(openaiApiEnvironment(leg, source).refusal);
  for (const content of ["not JSON", "null", "[]", '{"bindings":{}}',
    JSON.stringify({ bindings: [{ env: KEY, origin: "https://compatible.example.invalid/v1" }] })]) {
    writeFileSync(f.trustPath, content);
    assert.ok(openaiApiEnvironment(leg, source).refusal, content);
  }
});

test("environment mutation: only the key reaches a fresh Node worker without proxy or TLS startup settings", async (t) => {
  const f = homeFixture(t);
  const fake = await fakeServer(t);
  f.trust({ env: KEY, origin: fake.origin });
  const { openaiApiEnvironment } = await import("./openaiApi.mjs");
  const poison = { HTTP_PROXY: "http://proxy.invalid:1", HTTPS_PROXY: "http://proxy.invalid:2",
    ALL_PROXY: "http://proxy.invalid:3", NO_PROXY: "*", NODE_EXTRA_CA_CERTS: "untrusted.pem", SSL_CERT_FILE: "untrusted.pem",
    NODE_OPTIONS: "--invalid-parent-only-option", NODE_USE_ENV_PROXY: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0",
    HOME: f.root, PATH: "parent-path", OPENAI_API_KEY: "another-secret", [KEY]: SECRET };
  Object.assign(process.env, poison);
  const effective = openaiApiEnvironment(row(fake.baseUrl), poison);
  assert.deepEqual(effective.env, { [KEY]: SECRET });
  assert.deepEqual(effective.missing, []);
  const result = await runAPI(row(`${fake.baseUrl}/`), { sourceEnv: poison });
  assert.equal(result.kind, "answered");
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].url, "/v1/chat/completions");
  assert.equal(fake.workers.length, 1, "fetch must run in a fresh key-only Node process");
  assert.deepEqual(fake.workers[0].options.env, { [KEY]: SECRET });
  assert.equal(fake.workers[0].options.shell, false);
  assert.equal(fake.workers[0].options.windowsHide, true);
  assert.deepEqual(fake.workers[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(fake.fetchOptions.length, 0, "the parent process's fetch is never used");
});

for (const [status, kind] of [[401, "not-run"], [500, "failed"], [302, "failed"]]) {
  test(`HTTP ${status} mutation: named ${kind}, redacted first 200 body characters and one request`, async (t) => {
    const f = homeFixture(t);
    const body = `vendor refused ${SECRET} ${"x".repeat(300)} BODY-TAIL-MUST-NOT-APPEAR`;
    const fake = await fakeServer(t, (_request, response) => {
      response.writeHead(status, { location: "/redirected" });
      response.end(body);
    });
    f.trust({ env: KEY, origin: fake.origin });
    const result = await runAPI(row(fake.baseUrl));
    assert.equal(result.kind, kind);
    assert.equal(result.leg, "compatible");
    assert.equal(result.answered, false);
    assert.match(result.reason, new RegExp(String(status)));
    assert.match(result.error, new RegExp(String(status)));
    assert.match(result.error, /vendor refused/);
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.ok(!JSON.stringify(result).includes("BODY-TAIL-MUST-NOT-APPEAR"));
    assert.ok(!JSON.stringify(result).includes("x".repeat(201)), "the reported body is capped at 200 characters");
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.workers.length, 1, "a redirect never launches another worker");
  });
}

test("timeout mutation: a configured short deadline aborts one request without a retry", async (t) => {
  const f = homeFixture(t);
  const fake = await fakeServer(t, () => {});
  f.trust({ env: KEY, origin: fake.origin });
  const started = Date.now();
  const result = await runAPI(row(fake.baseUrl, { timeoutMs: 1000 }));
  assert.equal(result.kind, "failed");
  assert.match(`${result.reason} ${result.error}`, /timeout|timed out|no reply/i);
  assert.ok(Date.now() - started < 5000);
  assert.equal(fake.requests.length, 1);
});

test("default-timeout mutation: API dispatch uses 120 seconds, with row and invocation overrides", async (t) => {
  const f = homeFixture(t);
  const fake = await fakeServer(t);
  f.trust({ env: KEY, origin: fake.origin });
  const durations = [];
  const nativeSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, duration, ...args) => {
    durations.push(duration);
    return nativeSetTimeout(callback, duration, ...args);
  });
  for (const [leg, options] of [[row(fake.baseUrl), {}],
    [row(fake.baseUrl, { timeoutMs: 45000 }), {}],
    [row(fake.baseUrl, { timeoutMs: 45000 }), { timeoutMs: 17000 }]]) {
    const result = await runner.runLeg(leg, "Review the artifact.", options);
    assert.equal(result.kind, "answered");
  }
  assert.deepEqual(durations, [120000, 45000, 17000]);
});

test("usage mutation: malformed or partial usage is unpriced, while cached prompt tokens survive", async (t) => {
  const f = homeFixture(t);
  let usage;
  const fake = await fakeServer(t, (_request, response) => response.end(JSON.stringify(reply(usage))));
  f.trust({ env: KEY, origin: fake.origin });
  for (const value of [null, {}, { prompt_tokens: "100", completion_tokens: 10 },
    { prompt_tokens: -1, completion_tokens: 10 }, { prompt_tokens: 10, completion_tokens: -1 }]) {
    usage = value;
    const result = await runAPI(row(fake.baseUrl));
    assert.equal(result.kind, "answered");
    assert.equal(result.usd, null, JSON.stringify(value));
  }
  usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } };
  const result = await runAPI(row(fake.baseUrl));
  assert.equal(result.tokensIn, 100);
  assert.equal(result.tokensOut, 10);
  assert.equal(result.tokensCached, 40);
  assert.equal(result.usd, 0.0003);
});

test("pricing mutation: tier prices apply to the whole prompt and missing or expired pins stay unpriced", async (t) => {
  const f = homeFixture(t);
  const fake = await fakeServer(t);
  f.trust({ env: KEY, origin: fake.origin });
  const tiered = await runAPI(row(fake.baseUrl, { pricesUSDPer1M: {
    "fake-model": { in: 2, out: 10, tierAt: 500, tierIn: 4, tierOut: 20 },
  } }));
  assert.equal(tiered.usd, 0.006);
  for (const pricesUSDPer1M of [{}, { "fake-model": { in: 2, out: 10, until: "2000-01-01" } }]) {
    const result = await runAPI(row(fake.baseUrl, { pricesUSDPer1M }));
    assert.equal(result.usd, null);
    assert.equal(result.tokensIn, 1000);
  }
});

test("response mutation: malformed API JSON and invalid findings are named failures", async (t) => {
  const f = homeFixture(t);
  let body = "not JSON";
  const fake = await fakeServer(t, (_request, response) => response.end(body));
  f.trust({ env: KEY, origin: fake.origin });
  const malformed = await runAPI(row(fake.baseUrl));
  assert.equal(malformed.kind, "failed");
  body = JSON.stringify({ choices: [{ message: { content: "ordinary prose" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  const badFindings = await runAPI(row(fake.baseUrl));
  assert.equal(badFindings.kind, "failed");
  assert.equal(badFindings.parseFailed, true);
  assert.equal(badFindings.tokensIn, 10);
});
