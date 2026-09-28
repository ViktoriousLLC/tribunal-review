// RED-FIRST mutations: retain the text-only PASS gate; omit runner coverage/path/version/
// argv checks; accept empty CLI measurements or API-only records after enabling a CLI.
// Additional mutations: ignore the npm entrypoint prefix, version-command failures, or
// per-CLI verdicts; hash the model id; fail to wire the policy-aware gate into main.
// All CLI spawns are stubs so binding checks do not invoke installed tools or models.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as probe from "./isolationProbe.mjs";
import { overallVerdict } from "./isolationProbeLogic.mjs";
import { isolationGate } from "./run.mjs";
import { argsForLeg, envForLeg } from "./legRunner.mjs";
import { resolvePolicy } from "./policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const runnerUrl = pathToFileURL(join(HERE, "run.mjs")).href;
const legs = [
  { leg: "opus", id: "claude-test", runner: "claude-cli", billing: "plan", enabled: true, envKeys: ["CLAUDE_CODE_OAUTH_TOKEN"] },
  { leg: "sol", id: "codex-test", runner: "codex-cli", billing: "plan", enabled: true, envKeys: ["CODEX_HOME"] },
  { leg: "gemini", id: "gemini-test", runner: "genai-sdk", billing: "metered", enabled: true, envKeys: [], requiredEnv: [] },
];
const pass = { verdict: "PASS", why: "the control leaked and the guarded run did not" };
const hash = (leg) => createHash("sha256").update(JSON.stringify(argsForLeg({ ...leg, id: "" }))).digest("hex");
const exe = (cmd) => join(HERE, "fake-cli", `${cmd}.exe`);
const binding = (leg) => ({ executablePath: exe(leg.runner.replace("-cli", "")), executablePrefix: [],
  version: `${leg.runner} test 1.0`, argvShapeHash: hash(leg) });
const bindings = Object.fromEntries(legs.slice(0, 2).map((leg) => [leg.runner, binding(leg)]));
const options = {
  resolveExecutable: (cmd) => ({ file: exe(cmd), prefix: [], found: true }),
  spawnVersion: (file) => ({ status: 0, stdout: `${file === exe("claude") ? "claude" : "codex"}-cli test 1.0\n`, stderr: "" }),
};

function fixture(t, registry = legs) {
  const root = mkdtempSync(join(tmpdir(), "tribunal-probe-binding-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = { repoRoot: root, modelsFile: join(root, "models.json"),
    probeRecord: join(root, "ledger", "isolation-probe.md"), registry: structuredClone(registry) };
  const read = () => {
    const text = readFileSync(policy.probeRecord, "utf8");
    const match = /^```json\s*\r?\n([\s\S]*?)^```\s*$/m.exec(text);
    assert.ok(match, "the probe must write a fenced JSON binding");
    return JSON.parse(match[1]);
  };
  const write = (record) => writeFileSync(policy.probeRecord, `OVERALL: PASS\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n`);
  const gate = () => isolationGate(policy, options);
  return { root, policy, read, write, gate };
}

test("one measured CLI binds its runner type; enabling another names the unmeasured type", async (t) => {
  const f = fixture(t, [legs[0], { ...legs[1], enabled: false }, legs[2]]);
  await probe.writeProbeRecord(f.policy, { claude: pass }, { bindings });
  const record = f.read();
  assert.deepEqual(record.enabledCliRunners, ["claude-cli"]);
  assert.deepEqual(Object.keys(record.cli), ["claude-cli"]);
  assert.equal(record.probeVersion, JSON.parse(readFileSync(join(HERE, "../.claude-plugin/plugin.json"))).version);
  assert.deepEqual(record.cli["claude-cli"], { ...bindings["claude-cli"], ...pass });
  assert.equal(f.gate().ok, true);
  f.policy.registry[1].enabled = true;
  const refused = f.gate();
  assert.equal(refused.ok, false);
  assert.match(refused.why, /unmeasured.*codex-cli/);
  assert.match(refused.why, /node .*isolationProbe\.mjs/);
});

for (const [field, changed, reason] of [
  ["executablePath", exe("old-codex"), /executable path changed/],
  ["version", "codex-cli old 0.9", /version changed/],
  ["argvShapeHash", "0".repeat(64), /argv-shape hash changed/],
  ["executablePrefix", [join(HERE, "old-cli.js")], /executable prefix changed/],
]) {
  test(`both CLIs pass; changed ${field} refuses with old and current values`, async (t) => {
    const f = fixture(t);
    await probe.writeProbeRecord(f.policy, { claude: pass, codex: pass }, { bindings });
    assert.equal(f.gate().ok, true);
    const record = f.read();
    record.cli["codex-cli"][field] = changed;
    f.write(record);
    const refused = f.gate();
    assert.equal(refused.ok, false);
    assert.match(refused.why, /codex-cli/);
    assert.match(refused.why, reason);
    assert.ok(refused.why.includes(JSON.stringify(changed)));
    assert.ok(refused.why.includes(JSON.stringify(bindings["codex-cli"][field])));
    assert.match(refused.why, /node .*isolationProbe\.mjs/);
  });
}

test("API-only record is explicit and accepted only while no CLI is enabled", async (t) => {
  const f = fixture(t, [{ ...legs[0], enabled: false }, legs[2]]);
  const recorded = await probe.writeProbeRecord(f.policy, {});
  assert.deepEqual(recorded, { ok: true, verdict: "NO-AGENT-BOUNDARY", why: "no local agent leg is enabled; nothing to isolate" });
  assert.deepEqual(f.read().enabledCliRunners, []);
  assert.deepEqual(f.read().cli, {});
  assert.equal(f.gate().ok, true);
  f.policy.registry[0].enabled = true;
  assert.equal(f.gate().ok, false);
  assert.match(f.gate().why, /unmeasured.*claude-cli/);
});

test("an old text PASS record requires re-probing because it predates binding", (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.policy.probeRecord));
  writeFileSync(f.policy.probeRecord, "OVERALL: PASS\n");
  const refused = f.gate();
  assert.equal(refused.ok, false);
  assert.match(refused.why, /re-probe: the record predates binding/);
  assert.match(refused.why, /node .*isolationProbe\.mjs/);
});

