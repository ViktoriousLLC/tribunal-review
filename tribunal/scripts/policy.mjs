// The plugin's single configuration seam. Configuration contains paths, names, and gate switches, never secrets.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "./registry.mjs";
import { resolveExe } from "./executable.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESETS = ["claude-only", "claude-plus-chatgpt", "claude-plus-api-keys"];
const CLI_OF_RUNNER = { "claude-cli": "claude", "codex-cli": "codex" };

/**
 * Seats whose CLI is not installed on this machine are skipped, not failed.
 *
 * The default registry enables the Claude and the Codex seats, so a machine with only the
 * Claude CLI would otherwise spawn two Codex legs that cannot start, and every round would be
 * PARTIAL forever. With no configuration at all the panel now runs on whatever is installed and
 * says which seats it skipped. Two things are explicit opt-ins that keep an absent CLI a loud
 * failure, because the user asked for that seat: naming it in `enabledLegs`, choosing a
 * `preset`, or supplying a custom `modelsFile` (a chosen registry is a deliberate list, not a
 * default).
 */
function skipUninstalledSeats(registry, { enabledLegs, customRegistry, resolveExecutable }) {
  if (customRegistry) return registry;
  return registry.map((leg) => {
    const cli = Object.prototype.hasOwnProperty.call(CLI_OF_RUNNER, leg.runner) ? CLI_OF_RUNNER[leg.runner] : null;
    if (!cli || !leg.enabled || enabledLegs.includes(leg.leg) || resolveExecutable(cli).found) return leg;
    return { ...leg, enabled: false, skippedNotInstalled: true,
      disabledReason: `${cli} CLI is not installed on this machine, so this seat is skipped. Install it, or name the seat in enabledLegs to make its absence an error.` };
  });
}

export function resolvePolicy(cwd = process.cwd(), { resolveExecutable = resolveExe } = {}) {
  const workingDirectory = resolve(cwd);
  let repoRoot = workingDirectory;
  for (let candidate = workingDirectory; ; candidate = dirname(candidate)) {
    // A worktree's .git file identifies its root just as a normal .git directory does.
    if (existsSync(join(candidate, ".git"))) { repoRoot = candidate; break; }
    if (dirname(candidate) === candidate) break;
  }
  const configFile = join(repoRoot, "tribunal.config.json");
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("tribunal.config.json must be an object");
  const allowed = new Set(["preset", "modelsFile", "reviewerPromptPath", "ledgerHome", "goalsDir", "enabledLegs", "disabledLegs", "envFile", "gates"]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new Error(`unsupported tribunal.config.json field: ${key}; configure paths, leg names, and gate switches only, never credentials`);
  }
  for (const key of ["modelsFile", "reviewerPromptPath", "ledgerHome", "goalsDir", "envFile"]) {
    if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key].trim())) throw new Error(`${key} must be a nonempty path`);
  }
  if (config.preset !== undefined && !PRESETS.includes(config.preset)) {
    throw new Error(`preset must be one of: ${PRESETS.join(", ")}`);
  }
  for (const key of ["enabledLegs", "disabledLegs"]) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].some((leg) => typeof leg !== "string" || !leg))) throw new Error(`${key} must be an array of leg names`);
  }
  const gates = { goalWall: true, mergeGate: true };
  if (config.gates !== undefined) {
    if (!config.gates || Array.isArray(config.gates) || typeof config.gates !== "object") throw new Error("gates must be an object");
    for (const [key, value] of Object.entries(config.gates)) {
      if (!Object.hasOwn(gates, key)) throw new Error(`unsupported tribunal.config.json gates field: ${key}`);
      if (typeof value !== "boolean") throw new Error(`gates.${key} must be a boolean`);
      gates[key] = value;
    }
  }
  const repoSlug = `${basename(repoRoot) || "root"}-${createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)}`;
  const pathValue = (name, fallback) => config[name] === undefined ? fallback : resolve(repoRoot, config[name]);
  const modelsFile = pathValue("modelsFile", config.preset
    ? join(HERE, "presets", `${config.preset}.json`)
    : join(HERE, "models.default.json"));
  const reviewerPromptPath = pathValue("reviewerPromptPath", join(HERE, "prompts", "reviewer-default.md"));
  const ledgerHome = pathValue("ledgerHome", join(homedir(), ".tribunal", repoSlug));
  const goalsDir = pathValue("goalsDir", join(repoRoot, "docs", "reference", "goals"));
  const envFile = config.envFile === undefined ? null : resolve(repoRoot, config.envFile);
  // A repo may keep leg credentials in a gitignored env file (the config names a PATH, never a
  // secret). Variables load only when unset so the existing environment takes precedence;
  // a keyless checkout still runs with that leg as a named not-run.
  if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith("#") || process.env[m[1]]) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const enabledLegs = config.enabledLegs || [];
  const disabledLegs = config.disabledLegs || [];
  const registry = skipUninstalledSeats(loadRegistry(modelsFile).map((leg) => ({
    ...leg,
    enabled: disabledLegs.includes(leg.leg) ? false : enabledLegs.includes(leg.leg) ? true : leg.enabled,
  })), { enabledLegs, customRegistry: config.modelsFile !== undefined || config.preset !== undefined, resolveExecutable });
  for (const leg of [...enabledLegs, ...disabledLegs]) {
    if (!registry.some((entry) => entry.leg === leg)) throw new Error(`unknown configured leg: ${leg}`);
  }
  return { repoRoot, repoSlug, configFile, modelsFile, reviewerPromptPath, ledgerHome, goalsDir, envFile, gates,
    probeRecord: join(ledgerHome, "isolation-probe.md"), enabledLegs, disabledLegs, registry };
}
