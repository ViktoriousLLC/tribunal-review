// Validate model rows so a typo cannot disable a reviewer or expose a credential.
//
// One registry row defines each leg, including fallback models visible to freshness checks.
// A typo can quietly disable a leg or hand a credential to the wrong process, so the loader
// validates every row before dispatch.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openaiApiEnvironment, openaiApiRowProblems } from "./openaiApi.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = join(HERE, "models.default.json");

const RUNNERS = new Set(["claude-cli", "codex-cli", "grok-cli", "genai-sdk", "openai-api"]);
const BILLING = new Set(["plan", "metered"]);

/**
 * Credentials that must NEVER be handed to a leg that runs an agent CLI.
 *
 * The agent runners read untrusted input and can hold a shell if their refusal flags
 * fail, so a spend-capable key in their environment is one prompt injection away from being
 * someone else's. Plain SDK/API legs have no tools; the compatible API runner additionally
 * requires the key's name and destination origin to be bound in the user's trust file.
 */
const AGENT_RUNNERS = new Set(["claude-cli", "codex-cli", "grok-cli"]);
const SPEND_KEYS = new Set(["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY"]);

/** A trial seat's last day, as YYYY-MM-DD. The seat runs through that UTC day and is off after it. */
export const UNTIL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD that names a real calendar day. Date.parse alone rolls 2026-02-31 to 03-03. */
function realDay(day) {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

/** Has this seat's `until` day passed? A seat with no `until` never expires. */
export function seatExpired(leg, now = new Date()) {
  if (!leg || leg.until === undefined) return false;
  return !(now.getTime() < Date.parse(`${leg.until}T00:00:00Z`) + 86_400_000);
}

export function validateLegs(legs) {
  const problems = [];
  if (!Array.isArray(legs) || legs.length === 0) return ["models.default.json has no legs array"];
  const seen = new Set();
  const seenIds = new Set();
  for (const [i, l] of legs.entries()) {
    const at = `leg[${i}]${l && l.leg ? ` (${l.leg})` : ""}`;
    if (!l || typeof l !== "object") { problems.push(`${at} is not an object`); continue; }
    if (!l.leg || typeof l.leg !== "string") problems.push(`${at} has no leg name`);
    else if (seen.has(l.leg)) problems.push(`${at} duplicates an earlier leg name`);
    else seen.add(l.leg);
    if (!l.id || typeof l.id !== "string") problems.push(`${at} has no model id`);
    // Different leg names must select different models. Duplicate model IDs reduce review
    // diversity and attribute one model's findings to multiple seats; row shape checks
    // cannot catch this because each individual row can be valid.
    else if (seenIds.has(l.id)) problems.push(`${at} runs "${l.id}", which another leg already runs; a panel of N names must be N models or it is not cross-model`);
    else seenIds.add(l.id);
    if (!RUNNERS.has(l.runner)) problems.push(`${at} has runner "${l.runner}", expected one of ${[...RUNNERS].join(", ")}`);
    if (!BILLING.has(l.billing)) problems.push(`${at} has billing "${l.billing}", expected plan or metered`);
    if (!Array.isArray(l.envKeys)) problems.push(`${at} has no envKeys array`);
    if (typeof l.enabled !== "boolean") problems.push(`${at} has no boolean enabled`);
    if (l.runner === "openai-api") problems.push(...openaiApiRowProblems(l).map((problem) => `${at} ${problem}`));
    // An ADVISORY seat reports findings that never count: it cannot make a round partial, quiet
    // or blocked. A trial seat is advisory so a new model is heard before it can hold a merge.
    if (l.advisory !== undefined && typeof l.advisory !== "boolean") problems.push(`${at} has a non-boolean advisory`);
    if (l.until !== undefined && !(typeof l.until === "string" && UNTIL_PATTERN.test(l.until)
      && realDay(l.until))) problems.push(`${at} has until "${l.until}", expected a real YYYY-MM-DD date`);
    // 6/7: a Grok seat's ONLY variable is its panel home. The denylist of spend keys cannot list
    // every name a future Grok build might read a key from, so this runner gets an allowlist.
    if (l.runner === "grok-cli" && !(Array.isArray(l.envKeys) && l.envKeys.length === 1 && l.envKeys[0] === "GROK_HOME")) {
      problems.push(`${at} is a grok-cli seat; its envKeys must be exactly ["GROK_HOME"]`);
    }

    // The two invariants that are about safety rather than shape.
    if (Array.isArray(l.envKeys) && AGENT_RUNNERS.has(l.runner)) {
      for (const k of l.envKeys) {
        if (SPEND_KEYS.has(k)) problems.push(`${at} is an agent runner and would receive ${k}; a spend-capable key never goes to a leg that reads untrusted input`);
      }
    }
    if (l.billing === "plan" && Array.isArray(l.envKeys) && l.envKeys.some((k) => SPEND_KEYS.has(k))) {
      problems.push(`${at} claims billing "plan" while holding ${l.envKeys.filter((k) => SPEND_KEYS.has(k)).join(", ")}; that claim has to be structural, not a promise`);
    }
    // An SDK leg has no credential store of its own: every envKey it names IS its credential,
    // so each one must also be in requiredEnv or a keyless checkout dispatches it, the runner
    // reports it LOST, and the round is PARTIAL forever — the trap runnableLegs exists to
    // close. Agent runners are exempt because their CLIs can authenticate from their own
    // stores without environment credentials.
    if (l.runner === "genai-sdk" && Array.isArray(l.envKeys)) {
      for (const k of l.envKeys) {
        if (!(Array.isArray(l.requiredEnv) && l.requiredEnv.includes(k))) {
          problems.push(`${at} is an SDK leg whose envKey ${k} is missing from requiredEnv; keyless checkouts would dispatch it as a lost leg`);
        }
      }
    }
  }
  return problems;
}

/** Load and validate. Throws rather than returning a half-valid panel: a leg silently missing
 *  from a review is the exact failure that makes a quiet round unreadable. */
export function loadRegistry(path = REGISTRY_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const legs = raw.legs;
  const problems = validateLegs(legs);
  if (problems.length) throw new Error(`models.default.json is invalid:\n  - ${problems.join("\n  - ")}`);
  return legs;
}

/** The legs that will actually run. A disabled leg is still returned by loadRegistry so the
 *  panel can NAME it as absent; silence about a leg is what this whole tool argues against. */
export function enabledLegs(legs) {
  return legs.filter((l) => l.enabled);
}

/** Partition the ENABLED legs by whether their requiredEnv actually exists on this machine.
 *
 *  An enabled leg whose credential is absent HERE must not be dispatched: dispatching it
 *  reports the leg as LOST, a lost leg makes the round PARTIAL, and PARTIAL blocks the loop
 *  forever — so configuring `enabled: true` for a leg whose key is available on only
 *  one machine must not dispatch a request from another machine without that variable.
 *  It must not be silent either; the caller names it beside the disabled legs, with the
 *  absent variable spelled out. Credentials come only from the invoking process environment. On a machine
 *  that holds the key the leg runs normally, and a mid-run failure there is still LOST. */
export function runnableLegs(legs, env = process.env) {
  const run = [];
  const credentialAbsent = [];
  const trustRefused = [];
  for (const l of enabledLegs(legs)) {
    // A copied compatible row must not even read its named variable until the user's fixed
    // home trust file authorizes the destination. Keep this before ordinary credential admission.
    const admission = l.runner === "openai-api" ? openaiApiEnvironment(l, env) : null;
    if (admission?.refusal) { trustRefused.push({ leg: l, reason: admission.refusal }); continue; }
    const missing = admission ? admission.missing : (l.requiredEnv || []).filter((k) => !env[k]);
    if (missing.length) credentialAbsent.push({ leg: l, missing });
    else run.push(l);
  }
  return { run, credentialAbsent, ...(trustRefused.length ? { trustRefused } : {}) };
}

/**
 * Every rung a METERED leg could run that has no price pin, as one message per gap.
 *
 * A metered call without a pin banks its usage UNPRICED. Updating a model ID without
 * adding its pricesUSDPer1M entry must be detectable: missing prices do not establish
 * zero spend, even when usage counts are available.
 *
 * MISSING ONLY, NOT EXPIRED, deliberately. Expiry already has a designed path (legRunner.mjs
 * treats a pin past its `until` as no pin and banks null), and a build that fails on a calendar
 * date would block unrelated changes. Missing pins are configuration gaps that this
 * guard reports separately from expiry.
 *
 * BOTH RUNGS, not just `id`: the fallback runs on the bad day, when nobody is reading the ledger.
 */
export function meteredPinGaps(legs) {
  const gaps = [];
  for (const l of (legs || []).filter((x) => x && x.billing === "metered")) {
    const pins = l.pricesUSDPer1M || {};
    for (const rung of [l.id, l.fallback].filter(Boolean)) {
      if (!Object.prototype.hasOwnProperty.call(pins, rung)) gaps.push(`${l.leg}: ${rung} has no price pin`);
    }
  }
  return gaps;
}

/** Every model id the panel can reach, primaries and fallbacks, for the freshness check.
 *  Fallback rungs are included precisely because they are the ones nothing exercises and so
 *  the ones most likely to have rotted. */
export function allPinnedIds(legs) {
  const ids = [];
  for (const l of legs) {
    ids.push({ leg: l.leg, id: l.id, vendor: l.vendor, role: "primary" });
    if (l.fallback) ids.push({ leg: l.leg, id: l.fallback, vendor: l.vendor, role: "fallback" });
  }
  return ids;
}

/** Legs whose probation has run out and that have earned nothing. Returns advice without
 *  changing the registry; dropping a leg requires an operator's configuration change. */
export function probationDue(legs, soleFindsByLeg = {}) {
  return legs
    .filter((l) => l.probation && (l.probation.runsRemaining ?? 0) <= 0)
    .filter((l) => (soleFindsByLeg[l.leg] ?? 0) === 0)
    .map((l) => ({ leg: l.leg, why: l.probation.why }));
}
