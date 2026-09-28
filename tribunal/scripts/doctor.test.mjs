// Doctor must report missing prerequisites instead of returning an empty successful report.
// Each regression names the behavior its mutation removes. All CLI processes are stubbed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./doctor.mjs";

const claude = { leg: "opus", id: "test-claude", runner: "claude-cli", enabled: true,
  billing: "plan", envKeys: ["CLAUDE_CODE_OAUTH_TOKEN"] };
const codex = { leg: "sol", id: "test-codex", runner: "codex-cli", enabled: true,
  billing: "plan", envKeys: ["CODEX_HOME"] };
const sdk = { leg: "gemini", id: "test-gemini", runner: "genai-sdk", enabled: true,
  billing: "metered", envKeys: ["GEMINI_API_KEY"], requiredEnv: ["GEMINI_API_KEY"] };
const claudeHelp = "Commands:\n  auth Manage authentication\nOptions:\n -p, --print\n --model <id>\n --disallowedTools <tools>\n --setting-sources <sources>\n --strict-mcp-config\n";
const codexHelp = "Options:\n -m, --model <id>\n -s, --sandbox <mode>\n --skip-git-repo-check\n --ephemeral\n --ignore-user-config\n --disable <feature>\n";

test("doctor refuses an untrusted API pair before inspecting its credential", (t) => {
  // RED-FIRST mutation: report requiredEnv presence before checking the origin binding.
  const original = process.env;
  const leg = { leg: "compatible", id: "test-api", runner: "openai-api", enabled: true,
    baseUrl: "https://compatible.invalid/v1", billing: "metered",
    envKeys: ["TEST_API_KEY"], requiredEnv: ["TEST_API_KEY"] };
  const f = fixture(t, { registry: [leg] });
  t.mock.method(os, "homedir", () => f.dir);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  process.env = { ...original, HOME: f.dir, USERPROFILE: f.dir };
  t.after(() => { process.env = original; });
  let reads = 0;
  const sourceEnv = new Proxy({}, { get(_target, key) {
    if (key === "TEST_API_KEY") { reads++; throw new Error("untrusted key read"); }
  } });
  const result = f.run({ sourceEnv });
  assert.equal(reads, 0);
  assert.equal(result.exitCode, 1);
  assert.match(result.lines[0], /compatible.*not runnable.*trust/);
  assert.match(result.lines[0], /TEST_API_KEY=not read/);
  assert.equal(f.calls.length, 0);
});

test("doctor accepts a trusted API key without making a model request", (t) => {
  // RED-FIRST mutation: leave openai-api unsupported in the diagnostics switch.
  const original = process.env;
  const leg = { leg: "compatible", id: "test-api", runner: "openai-api", enabled: true,
    baseUrl: "https://compatible.invalid/v1", billing: "metered",
    envKeys: ["TEST_API_KEY"], requiredEnv: ["TEST_API_KEY"] };
  const f = fixture(t, { registry: [leg], sourceEnv: { TEST_API_KEY: "fixture-secret" } });
  t.mock.method(os, "homedir", () => f.dir);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  process.env = { ...original, HOME: f.dir, USERPROFILE: f.dir };
  t.after(() => { process.env = original; });
  mkdirSync(join(f.dir, ".tribunal"));
  writeFileSync(join(f.dir, ".tribunal", "trust.json"), JSON.stringify({ bindings: [
    { env: "TEST_API_KEY", origin: "https://compatible.invalid" },
  ] }));
  t.mock.method(globalThis, "fetch", () => assert.fail("doctor must never call a model"));
  const result = f.run();
  assert.equal(result.exitCode, 0);
  assert.match(result.lines[0], /compatible.*runnable.*billing: metered/);
  assert.match(result.lines[0], /TEST_API_KEY=set/);
  assert.doesNotMatch(result.lines.join("\n"), /fixture-secret/);
  assert.equal(f.calls.length, 0);
});