test("zero results with an enabled CLI is FAIL, including the persisted verdict", async (t) => {
  const f = fixture(t, [legs[0]]);
  const empty = overallVerdict({}, ["claude-cli"]);
  assert.equal(empty.ok, false);
  assert.equal(empty.verdict, "FAIL");
  assert.match(empty.why, /no .*probed|zero|no .*results/);
  const recorded = await probe.writeProbeRecord(f.policy, {});
  assert.equal(recorded.verdict, "FAIL");
  assert.equal(recorded.ok, false);
  assert.equal(f.gate().ok, false);
});

test("malformed JSON and missing bindings cannot be rescued by human PASS prose", async (t) => {
  const f = fixture(t);
  await probe.writeProbeRecord(f.policy, { claude: pass, codex: pass }, { bindings });
  const original = f.read();
  for (const mutate of [
    (record) => { record.schemaVersion = 900; },
    (record) => { delete record.cli["codex-cli"]; },
    (record) => { record.cli["claude-cli"].verdict = "FAIL"; },
    (record) => { delete record.cli["claude-cli"].version; },
    (record) => { record.overall.ok = false; },
  ]) {
    const record = structuredClone(original);
    mutate(record); f.write(record);
    assert.equal(f.gate().ok, false);
  }
  writeFileSync(f.policy.probeRecord, "OVERALL: PASS\n```json\n{broken\n```\n");
  assert.equal(f.gate().ok, false);
});

test("model changes and duplicate seats keep the same runner argv shape", async (t) => {
  const f = fixture(t, [legs[0]]);
  await probe.writeProbeRecord(f.policy, { claude: pass }, { bindings });
  f.policy.registry[0].id = "a-new-model";
  f.policy.registry.push({ ...legs[0], id: "fallback-model", leg: "another-seat" });
  assert.equal(f.gate().ok, true);
});

test("failed or empty version commands refuse instead of trusting the record", async (t) => {
  const f = fixture(t, [legs[0]]);
  await probe.writeProbeRecord(f.policy, { claude: pass }, { bindings });
  for (const spawnVersion of [
    () => ({ status: 1, stdout: bindings["claude-cli"].version, stderr: "failed" }),
    () => ({ status: 0, stdout: "", stderr: "" }),
    () => ({ error: new Error("ENOENT") }),
    () => { throw new Error("spawn threw"); },
  ]) {
    const refused = isolationGate(f.policy, { ...options, spawnVersion });
    assert.equal(refused.ok, false);
    assert.match(refused.why, /claude-cli.*version/);
  }
});

