// RED-FIRST mutations: (1) resolvePolicy keeps an enabled CLI seat whose binary is absent, so a
// Claude-only machine spawns Codex legs that cannot start; (2) admitPanel refuses on a missing
// record instead of taking the measurement; (3) admitPanel re-probes on a FAILED record, hiding
// the verdict. Each assertion below fails against the corresponding mutation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { resolvePolicy } from "./policy.mjs";
import { admitPanel } from "./run.mjs";
import { argsForLeg } from "./legRunner.mjs";

function repo(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), "tribunal-first-run-test-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify({ ledgerHome: "ledger", ...config }));
  return root;
}
const onlyClaude = (cmd) => ({ found: cmd === "claude", file: cmd, prefix: [], searchedDirs: [] });

test("with no configuration, a seat whose CLI is not installed is skipped with a reason, not failed", (t) => {
  const policy = resolvePolicy(repo(t), { resolveExecutable: onlyClaude });
  const byLeg = Object.fromEntries(policy.registry.map((l) => [l.leg, l]));
  assert.equal(byLeg.opus.enabled, true);
  assert.equal(byLeg.sol.enabled, false);
  assert.equal(byLeg.astra.enabled, false);
  assert.match(byLeg.sol.disabledReason, /codex CLI is not installed/);
  assert.equal(byLeg.sol.skippedNotInstalled, true);
});

test("a seat the user named in enabledLegs stays enabled even when its CLI is absent (loud, as asked)", (t) => {
  const policy = resolvePolicy(repo(t, { enabledLegs: ["sol"] }), { resolveExecutable: onlyClaude });
  const sol = policy.registry.find((l) => l.leg === "sol");
  assert.equal(sol.enabled, true);
  assert.equal(sol.skippedNotInstalled, undefined);
});

test("a custom modelsFile is a deliberate list: its seats are never skipped for an absent CLI", (t) => {
  const root = repo(t);
  writeFileSync(join(root, "models.json"), JSON.stringify({ legs: [
    { leg: "a", id: "fake-a", vendor: "openai", runner: "codex-cli", billing: "plan", envKeys: [], enabled: true },
  ] }));
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify({ ledgerHome: "ledger", modelsFile: "models.json" }));
  const policy = resolvePolicy(root, { resolveExecutable: () => ({ found: false, file: "codex", prefix: [], searchedDirs: [] }) });
  assert.equal(policy.registry[0].enabled, true);
  assert.equal(policy.registry[0].skippedNotInstalled, undefined);
});

test("a machine with every CLI installed keeps every default seat", (t) => {
  const policy = resolvePolicy(repo(t), { resolveExecutable: (cmd) => ({ found: true, file: cmd, prefix: [], searchedDirs: [] }) });
  assert.deepEqual(policy.registry.filter((l) => l.enabled).map((l) => l.leg), ["opus", "sol", "astra"]);
});

function boundRecord(policy, executable) {
  const leg = policy.registry.find((l) => l.runner === "claude-cli");
  const hash = createHash("sha256").update(JSON.stringify(argsForLeg({ ...leg, id: "" }))).digest("hex");
  return { schemaVersion: 1, probeVersion: "test", measuredAt: new Date().toISOString(), enabledCliRunners: ["claude-cli"],
    cli: { "claude-cli": { executablePath: executable, executablePrefix: [], version: "fixture 1.0", argvShapeHash: hash, verdict: "PASS", why: "fixture" } },
    overall: { ok: true, verdict: "PASS", why: "fixture" } };
}

test("the first run takes the missing measurement itself instead of refusing", async (t) => {
  const root = repo(t);
  const policy = resolvePolicy(root, { resolveExecutable: onlyClaude });
  const executable = join(root, "claude.exe");
  const probeOptions = { resolveExecutable: () => ({ file: executable, prefix: [], found: true }),
    spawnVersion: () => ({ status: 0, stdout: "fixture 1.0\n", stderr: "" }) };
  let probes = 0;
  const logs = [];
  const probe = async (p) => {
    probes++;
    mkdirSync(dirname(p.probeRecord), { recursive: true });
    writeFileSync(p.probeRecord, `OVERALL: PASS\n\n\`\`\`json\n${JSON.stringify(boundRecord(p, executable))}\n\`\`\`\n`);
  };
  assert.equal(existsSync(policy.probeRecord), false);
  const gate = await admitPanel(policy, { probeOptions, probe, log: (m) => logs.push(m) });
  assert.equal(gate.ok, true, gate.why);
  assert.equal(probes, 1);
  assert.match(logs[0], /MISSING-RECORD/);
  const again = await admitPanel(policy, { probeOptions, probe, log: (m) => logs.push(m) });
  assert.equal(again.ok, true);
  assert.equal(probes, 1, "a bound PASS record is not re-measured");
});

test("a recorded FAIL is a verdict: the gate refuses and never re-probes over it", async (t) => {
  const root = repo(t);
  const policy = resolvePolicy(root, { resolveExecutable: onlyClaude });
  const executable = join(root, "claude.exe");
  const failed = { ...boundRecord(policy, executable), overall: { ok: false, verdict: "FAIL", why: "the guarded run leaked" } };
  mkdirSync(dirname(policy.probeRecord), { recursive: true });
  writeFileSync(policy.probeRecord, `OVERALL: FAIL\n\n\`\`\`json\n${JSON.stringify(failed)}\n\`\`\`\n`);
  let probes = 0;
  const gate = await admitPanel(policy, { probe: async () => { probes++; }, log: () => {} });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "PROBE-NOT-PASS");
  assert.equal(probes, 0);
});

test("a probe that crashes is reported as its own refusal, not as a pass", async (t) => {
  const policy = resolvePolicy(repo(t), { resolveExecutable: onlyClaude });
  const gate = await admitPanel(policy, { probe: async () => { throw new Error("boom"); }, log: () => {} });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "PROBE-FAILED");
  assert.match(gate.why, /boom/);
});