function fixture(t, { registry = [claude], missing = [], reply, changeHelp, sourceEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tribunal-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const options = {
    policy: { repoRoot: dir, ledgerHome: join(dir, "ledger"), registry },
    nodeVersion: "20.0.0", tempDir: dir, sourceEnv,
    sdkAvailableFn: () => true,
    resolveExeFn: (cmd) => ({ file: join(dir, `${cmd}.exe`), prefix: [],
      found: !missing.includes(cmd), searchedDirs: [join(dir, "bin-one"), join(dir, "bin-two")] }),
    spawnFn: (file, args, opts) => {
      calls.push({ file, args, opts });
      let stdout;
      if (args.at(-1) === "status") {
        return reply || { status: 0, stdout: file.endsWith("claude.exe")
          ? '{"loggedIn":true,"authMethod":"claude.ai"}\nsecond line'
          : "Logged in using ChatGPT\n", stderr: "" };
      }
      if (args[0] === "auth" || args[0] === "login") stdout = "Commands:\n  status Show authentication status\n";
      else if (args.length === 1 && file.endsWith("codex.exe")) stdout = "Commands:\n  login Manage login\n  exec Run non-interactively\n";
      // Model the CLI help shapes: `claude -p <leg args> --help` prints the
      // options WITHOUT the Commands section; only a bare `claude --help` advertises `auth`.
      else if (args.length > 1 && file.endsWith("claude.exe")) stdout = claudeHelp.replace(/^Commands:\n  auth Manage authentication\n/, "");
      else stdout = file.endsWith("claude.exe") ? claudeHelp : codexHelp;
      return { status: 0, stdout: changeHelp ? changeHelp(stdout) : stdout, stderr: "" };
    },
  };
  return { dir, calls, options, run: (extra = {}) => runDoctor({ ...options, ...extra }) };
}

test("doctor reports a runnable seat and checks both writable directories", (t) => {
  // Mutation: return an empty seat/machine report instead of performing diagnostics.
  const f = fixture(t);
  const r = f.run();
  assert.equal(r.exitCode, 0);
  assert.match(r.lines[0], /^opus \[enabled\]: runnable; binary: .*claude\.exe; login: logged-in/);
  assert.match(r.lines[0], /billing: subscription; flags: accepted/);
  assert.ok(r.lines[0].includes('auth reply: {"loggedIn":true,"authMethod":"claude.ai"}'));
  assert.ok(!r.lines[0].includes("second line"));
  assert.match(r.lines.join("\n"), /machine:\nNode: 20\.0\.0; required >=20; OK/);
  assert.match(r.lines.join("\n"), /ledger home: writable/);
  assert.match(r.lines.join("\n"), /OS temp: writable/);
  assert.deepEqual(readdirSync(join(f.dir, "ledger")), []);
  assert.deepEqual(readdirSync(f.dir), ["ledger"], "create-and-delete leaves no check files");
});

test("doctor names a missing binary and all PATH directories, exiting 1", (t) => {
  // Mutation: omit executable resolution and treat a missing enabled CLI as runnable.
  const f = fixture(t, { missing: ["claude"] });
  const r = f.run();
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0], /opus \[enabled\]: not runnable; binary: claude missing on PATH/);
  assert.ok(r.lines[0].includes(join(f.dir, "bin-one")));
  assert.ok(r.lines[0].includes(join(f.dir, "bin-two")));
  assert.equal(f.calls.length, 0, "a missing CLI is never spawned");
});

test("doctor names an unset SDK key without exposing set values, exiting 1", (t) => {
  // Mutation: skip requiredEnv validation and return success for a keyless enabled SDK leg.
  const f = fixture(t, { registry: [sdk] });
  const r = f.run();
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0], /gemini \[enabled\]: not runnable;.*credentials: GEMINI_API_KEY=unset/);
  const present = f.run({ sourceEnv: { GEMINI_API_KEY: "private-test-value" } });
  assert.equal(present.exitCode, 0);
  assert.match(present.lines[0], /credentials: GEMINI_API_KEY=set/);
  assert.ok(!present.lines.join("\n").includes("private-test-value"));
  assert.equal(f.calls.length, 0);
});

test("doctor rejects a Node version below the package engines range", (t) => {
  // Mutation: omit the Node engine check and always return exit 0.
  const r = fixture(t).run({ nodeVersion: "18.20.8" });
  assert.equal(r.exitCode, 1);
  assert.ok(r.lines.includes("Node: 18.20.8; required >=20; FAIL"));
});