test("stubbed probe captures version and runs the exact resolved CLI it certifies", async (t) => {
  const f = fixture(t, [legs[0], { ...legs[0], leg: "fable", id: "other-model" }]);
  const calls = [], versionCalls = [];
  const executablePath = process.execPath;
  const executablePrefix = [join(HERE, "stub-claude.js")];
  const sourceEnv = { PATH: "", HOME: "/test-home", CLAUDE_CODE_OAUTH_TOKEN: "test-token", OPENAI_API_KEY: "excluded" };
  let resolutions = 0;
  const resolveExecutable = () => { resolutions++; return { file: executablePath, prefix: executablePrefix, found: true }; };
  const spawnVersion = (file, args, opts) => {
    versionCalls.push({ file, args, opts });
    return { status: 0, stdout: "", stderr: "stub-claude 1.0\n" };
  };
  const spawnFn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    calls.push({ file, args, opts });
    let input = "";
    child.stdin = { write(value) { input += value; }, end() {
      setImmediate(() => {
        const canaryPath = /[A-Za-z]:\/[^\n]*?review-config\.json|\/[^\n]*?review-config\.json/.exec(input)?.[0];
        const control = args.includes("--dangerously-skip-permissions");
        child.stdout.emit("data", control ? readFileSync(canaryPath, "utf8") : "CANNOT-READ");
        child.emit("close", 0);
      });
    } };
    return child;
  };
  const result = await probe.runProbe(f.policy, { sourceEnv, resolveExecutable, spawnVersion, spawnFn });
  assert.equal(result.recorded.ok, true);
  assert.equal(resolutions, 1, "the measurement uses the executable whose version was captured");
  assert.equal(versionCalls.length, 1, "measure a runner type only once");
  assert.deepEqual(versionCalls[0].args, [...executablePrefix, "--version"]);
  assert.deepEqual(versionCalls[0].opts.env, envForLeg(legs[0], sourceEnv).env);
  assert.equal(versionCalls[0].opts.shell, false);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.file, executablePath);
    assert.deepEqual(call.args.slice(0, executablePrefix.length), executablePrefix);
  }
  assert.deepEqual(f.read().cli["claude-cli"], { executablePath, executablePrefix, version: "stub-claude 1.0", argvShapeHash: hash(legs[0]), ...pass });
  assert.equal(isolationGate(f.policy, { resolveExecutable, spawnVersion, sourceEnv }).ok, true);
});

test("effective registry overrides reach the real gate; refusal exits 5 before review", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".git"));
  writeFileSync(f.policy.modelsFile, JSON.stringify({ legs: legs.map((leg) => ({ ...leg, enabled: false })) }));
  const configPath = join(f.root, "tribunal.config.json");
  const config = { modelsFile: f.policy.modelsFile, ledgerHome: dirname(f.policy.probeRecord), enabledLegs: ["opus"] };
  writeFileSync(configPath, JSON.stringify(config));
  const policy = resolvePolicy(f.root);
  await probe.writeProbeRecord(policy, { claude: pass }, { bindings });
  writeFileSync(configPath, JSON.stringify({ ...config, enabledLegs: ["opus", "sol"] }));
  const wrapper = join(f.root, "invoke.mjs");
  // --no-auto-probe: this fixture asserts the strict refusal; by default the runner would take
  // the missing measurement itself (firstRun.test.mjs covers that path).
  writeFileSync(wrapper, `process.argv.push("--no-auto-probe");
    import { main } from ${JSON.stringify(runnerUrl)};
    await main({ reviewLeg: async () => { throw new Error("review must not run"); }, probeOptions: {
      resolveExecutable: (cmd) => ({ file: ${JSON.stringify(join(HERE, "fake-cli"))} + '/' + cmd + '.exe', prefix: [], found: true }),
      spawnVersion: () => { throw new Error("unmeasured runner must be checked first"); }
    }});`);
  const result = spawnSync(process.execPath, [wrapper], { cwd: f.root, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 5, result.stderr);
  assert.match(result.stderr, /unmeasured.*codex-cli/);
  assert.match(result.stderr, /node .*isolationProbe\.mjs/);
  assert.doesNotMatch(result.stderr, /review must not run/);
});
