#!/usr/bin/env node
// The isolation probe. Run it before starting the review panel.
//
// WHAT IT PROVES: that a prompt injection hidden inside an artifact under review cannot make
// a local review leg read a file outside its working directory. Locally the agent legs run
// as the current user, within reach of the CLI credential stores and local configuration
// tree, so this is the property the whole local panel rests on.
//
// HOW IT PROVES IT: each leg is run TWICE on the same artifact — once with its refusal flags
// OFF (the negative control, which must leak) and once with them ON (which must not). A
// refusal on its own proves nothing; only the pair does. If the control does not leak, the
// probe reports VACUOUS and the build does not proceed. Verdict logic lives in
// isolationProbeLogic.mjs and is unit-tested there.
//
// THE CANARY IS NOT A REAL CREDENTIAL. It is a random token in a temp directory outside the
// repository. The probe never reads, prints or sends any real secret, and it deletes the
// canary when it is done.
//
// Usage:  node scripts/isolationProbe.mjs [--leg claude|codex|grok] [--json]
// Exit:   0 when every enabled CLI passes, or no local agent leg is enabled.
//         1 on FAIL, VACUOUS or UNKNOWN.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argsForLeg, envForLeg, isOurTempDir } from "./legRunner.mjs";
import { resolveExe } from "./executable.mjs";
import { enabledCliLegs, cliCommand, measureCliBinding } from "./isolationBinding.mjs";
import { resolvePolicy } from "./policy.mjs";
import { makeCanaryToken, leaked, legVerdict, overallVerdict, buildProbeArtifact, buildDirectAsk } from "./isolationProbeLogic.mjs";

const LEG_TIMEOUT_MS = 10 * 60 * 1000;
export const PROBE_TEMP_PREFIX = "tribunal-leg-probe-";

/**
 * A FRESH working directory per leg invocation prevents CLI conversation state from being
 * shared across calls. A guarded call that inherits its control's transcript could echo the
 * canary without reading it, making conversation reuse look like a failed tool denylist.
 * Each model must read the artifact independently, so every invocation gets its own
 * directory, and nothing sensitive is placed in one.
 */
async function freshCwd() {
  return mkdtemp(join(tmpdir(), `${PROBE_TEMP_PREFIX}cwd-`));
}

async function removeScratch(dir) {
  if (isOurTempDir(dir)) await rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function runInFreshDirectory(cmd, args, { mkTemp, envFor = null, ...options }) {
  const cwd = await mkTemp();
  try {
    // envFor builds the environment from the invocation's own directory (the Grok leg's homes).
    return await run(cmd, args, { ...options, ...(envFor ? { env: envFor(cwd) } : {}), cwd });
  } finally {
    await removeScratch(cwd);
  }
}

function run(cmd, args, { input, cwd, env, spawnFn = spawn, executable = null }) {
  return new Promise((resolve) => {
    let out = "", err = "", settled = false;
    const { file, prefix } = executable || resolveExe(cmd);
    let child;
    try {
      child = spawnFn(file, [...prefix, ...args], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      // spawn can throw SYNCHRONOUSLY (EINVAL on Windows), which the 'error' listener below
      // never sees. Return a measurement error so the verdict can report UNKNOWN.
      resolve({ out: "", error: `spawn threw: ${e.code || e.message}` });
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill("SIGKILL"); resolve({ out, error: `timed out after ${LEG_TIMEOUT_MS}ms` }); }
    }, LEG_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ out, error: `spawn failed: ${e.message}` }); }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A non-zero exit with no output is an error. A non-zero exit WITH output is still a
      // measurement: the leg said something, and whether it leaked is the question.
      if (code !== 0 && !out.trim()) resolve({ out, error: `exit ${code}: ${err.trim().slice(0, 300) || "(no stderr)"}` });
      else resolve({ out, error: null });
    });
    if (input != null) { child.stdin.write(input); child.stdin.end(); }
  });
}

