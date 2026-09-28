// RED-FIRST: noTelemetry.negative-control.mjs injects a swallowed off-vendor fetch,
// an unexpected subprocess, and a gh call into disposable copies of the real runner.
// Each must fail this fixture even when the round otherwise completes successfully.
import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { join, resolve, sep } from "node:path";

test("--file contacts only the configured model vendors, with every leg stubbed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tribunal-no-telemetry-"));
  const original = { env: process.env, argv: process.argv, cwd: process.cwd(), exitCode: process.exitCode };
  const violations = [], processes = [], requests = [], sdkCalls = [], outputs = [], legDirs = [];
  const deny = (entry) => (...args) => {
    const detail = `${entry}: ${String(args[0])}`;
    violations.push(detail);
    throw new Error(`unexpected network/process contact: ${detail}`);
  };
  t.after(() => {
    process.env = original.env;
    process.argv = original.argv;
    process.chdir(original.cwd);
    process.exitCode = original.exitCode;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    // Every path here was created by this fixture, including the runner's leg dirs.
    for (const dir of legDirs) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  // Install the tripwires before importing the runner or SDK, including the lower
  // socket layers so a dependency cannot bypass a patched fetch/request function.
  for (const [object, names, label] of [
    [http, ["request", "get"], "http"], [https, ["request", "get"], "https"],
    [http2, ["connect"], "http2"], [net, ["connect", "createConnection"], "net"],
    [net.Socket.prototype, ["connect"], "socket"], [tls, ["connect"], "tls"],
    [dgram, ["createSocket"], "dgram"],
    [dns, Object.keys(dns).filter((key) => /^(lookup|resolve)/.test(key)), "dns"],
    [dns.promises, Object.keys(dns.promises).filter((key) => /^(lookup|resolve)/.test(key)), "dns.promises"],
    [childProcess, ["exec", "execSync", "execFile", "execFileSync", "fork"], "child_process"],
  ]) {
    for (const name of names) t.mock.method(object, name, deny(`${label}.${name}`));
  }
  if (globalThis.WebSocket) t.mock.method(globalThis, "WebSocket", deny("WebSocket"));
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    // RED-FIRST mutation: omit the openai-api dispatch. This is an in-memory vendor
    // response, NEVER permission to connect to a socket (including loopback).
    if (url.origin === "https://compatible.invalid" && url.pathname === "/v1/chat/completions"
      && options?.method === "POST") {
      assert.equal(options.redirect, "manual");
      assert.equal(options.dispatcher, undefined);
      assert.equal(options.headers.Authorization, "Bearer compatible-fixture-only");
      requests.push(url.href);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"findings":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.origin !== "https://generativelanguage.googleapis.com"
      || url.pathname !== "/v1beta/models/gemini-test:generateContent"
      || options?.method !== "POST") return deny("fetch")(url.href);
    requests.push(url.href);
    return new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: '{"findings":[]}' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const legs = [
    { leg: "opus", id: "claude-test", runner: "claude-cli", billing: "plan", enabled: true, envKeys: [] },
    { leg: "sol", id: "codex-test", runner: "codex-cli", billing: "plan", enabled: true, envKeys: [] },
    { leg: "gemini", id: "gemini-test", runner: "genai-sdk", billing: "metered", enabled: true,
      envKeys: ["GEMINI_API_KEY"], requiredEnv: ["GEMINI_API_KEY"],
      pricesUSDPer1M: { "gemini-test": { in: 1, out: 1 } } },
    { leg: "compatible", id: "compatible-test", runner: "openai-api", billing: "metered", enabled: true,
      baseUrl: "https://compatible.invalid/v1", envKeys: ["COMPATIBLE_API_KEY"], requiredEnv: ["COMPATIBLE_API_KEY"],
      pricesUSDPer1M: { "compatible-test": { in: 1, out: 1 } } },
  ];
  const executables = new Map();
  for (const command of ["claude", "codex"]) {
    if (process.platform === "win32") {
      const js = join(root, "node_modules", command, "bin", `${command}.js`);
      mkdirSync(join(root, "node_modules", command, "bin"), { recursive: true });
      writeFileSync(js, "throw new Error('must be intercepted');\n");
      writeFileSync(join(root, `${command}.cmd`), "@echo off\r\nexit /b 99\r\n");
      executables.set(command, { file: process.execPath, prefix: [js] });
    } else {
      const file = join(root, command);
      writeFileSync(file, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
      executables.set(command, { file, prefix: [] });
    }
  }
  const commandOf = (file, args) => [...executables].find(([, executable]) =>
    file === executable.file && executable.prefix.every((value, i) => args[i] === value));
  t.mock.method(childProcess, "spawnSync", (file, args, options) => {
    const found = commandOf(file, args);
    if (!found) return deny("spawnSync")(file);
    const [command, executable] = found;
    assert.deepEqual(args, [...executable.prefix, "--version"]);
    assert.equal(options.shell, false);
    processes.push(`${command} --version`);
    return { status: 0, stdout: `${command} fixture 1.0\n`, stderr: "" };
  });
  t.mock.method(childProcess, "spawn", (file, args, options) => {
    // RED-FIRST mutation: run compatible fetch in this process, inheriting parent TLS
    // settings. The real worker is stubbed here; no subprocess or socket is opened.
    if (file === process.execPath && args.length === 1
      && args[0] === fileURLToPath(new URL("./openaiApiWorker.mjs", import.meta.url))) {
      assert.deepEqual(options.env, { COMPATIBLE_API_KEY: "compatible-fixture-only" });
      assert.equal(options.shell, false);
      processes.push("compatible review");
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      let input = "";
      child.stdin = { write: (text) => { input += text; }, end: () => {
        import("./openaiApiWorker.mjs").then(({ requestCompletion }) =>
          requestCompletion(JSON.parse(input), options.env)).then((result) => {
          child.stdout.emit("data", JSON.stringify(result)); child.emit("close", 0);
        }).catch((error) => {
          child.stderr.emit("data", error.message); child.emit("close", 1);
        });
      } };
      return child;
    }
    const found = commandOf(file, args);
    if (!found) return deny("spawn")(file);
    const [command, executable] = found;
    const leg = legs.find((entry) => entry.runner === `${command}-cli`);
    assert.deepEqual(args, [...executable.prefix, ...argsForLeg(leg)]);
    assert.equal(options.shell, false);
    assert.ok(isOurTempDir(options.cwd));
    assert.equal(options.env.GEMINI_API_KEY, undefined);
    assert.equal(options.env.COMPATIBLE_API_KEY, undefined);
    legDirs.push(options.cwd);
    processes.push(`${command} review`);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let prompt = "";
    child.stdin = { write: (text) => { prompt += text; }, end: () => {
      assert.match(prompt, /Offline review fixture/);
      queueMicrotask(() => { child.stdout.emit("data", '{"findings":[]}'); child.emit("close", 0); });
    } };
    return child;
  });
  t.mock.method(os, "homedir", () => root);
  syncBuiltinESMExports();
  process.env = Object.fromEntries(["SystemRoot", "TEMP", "TMP", "ComSpec"].filter((key) => original.env[key])
    .map((key) => [key, original.env[key]]));
  Object.assign(process.env, { PATH: root, HOME: root, USERPROFILE: root, GEMINI_API_KEY: "fixture-only" });
  process.env.COMPATIBLE_API_KEY = "compatible-fixture-only";
  mkdirSync(join(root, ".tribunal"));
  writeFileSync(join(root, ".tribunal", "trust.json"), JSON.stringify({ bindings: [
    { env: "COMPATIBLE_API_KEY", origin: "https://compatible.invalid" },
  ] }));

  const { argsForLeg, isOurTempDir } = await import("./legRunner.mjs");
  const { argvShapeHash } = await import("./isolationBinding.mjs");
  const { GoogleGenAI } = await import("@google/genai");
  const modelPrototype = Object.getPrototypeOf(new GoogleGenAI({ apiKey: "fixture-only" }).models);
  const generate = modelPrototype.generateContentInternal;
  t.mock.method(modelPrototype, "generateContentInternal", function (params) {
    sdkCalls.push(params.model);
    assert.equal(params.model, "gemini-test");
    assert.match(params.contents, /Offline review fixture/);
    return generate.call(this, params); // Its HTTP boundary above returns an in-memory response.
  });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "ledger"));
  writeFileSync(join(root, "models.json"), JSON.stringify({ legs }));
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify({ modelsFile: "models.json", ledgerHome: "ledger" }));
  writeFileSync(join(root, "review.md"), "Offline review fixture\n");
  const record = { schemaVersion: 1, probeVersion: "fixture", measuredAt: new Date().toISOString(),
    enabledCliRunners: ["claude-cli", "codex-cli"],
    cli: Object.fromEntries(legs.slice(0, 2).map((leg) => {
      const command = leg.runner.replace("-cli", ""), executable = executables.get(command);
      return [leg.runner, { executablePath: executable.file, executablePrefix: executable.prefix,
        version: `${command} fixture 1.0`, argvShapeHash: argvShapeHash(leg), verdict: "PASS" }];
    })), overall: { ok: true, verdict: "PASS", why: "offline fixture" } };
  writeFileSync(join(root, "ledger", "isolation-probe.md"), `\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n`);
  process.chdir(root);
  process.argv = [process.execPath, "fixture", "--file", join(root, "review.md"), "--json"];
  t.mock.method(console, "log", (text) => outputs.push(text));
  t.mock.method(console, "error", () => {});
  const { main } = await import(original.env.TRIBUNAL_TEST_RUNNER_URL || new URL("./run.mjs", import.meta.url));
  await main();

  assert.deepEqual(violations, [], "unexpected network/process contact, even if its error was swallowed");
  assert.equal(process.exitCode, 0);
  assert.deepEqual(processes.sort(), ["claude --version", "claude review", "codex --version", "codex review", "compatible review"]);
  assert.deepEqual(sdkCalls, ["gemini-test"]);
  assert.deepEqual(requests.sort(), ["https://compatible.invalid/v1/chat/completions",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"]);
  assert.equal(new Set(legDirs).size, 2);
  const output = JSON.parse(outputs.at(-1));
  assert.equal(output.summary.complete, true);
  assert.equal(output.decision.reason, "QUIET");
  assert.equal(output.record.legs.length, 4);
  assert.equal(readdirSync(join(root, "ledger")).filter((name) => name.endsWith(".ndjson")).length, 1);
  assert.match(readFileSync(join(root, "ledger", `${new Date().toISOString().slice(0, 7)}.ndjson`), "utf8"), /"QUIET"/);
});