test("doctor reports an unwritable OS temp directory and exits 1", (t) => {
  // Mutation: omit the create-and-delete probe and treat inaccessible temp as writable.
  const f = fixture(t);
  const r = f.run({ openFileFn: (file, flags) => {
    if (dirname(file) === f.dir) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    return openSync(file, flags);
  } });
  assert.equal(r.exitCode, 1);
  assert.match(r.lines.join("\n"), /OS temp: not writable .*EACCES/);
});

test("doctor checks Codex auth and help using the runner's allowlisted environment", (t) => {
  // Mutation: omit CLI probes, so verified auth argv, mandatory flags and the leg env never reach spawn.
  const sourceEnv = { PATH: "test-path", CODEX_HOME: "codex-store", CLAUDE_CODE_OAUTH_TOKEN: "other-secret" };
  const f = fixture(t, { registry: [codex], sourceEnv });
  const r = f.run();
  assert.equal(r.exitCode, 0);
  assert.match(r.lines[0], /login: logged-in; auth reply: Logged in using ChatGPT; billing: subscription/);
  assert.ok(f.calls.some(({ args }) => args.join(" ") === "login status"));
  assert.ok(f.calls.some(({ args }) => args[0] === "exec" && args.includes("--ignore-user-config") && args.at(-1) === "--help"));
  for (const { opts } of f.calls) {
    assert.equal(opts.env.CODEX_HOME, "codex-store");
    assert.equal(opts.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(opts.shell, false);
    assert.ok(opts.timeout > 0);
  }
});

test("doctor names a missing mandatory flag and exits 1", (t) => {
  // Mutation: remove mandatory-argv help validation, allowing a missing isolation flag.
  const r = fixture(t, { changeHelp: (text) => text.replace("--strict-mcp-config", "--strict-mcp-config-extra") }).run();
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0], /flags: missing --strict-mcp-config/);
});

test("doctor distinguishes logged-out and unknown auth and never infers billing from silence", (t) => {
  // Mutation: skip auth validation and silently approve logged-out or unrecognised status output.
  const f = fixture(t);
  for (const [reply, state] of [
    [{ status: 1, stdout: '{"loggedIn":false}', stderr: "" }, "not logged-in"],
    [{ status: 0, stdout: "", stderr: "" }, "not detectable"],
    [{ status: 1, stdout: "", stderr: "status unavailable" }, "not detectable"],
  ]) {
    const r = fixture(t, { reply }).run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.lines[0].includes(`login: ${state}`));
    assert.match(r.lines[0], /billing: not detectable/);
  }
  assert.equal(f.run().exitCode, 0);
});

test("doctor reports API-key auth explicitly and login-only status leaves billing unknown", (t) => {
  // Mutation: omit status parsing and the billing diagnostic entirely.
  for (const [runner, reply, billing] of [
    [claude, '{"loggedIn":true,"authMethod":"api_key"}', "API key"],
    [codex, "Logged in using an API key", "API key"],
    [codex, "Logged in", "not detectable"],
  ]) {
    const r = fixture(t, { registry: [runner], reply: { status: 0, stdout: reply, stderr: "" } }).run();
    assert.equal(r.exitCode, 0);
    assert.ok(r.lines[0].includes(`billing: ${billing}`));
  }
});

test("doctor reports explicit subscription metadata without letting it override API-key auth", (t) => {
  // RED-FIRST mutation: ignore subscriptionType when identifying the status output's billing mode.
  for (const [data, billing] of [
    [{ loggedIn: true, authMethod: "oauth_token", subscriptionType: "max" }, "subscription (max)"],
    [{ loggedIn: true, authMethod: "api_key", subscriptionType: "max" }, "API key"],
    [{ loggedIn: true, subscriptionType: null }, "not detectable"],
  ]) {
    const r = fixture(t, { reply: { status: 0, stdout: JSON.stringify(data), stderr: "" } }).run();
    assert.equal(r.exitCode, 0);
    assert.ok(r.lines[0].includes(`billing: ${billing};`), r.lines[0]);
  }
});