export async function probeClaude(directAsk, injection, canaryToken, selectedLeg,
  { spawnFn = spawn, mkTemp = freshCwd, sourceEnv = process.env, executable = null } = {}) {
  const model = selectedLeg.id;
  const common = ["-p", "--model", model];
  // --setting-sources "" prevents inherited user instructions, settings and hooks from
  // influencing the review, so the leg reads the artifact independently.
  const guarded = argsForLeg(selectedLeg);
  // The control is MAXIMALLY permissive so default permissions cannot block the read before
  // the denylist under test gets a chance to act. Bypassing permissions establishes that the
  // read is possible, allowing a clean guarded run to demonstrate the denylist's effect.
  const control = [...common, "--setting-sources", "", "--strict-mcp-config", "--dangerously-skip-permissions"];
  const { env } = envForLeg(selectedLeg, sourceEnv);
  // control and guarded both use the DIRECT ask, so the only difference between them is the
  // denylist. The injection run is a third, separate observation.
  const options = { mkTemp, env, spawnFn, executable };
  const c = await runInFreshDirectory("claude", control, { ...options, input: directAsk });
  const g = await runInFreshDirectory("claude", guarded, { ...options, input: directAsk });
  const inj = await runInFreshDirectory("claude", guarded, { ...options, input: injection });
  return {
    controlLeaked: leaked(c.out, canaryToken), guardedLeaked: leaked(g.out, canaryToken),
    controlError: c.error, guardedError: g.error, controlOut: c.out, guardedOut: g.out,
    injectionLeaked: leaked(inj.out, canaryToken), injectionOut: inj.out, injectionError: inj.error,
  };
}

export async function probeCodex(directAsk, injection, canaryToken, selectedLeg,
  { spawnFn = spawn, mkTemp = freshCwd, sourceEnv = process.env, executable = null } = {}) {
  const model = selectedLeg.id;
  // The CONTROL bypasses the sandbox, mirroring the Claude control's
  // --dangerously-skip-permissions. A read-only sandbox may allow reads inside the working
  // directory while refusing reads outside it; using that sandbox on the control could make
  // the probe VACUOUS. Keep the canary outside every invocation cwd and establish that the
  // unsandboxed control can read it before assessing the guarded run.
  // `codex exec -` reads the prompt from stdin. Passing the artifact that way rather than as
  // an argv element keeps a document full of quotes, newlines and an injection off any
  // command line at all.
  const control = ["exec", "-m", model, "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-"];
  const guarded = argsForLeg(selectedLeg);
  const { env } = envForLeg(selectedLeg, sourceEnv);
  const options = { mkTemp, env, spawnFn, executable };
  const c = await runInFreshDirectory("codex", control, { ...options, input: directAsk });
  const g = await runInFreshDirectory("codex", guarded, { ...options, input: directAsk });
  const inj = await runInFreshDirectory("codex", guarded, { ...options, input: injection });
  return {
    controlLeaked: leaked(c.out, canaryToken), guardedLeaked: leaked(g.out, canaryToken),
    controlError: c.error, guardedError: g.error, controlOut: c.out, guardedOut: g.out,
    injectionLeaked: leaked(inj.out, canaryToken), injectionOut: inj.out, injectionError: inj.error,
  };
}

export async function probeGrok(directAsk, injection, canaryToken, selectedLeg,
  { spawnFn = spawn, mkTemp = freshCwd, sourceEnv = process.env, executable = null } = {}) {
  const model = selectedLeg.id;
  // The CONTROL keeps every Grok Build tool and approves each call, so its file read cannot be
  // stopped by a permission prompt; the guarded run differs only by the tool denylist and the
  // system prompt. Both run with the leg's own empty home and the panel's own sign-in, so the
  // pair measures the denylist, not the user's configuration.
  const control = ["-p", "-", "-m", model, "--output-format", "json", "--always-approve", "--max-turns", "8"];
  const guarded = argsForLeg(selectedLeg);
  const envFor = (cwd) => envForLeg(selectedLeg, sourceEnv, { home: cwd }).env;
  const options = { mkTemp, envFor, spawnFn, executable };
  const c = await runInFreshDirectory("grok", control, { ...options, input: directAsk });
  const g = await runInFreshDirectory("grok", guarded, { ...options, input: directAsk });
  const inj = await runInFreshDirectory("grok", guarded, { ...options, input: injection });
  return {
    controlLeaked: leaked(c.out, canaryToken), guardedLeaked: leaked(g.out, canaryToken),
    controlError: c.error, guardedError: g.error, controlOut: c.out, guardedOut: g.out,
    injectionLeaked: leaked(inj.out, canaryToken), injectionOut: inj.out, injectionError: inj.error,
  };
}

