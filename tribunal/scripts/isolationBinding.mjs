// Shared by the probe and its admission gate: certify the same executable and argv
// that legRunner uses, with model selection excluded from the boundary's shape.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { argsForLeg, envForLeg, GROK_FIXED_ENV, GROK_HOME_VARS } from "./legRunner.mjs";
import { resolveExe } from "./executable.mjs";

const CLI_COMMANDS = { "claude-cli": "claude", "codex-cli": "codex", "grok-cli": "grok" };

export function cliCommand(runner) {
  return Object.hasOwn(CLI_COMMANDS, runner) ? CLI_COMMANDS[runner] : null;
}

/** One representative per enabled CLI type, from effective policy, not credential availability. */
export function enabledCliLegs(registry) {
  const byRunner = new Map();
  for (const leg of registry) {
    if (leg.enabled && cliCommand(leg.runner) && !byRunner.has(leg.runner)) byRunner.set(leg.runner, leg);
  }
  return [...byRunner.values()].sort((a, b) => a.runner.localeCompare(b.runner));
}

export function argvShapeHash(leg) {
  // The Grok leg's isolation rests on its environment as much as its argv (redirected homes, fixed
  // switches), so a change to either invalidates a recorded PASS. Other runners hash argv only.
  const shape = leg.runner === "grok-cli"
    ? { argv: argsForLeg({ ...leg, id: "" }), env: GROK_FIXED_ENV, homes: GROK_HOME_VARS }
    : argsForLeg({ ...leg, id: "" });
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

/** --version is bounded and never invokes a model. Failed/empty output is no measurement. */
export function measureCliBinding(leg, { resolveExecutable = resolveExe,
  spawnVersion = spawnSync, sourceEnv = process.env } = {}) {
  const command = cliCommand(leg.runner);
  if (!command) throw new Error(`no CLI binding for ${leg.runner}`);
  // Match legRunner's resolution seam. On Windows file may be node.exe; the prefix
  // identifies the actual npm CLI entrypoint and is part of the executable binding.
  const executable = resolveExecutable(command);
  if (!executable.found) throw new Error(`${leg.runner} executable not found: ${command}`);
  const { file, prefix } = executable;
  let result;
  try {
    result = spawnVersion(file, [...prefix, "--version"], {
      env: envForLeg(leg, sourceEnv).env, shell: false, encoding: "utf8",
      timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
  } catch (error) {
    throw new Error(`${leg.runner} version could not be measured: ${error.message}`);
  }
  if (result.error || result.status !== 0) {
    throw new Error(`${leg.runner} version could not be measured: ${result.error?.message || `exit ${result.status}: ${result.stderr?.trim() || "no stderr"}`}`);
  }
  const version = (result.stdout?.trim() || result.stderr?.trim() || "");
  if (!version) throw new Error(`${leg.runner} version could not be measured: empty --version output`);
  return { executablePath: file, executablePrefix: [...prefix], version, argvShapeHash: argvShapeHash(leg) };
}