test("doctor leaves disabled-seat failures and absent gh informational", (t) => {
  // Mutation: omit configured disabled seats and the gh scope note from the report.
  const r = fixture(t, { registry: [claude, { ...codex, enabled: false }], missing: ["codex", "gh"] }).run();
  assert.equal(r.exitCode, 0);
  assert.match(r.lines[1], /^sol \[disabled\]: not runnable; binary: codex missing on PATH/);
  assert.match(r.lines.join("\n"), /gh: missing on PATH; only --pr and proof posting need it/);
});

test("doctor does not guess an auth command absent from CLI help", (t) => {
  // Mutation: omit help discovery and its not-detectable diagnostic.
  const f = fixture(t, { changeHelp: (text) => text.replace("auth Manage authentication", "other Unrelated") });
  const r = f.run();
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0], /login: not detectable/);
  assert.ok(!f.calls.some(({ args }) => args.includes("auth")));
});

test("doctor catches spawn errors as a named unavailable diagnostic", (t) => {
  // Mutation: omit subprocess error diagnostics and return success without checking the CLI.
  const r = fixture(t).run({ spawnFn: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0], /flags: help failed .*EACCES/);
});

test("doctor reports a missing SDK installation even when its credential is set", (t) => {
  // Mutation: omit dependency availability checks and approve a leg that cannot import its SDK.
  const r = fixture(t, { registry: [sdk], sourceEnv: { GEMINI_API_KEY: "test" } }).run({ sdkAvailableFn: () => false });
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0], /SDK: @google\/genai missing; run npm ci in tribunal\/scripts/);
});

test("the Node >=20 floor agrees with the pinned SDK and lockfile root", () => {
  // Mutation: omit engines from the package and lockfile root, losing the SDK's Node floor.
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL("./package-lock.json", import.meta.url)));
  assert.equal(pkg.engines.node, ">=20");
  assert.deepEqual(lock.packages[""].engines, pkg.engines);
  assert.equal(lock.packages["node_modules/@google/genai"].engines.node, ">=20.0.0");
});

test("doctor CLI resolves the consumer's preset and ledger, reporting a missing enabled CLI", (t) => {
  // RED-FIRST mutation: launch a stub entrypoint that ignores consumer policy and prints nothing.
  const f = fixture(t);
  mkdirSync(join(f.dir, ".git"));
  mkdirSync(join(f.dir, "nested"));
  writeFileSync(join(f.dir, "tribunal.config.json"), JSON.stringify({ preset: "claude-only", ledgerHome: "ledger" }));
  const env = { ...process.env, TEMP: f.dir, TMP: f.dir };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = "";
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./doctor.mjs", import.meta.url))], {
    cwd: join(f.dir, "nested"), env, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  const seats = result.stdout.split(/\r?\n/).filter((line) => /\[(?:enabled|disabled|skipped)\]/.test(line));
  assert.equal(seats.length, 5);
  // A preset is a deliberate choice, so its absent CLI stays a loud failure (never auto-skipped).
  assert.equal(seats.filter((line) => line.includes("[enabled]")).length, 1);
  assert.match(seats[0], /^opus \[enabled\]: not runnable; binary: claude missing on PATH/);
  assert.ok(result.stdout.includes(`ledger home: writable (${join(f.dir, "ledger")})`));
});

test("doctor with NO configuration on a machine with no CLI labels every seat skipped and says nothing can run", (t) => {
  // RED-FIRST mutation: keep exit 0 when every default seat was auto-skipped.
  const f = fixture(t);
  mkdirSync(join(f.dir, ".git"));
  const env = { ...process.env, TEMP: f.dir, TMP: f.dir, HOME: f.dir, USERPROFILE: f.dir };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = "";
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./doctor.mjs", import.meta.url))], {
    cwd: f.dir, env, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 1, result.stderr);
  const seats = result.stdout.split(/\r?\n/).filter((line) => /\[(?:enabled|disabled|skipped)\]/.test(line));
  assert.equal(seats.filter((line) => line.includes("[skipped]")).length, 3, result.stdout);
  assert.equal(seats.filter((line) => line.includes("[enabled]")).length, 0);
  assert.match(result.stdout, /no seat can run: install the Claude CLI/);
});
