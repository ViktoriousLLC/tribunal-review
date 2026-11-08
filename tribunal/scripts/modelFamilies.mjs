// Resolve families from the installed CLI's own model list, without a network request.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveExe } from "./executable.mjs";

const versionParts = (value) => typeof value === "string" && /^\d+(?:\.\d+)*$/.test(value)
  ? value.split(".").map(BigInt) : null;

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0n, right = b[i] ?? 0n;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

/** A failed version probe must never authorize a newer cached model. */
export function codexCliVersion(spawnSyncFn = spawnSync) {
  try {
    const { file, prefix } = resolveExe("codex");
    const result = spawnSyncFn(file, [...prefix, "--version"], {
      shell: false, encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    return /^codex-cli\s+(\d+(?:\.\d+)+)\s*$/.exec(result.stdout?.trim())?.[1] ?? null;
  } catch { return null; }
}

/** Return fresh rows; failures retain the configured pin and explain why. */
export function resolveCodexFamilies(registry, { readFile = readFileSync,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), codexVersion = null } = {}) {
  let cache = null, cacheProblem = null;
  if (registry.some((leg) => leg.runner === "codex-cli")) {
    try {
      cache = JSON.parse(readFile(join(codexHome, "models_cache.json"), "utf8"));
      if (!cache || !Array.isArray(cache.models)) throw new Error("invalid model list");
    } catch { cache = null; cacheProblem = "Codex model list unavailable or invalid"; }
  }
  // Two seats must never resolve onto one model. Every enabled seat's pin is reserved up front;
  // a family seat takes the newest model no OTHER seat holds, releasing its own pin when it moves.
  const taken = new Map(registry.filter((leg) => leg.enabled).map((leg) => [leg.id, leg.leg]));
  return registry.map((original) => {
    const leg = { ...original };
    if (leg.runner === "codex-cli" && leg.family) {
      let problem = cacheProblem;
      if (!problem) {
        const candidates = cache.models.flatMap((model) => {
          const match = typeof model?.slug === "string" && /^gpt-(\d+(?:\.\d+)*)-([a-z0-9-]+)$/.exec(model.slug);
          return match && match[2] === leg.family && model.visibility !== "hide"
            ? [{ model, version: versionParts(match[1]) }] : [];
        }).sort((a, b) => compareVersions(b.version, a.version));
        const newest = candidates[0]?.model.slug;
        const installed = versionParts(codexVersion), listed = versionParts(cache.client_version);
        if (!newest) problem = `No visible Codex model in family ${leg.family}`;
        else if (!installed || !listed) problem = "Codex CLI or model-list version unreadable";
        else if (compareVersions(installed, listed) < 0) {
          if (newest !== leg.id) leg.notice = `Codex CLI ${codexVersion} is older than its model list (${cache.client_version}); ${newest} is available after upgrading Codex (npm i -g @openai/codex). Using ${leg.id}.`;
        } else {
          const free = (slug) => !leg.enabled || !taken.has(slug) || taken.get(slug) === leg.leg;
          const pick = candidates.map((c) => c.model.slug).find(free);
          if (pick && pick !== newest) {
            leg.notice = `${newest} is already the ${taken.get(newest)} seat's model; using ${pick} so the seats stay separate models.`;
          }
          if (pick && pick !== leg.id) {
            if (leg.enabled) { taken.delete(leg.id); taken.set(pick, leg.leg); }
            leg.pinnedId = leg.id;
            leg.id = pick;
            leg.resolvedFrom = "family";
          }
        }
      }
      if (problem) leg.notice = `${problem}; using ${leg.id}.`;
    }
    const modelDefault = leg.runner === "codex-cli"
      ? cache?.models.find((model) => model?.slug === leg.id)?.default_reasoning_level : null;
    leg.effortShown = leg.effort ? `${leg.effort} (set)`
      : typeof modelDefault === "string" && modelDefault ? `${modelDefault} (model default)` : "model default";
    return leg;
  });
}

/**
 * The effort a Claude model runs at when none is sent. The Claude CLI does not report the level it
 * used, so this is the documented default (code.claude.com/docs/en/model-config, "Adjust effort
 * level", read 2026-10-19): high on every model that supports effort, except the 5.5 Opus, Sonnet
 * and Haiku models (medium) and Opus 4.7 (xhigh). A model not listed here is shown as not reported
 * rather than guessed, so a new model is never labelled with an old model's default. The label is
 * the level that runs, not just a doc quote: the CLI's precedence is env var, then --effort, then
 * settings, then the model default, and a seat gets none of the first three (its env is an
 * allowlist without CLAUDE_CODE_EFFORT_LEVEL, and it runs with --setting-sources "").
 */
export const CLAUDE_DEFAULT_EFFORT = Object.freeze({
  "claude-opus-5-5": "medium",
  "claude-sonnet-5-5": "medium",
  "claude-haiku-5-5": "medium",
  "claude-opus-4-7": "xhigh",
  "claude-fable-5-1": "high",
  "claude-fable-5": "high",
  "claude-opus-5": "high",
});

/** The effort label for a Claude result, once the answering model is known. */
export function claudeEffortShown(model, effort = null) {
  if (effort) return `${effort} (set)`;
  const level = Object.hasOwn(CLAUDE_DEFAULT_EFFORT, model) ? CLAUDE_DEFAULT_EFFORT[model] : null;
  return level ? `${level} (model default)` : "model default (level not reported)";
}