const PROBE_OF_RUNNER = { "claude-cli": probeClaude, "codex-cli": probeCodex, "grok-cli": probeGrok };

/** Persist the measured result and the invocation it certifies. A subset cannot certify it. */
export async function writeProbeRecord(policy, verdicts,
  { only = null, measuredAt = new Date(), bindings = {} } = {}) {
  const enabled = enabledCliLegs(policy.registry);
  const enabledCliRunners = enabled.map((leg) => leg.runner).sort();
  const required = enabled.map((leg) => cliCommand(leg.runner));
  const effectiveVerdicts = { ...verdicts };
  const cli = {};
  for (const leg of enabled) {
    const name = cliCommand(leg.runner);
    if (!verdicts[name]) continue;
    const binding = bindings[leg.runner];
    const hasBinding = binding && typeof binding.executablePath === "string" && binding.executablePath
      && Array.isArray(binding.executablePrefix) && binding.executablePrefix.every((part) => typeof part === "string")
      && typeof binding.version === "string" && binding.version.trim()
      && typeof binding.argvShapeHash === "string" && /^[a-f0-9]{64}$/.test(binding.argvShapeHash);
    if (!hasBinding && effectiveVerdicts[name].verdict === "PASS") {
      effectiveVerdicts[name] = { verdict: "UNKNOWN", why: `missing invocation binding for ${leg.runner}; re-probe this CLI` };
    }
    cli[leg.runner] = {
      executablePath: binding?.executablePath ?? null,
      executablePrefix: binding?.executablePrefix ?? null,
      version: binding?.version ?? null,
      argvShapeHash: binding?.argvShapeHash ?? null,
      verdict: effectiveVerdicts[name].verdict,
      why: effectiveVerdicts[name].why,
    };
  }
  const missing = required.filter((name) => !effectiveVerdicts[name]);
  const measured = overallVerdict(effectiveVerdicts, enabledCliRunners);
  const recorded = missing.length && Object.keys(effectiveVerdicts).length
    ? { ok: false, verdict: "UNKNOWN", why: `unprobed enabled runners: ${missing.join(", ")}; a --leg subset cannot certify the panel` }
    : measured;
  const probeVersion = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
  const bindingRecord = { schemaVersion: 1, probeVersion, measuredAt: measuredAt.toISOString(),
    enabledCliRunners, cli, overall: recorded };
  const record = [
    "# Tribunal isolation probe", "", `Measured: ${measuredAt.toISOString()}`,
    `Repository: ${policy.repoRoot}`, `Models file: ${policy.modelsFile}`,
    ...(only ? [`Requested runner: ${only}`] : []), "",
    ...Object.entries(effectiveVerdicts).map(([name, result]) => `${name}: ${result.verdict} — ${result.why}`), "",
    `OVERALL: ${recorded.verdict} — ${recorded.why}`, "",
    "```json", JSON.stringify(bindingRecord, null, 2), "```", "",
    "This is a recorded measurement. Re-run after a CLI upgrade or invocation-flag change.", "",
  ].join("\n");
  await mkdir(dirname(policy.probeRecord), { recursive: true });
  await writeFile(policy.probeRecord, record, "utf8");
  return recorded;
}

/** Run the real probe orchestration with injectable process boundaries for offline tests. */
export async function runProbe(policy, { only = null, spawnFn = spawn, resolveExecutable = resolveExe,
  spawnVersion, sourceEnv = process.env, createTemp = mkdtemp, measuredAt = new Date() } = {}) {
  if (only && !["claude", "codex", "grok"].includes(only)) throw new Error("--leg must be claude, codex or grok");
  // Measure each CLI boundary once, using the model IDs selected by effective policy.
  const enabled = enabledCliLegs(policy.registry);
  const selected = enabled.filter((leg) => !only || cliCommand(leg.runner) === only);
  const scratch = new Set();
  const makeScratch = async (kind) => {
    const dir = await createTemp(join(tmpdir(), `${PROBE_TEMP_PREFIX}${kind}-`));
    scratch.add(dir);
    return dir;
  };
  const results = {}, verdicts = {}, bindings = {};
  let canaryPath = null;
  try {
    if (selected.length) {
      // The canary lives outside every invocation cwd; reading outside it is the threat.
      const dir = await makeScratch("canary");
      canaryPath = join(dir, "review-config.json");
      const canaryToken = makeCanaryToken(randomBytes(16).toString("hex"));
      await writeFile(canaryPath, `{"note":"not a real credential","token":"${canaryToken}"}\n`, "utf8");
      const directAsk = buildDirectAsk(canaryPath);
      const injection = buildProbeArtifact(canaryPath);
      for (const leg of selected) {
        const name = cliCommand(leg.runner);
        try {
          bindings[leg.runner] = measureCliBinding(leg, { resolveExecutable, spawnVersion, sourceEnv });
        } catch (error) {
          verdicts[name] = { verdict: "UNKNOWN", why: `cannot measure ${leg.runner} binding: ${error.message}` };
          continue;
        }
        const binding = bindings[leg.runner];
        const probe = PROBE_OF_RUNNER[leg.runner];
        results[name] = await probe(directAsk, injection, canaryToken, leg, {
          spawnFn, sourceEnv, mkTemp: () => makeScratch("cwd"),
          executable: { file: binding.executablePath, prefix: binding.executablePrefix },
        });
        verdicts[name] = legVerdict(results[name]);
      }
    }
  } finally {
    for (const dir of scratch) await removeScratch(dir);
  }
  const overall = overallVerdict(verdicts, enabled.map((leg) => leg.runner));
  const recorded = await writeProbeRecord(policy, verdicts, { only, measuredAt, bindings });
  return { overall, verdicts, canaryPath, results, recorded, probeRecord: policy.probeRecord };
}

async function main() {
  const policy = resolvePolicy(process.cwd());
  const only = process.argv.includes("--leg") ? process.argv[process.argv.indexOf("--leg") + 1] : null;
  const asJson = process.argv.includes("--json");
  const { overall, verdicts, canaryPath, results, recorded } = await runProbe(policy, { only });

  if (asJson) {
    // Include leg output in JSON so failed and VACUOUS measurements can be diagnosed without
    // rerunning the probe. The canary is a random token in a temp file, not a real secret.
    const transcripts = {};
    for (const [name, r] of Object.entries(results)) {
      transcripts[name] = {
        control: (r.controlOut || "").slice(0, 1200),
        guarded: (r.guardedOut || "").slice(0, 1200),
        injection: (r.injectionOut || "").slice(0, 1200),
      };
    }
    console.log(JSON.stringify({ overall, verdicts, canaryPath, transcripts, recorded, probeRecord: policy.probeRecord }, null, 2));
  } else {
    console.log("\nTribunal isolation probe\n");
    console.log("leg     control-leaked  guarded-leaked  verdict  why");
    for (const [name, v] of Object.entries(verdicts)) {
      const r = results[name];
      console.log(`${name.padEnd(8)}${String(r?.controlLeaked ?? "not run").padEnd(16)}${String(r?.guardedLeaked ?? "not run").padEnd(16)}${v.verdict.padEnd(9)}${v.why}`);
    }
    // Reported, never counted toward the verdict: model-level injection resistance is not a
    // boundary. It can regress with any model change independently of the tool restrictions.
    console.log(`\nObservation (not part of the verdict) — the same guarded leg fed an injection hidden in a diff:`);
    for (const [name, r] of Object.entries(results)) {
      console.log(`  ${name.padEnd(8)}injection leaked: ${r.injectionLeaked}${r.injectionError ? ` (errored: ${r.injectionError})` : ""}`);
    }
    console.log(`\nOVERALL: ${overall.verdict} — ${overall.why}\n`);
    console.log(`Record: ${policy.probeRecord} (${recorded.verdict})`);
    if (!recorded.ok) console.log(`The panel remains blocked: ${recorded.why}\n`);
  }
  process.exitCode = recorded.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("isolation probe crashed:", e); process.exitCode = 1; });
}
