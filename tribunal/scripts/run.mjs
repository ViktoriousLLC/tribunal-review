#!/usr/bin/env node
// Local review accepts goals, files and text without requiring a throwaway PR.
//
// Normalize PRs, files and pasted text into the same artifact shape so the panel can review
// goal statements, plans and reports through the same path as code changes.
//
// Usage:
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" --file goals/x.md
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" --pr 123 [--post-proof]
//   echo "some text" | node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" --stdin --title "Q3 report"
//   ... --json --out <path> [--override "reason"]
//
// Exit: 0 only for a successfully banked QUIET round (or --print-policy); 1 for other
// outcomes. Refusals: 2 unchanged QUIET, 3 row ceiling, 4 arguments, 5 probe, 6 active lock.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync as readdirNative, openSync, closeSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runnableLegs } from "./registry.mjs";
import { isRecordableRound } from "./panelLogic.mjs";

/** Require enough independent reviewers for a local PR review proof. */
const MIN_PROOF_LEGS = 3;
import { runLeg, classifyLegOutcome } from "./legRunner.mjs";
import { fromFile, fromText, fromPr, buildUserMessage, GH_MISSING_MESSAGE } from "./artifact.mjs";
import { clusterFindings, summariseRound, loopDecision, soleFindsByLeg, trendLine } from "./panelLogic.mjs";
import { render } from "./render.mjs";
import { resolvePolicy } from "./policy.mjs";
import { cliCommand, enabledCliLegs, measureCliBinding } from "./isolationBinding.mjs";
import { runProbe } from "./isolationProbe.mjs";

/**
 * Gate reasons a fresh probe can answer. A record that is missing, older than the binding
 * format, or bound to a CLI that has since changed is not a verdict about safety, it is a
 * measurement that has not been taken yet; the first run takes it instead of refusing.
 * A record that says the boundary FAILED is a verdict, and the user must see it.
 */
const REPROBE_REASONS = new Set([
  "MISSING-RECORD", "PREDATES-BINDING", "INVALID-BINDING", "UNMEASURED-RUNNER",
  "EXECUTABLE-PATH-CHANGED", "EXECUTABLE-PREFIX-CHANGED", "CLI-VERSION-CHANGED", "ARGV-SHAPE-CHANGED",
]);

/** Admit a panel: read the gate, take the missing measurement if that is all it needs, read again. */
export async function admitPanel(policy, { probeOptions = {}, probe = runProbe, log = console.error } = {}) {
  const gate = isolationGate(policy, probeOptions);
  if (gate.ok || !probe || !REPROBE_REASONS.has(gate.reason)) return gate;
  log(`[probe] ${gate.reason}: measuring the reviewer boundary before the first review (real CLI calls, about a minute)...`);
  try { await probe(policy); }
  catch (error) { return { ok: false, reason: "PROBE-FAILED", why: `the isolation probe could not run: ${error.message}` }; }
  return isolationGate(policy, probeOptions);
}

/**
 * What this round actually cost, per provider.
 *
 * Plan-covered legs are $0 because the process is structurally incapable of billing. A metered
 * leg that reported no usage is "not reported", NEVER 0.
 */
function meteredSummary(results, registry) {
  const byLeg = Object.fromEntries(registry.map((l) => [l.leg, l]));
  const rows = [];
  for (const r of results) {
    const leg = byLeg[r.leg];
    if (!leg) continue;
    if (leg.billing === "plan") { rows.push({ leg: r.leg, usd: 0, basis: "plan (no key can reach this process)" }); continue; }
    // The classifier already decided this; the cost row reads its answer rather than guessing.
    const notRunReason = r.kind === "not-run" ? r.reason : null;
    // Metered usage is only priced when the runner reports it and the model pin is valid.
    // Missing usage or an expired/missing pin must remain unknown, never a fabricated zero.
    const hasTokens = Number.isFinite(r.tokensIn) || Number.isFinite(r.tokensOut);
    rows.push({
      leg: r.leg,
      usd: typeof r.usd === "number" ? r.usd : null,
      tokensIn: Number.isFinite(r.tokensIn) ? r.tokensIn : null,
      tokensOut: Number.isFinite(r.tokensOut) ? r.tokensOut : null,
      ...(Object.hasOwn(r, "tokensCached") ? { tokensCached: r.tokensCached } : {}),
      basis: typeof r.usd === "number"
        ? "computed from the runner's own token counts at the price pinned in the model registry"
        : hasTokens
          ? "usage reported but not priced — no valid unexpired price pin for this model in the model registry, or a partial token report"
          // A leg that never ran has absent spend, not unmeasured usage. Keep its refusal
          // reason distinct from a metered call whose runner failed to report usage.
          : notRunReason
            ? `NOT REPORTED — this leg did not run: ${notRunReason}`
            : "NOT REPORTED — this leg is metered and its runner did not surface usage",
    });
  }
  const known = rows.filter((x) => typeof x.usd === "number");
  // Exclude legs that never ran from unmeasured spend: no invocation means no missing usage
  // report. They remain visible in `rows` with their refusal reason, while the warning identifies
  // calls whose cost is genuinely unknown.
  const unknown = rows.filter((x) => x.usd == null && !/did not run/.test(x.basis || ""));
  return { rows, totalUsd: known.reduce((s, x) => s + x.usd, 0), unmeasured: unknown.map((x) => x.leg) };
}
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? true);
}
const flag = (name) => process.argv.includes(`--${name}`);

/**
 * Require a recorded isolation measurement before any review invocation.
 *
 * Read the measured verdict, then bind it to effective policy and today's CLI identity.
 * Checking --version costs no model calls; only a new probe can measure the boundary.
 */
export function isolationGate(policy, { readFile = readFileSync, ...bindingOptions } = {}) {
  const reprobe = `node "${join(dirname(fileURLToPath(import.meta.url)), "isolationProbe.mjs")}"`;
  const refuse = (reason, why) => ({ ok: false, reason, why: `${why}. Re-probe: ${reprobe}` });
  let text;
  try {
    text = readFile(policy.probeRecord, "utf8");
  } catch {
    return refuse("MISSING-RECORD", `no isolation-probe record at ${policy.probeRecord}`);
  }
  const block = /^```json[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/m.exec(text);
  if (!block) return refuse("PREDATES-BINDING", "re-probe: the record predates binding");
  let record;
  try { record = JSON.parse(block[1]); }
  catch { return refuse("INVALID-BINDING", "the isolation-probe JSON binding is malformed"); }
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  if (!object(record) || record.schemaVersion !== 1 || !record.probeVersion
    || typeof record.measuredAt !== "string" || !Number.isFinite(Date.parse(record.measuredAt))
    || !Array.isArray(record.enabledCliRunners) || record.enabledCliRunners.some((type) => !cliCommand(type))
    || new Set(record.enabledCliRunners).size !== record.enabledCliRunners.length
    || !object(record.cli) || !object(record.overall)) {
    return refuse("INVALID-BINDING", "the isolation-probe binding has an invalid or unsupported shape");
  }
  const enabled = enabledCliLegs(policy.registry);
  const unmeasured = enabled.filter((leg) => !record.enabledCliRunners.includes(leg.runner)
    || !Object.hasOwn(record.cli, leg.runner)).map((leg) => leg.runner);
  if (unmeasured.length) return refuse("UNMEASURED-RUNNER", `unmeasured enabled CLI runner types: ${unmeasured.join(", ")}`);
  if (record.overall.ok !== true) return refuse("PROBE-NOT-PASS", `the recorded isolation probe is ${record.overall.verdict}: ${record.overall.why}`);
  if (record.overall.verdict === "NO-AGENT-BOUNDARY") {
    if (enabled.length || record.enabledCliRunners.length || Object.keys(record.cli).length) {
      return refuse("INVALID-BINDING", "NO-AGENT-BOUNDARY requires no enabled or measured CLI runner");
    }
    return { ok: true, why: "no local agent leg is enabled; nothing to isolate" };
  }
  if (record.overall.verdict !== "PASS" || !record.enabledCliRunners.length) {
    return refuse("PROBE-NOT-PASS", `the recorded isolation probe is not a measured PASS: ${record.overall.verdict}`);
  }
  if (record.enabledCliRunners.some((type) => !Object.hasOwn(record.cli, type))
    || Object.keys(record.cli).some((type) => !record.enabledCliRunners.includes(type))) {
    return refuse("INVALID-BINDING", "the PASS record does not measure every recorded enabled CLI runner");
  }
  for (const [runner, measured] of Object.entries(record.cli)) {
    if (!object(measured) || measured.verdict !== "PASS") {
      return refuse("CLI-NOT-PASS", `${runner} recorded verdict is ${measured?.verdict || "missing"}, not PASS`);
    }
    if (typeof measured.executablePath !== "string" || !isAbsolute(measured.executablePath)
      || !Array.isArray(measured.executablePrefix) || measured.executablePrefix.some((arg) => typeof arg !== "string")
      || typeof measured.version !== "string" || !measured.version.trim()
      || typeof measured.argvShapeHash !== "string" || !/^[a-f0-9]{64}$/.test(measured.argvShapeHash)) {
      return refuse("INVALID-BINDING", `${runner} has an incomplete executable, version or argv-shape binding`);
    }
    const leg = enabled.find((entry) => entry.runner === runner)
      || policy.registry.find((entry) => entry.runner === runner) || { runner };
    let current;
    try { current = measureCliBinding(leg, bindingOptions); }
    catch (error) { return refuse("CLI-IDENTITY-UNAVAILABLE", error.message); }
    for (const [field, label, reason] of [
      ["executablePath", "executable path", "EXECUTABLE-PATH-CHANGED"],
      ["executablePrefix", "executable prefix", "EXECUTABLE-PREFIX-CHANGED"],
      ["version", "version", "CLI-VERSION-CHANGED"],
      ["argvShapeHash", "argv-shape hash", "ARGV-SHAPE-CHANGED"],
    ]) {
      if (JSON.stringify(measured[field]) !== JSON.stringify(current[field])) {
        return refuse(reason, `${runner} ${label} changed: recorded ${JSON.stringify(measured[field])}; current ${JSON.stringify(current[field])}`);
      }
    }
  }
  return { ok: true, why: "reading a RECORDED pass bound to the enabled CLI types, executables, versions and argv shapes; not re-measuring isolation" };
}

function buildArtifact() {
  const file = arg("file"), pr = arg("pr"), title = arg("title");
  if (file) return fromFile(file);
  if (pr) return fromPr(pr, { repo: arg("repo") || undefined });
  if (flag("stdin")) return fromText(readFileSync(0, "utf8"), title || "pasted text");
  throw new Error("give the panel something to read: --file <path>, --pr <n>, or --stdin");
}

/** Artifact identity deliberately ignores content: fixes stay in the same convergence loop. */
export function artifactKey(artifact) {
  return artifact.prNumber != null ? `pr:${artifact.prNumber}` : `${artifact.kind}:${artifact.source}`;
}

export function artifactHistory(artifact, ledgerHome) {
  let files;
  try { files = readdirNative(ledgerHome).filter((f) => /^\d{4}-\d{2}\.ndjson$/.test(f)).sort(); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const rows = [];
  for (const file of files) {
    for (const line of readFileSync(join(ledgerHome, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.artifact && artifactKey(row.artifact) === artifactKey(artifact)) rows.push(row);
      } catch { /* Tolerate a half-written final ledger line. */ }
    }
  }
  return rows;
}

export function previousRoundActionable(artifact, round, ledgerHome) {
  return artifactHistory(artifact, ledgerHome).filter((r) => r.runnerRound === round - 1).at(-1)?.actionableFindings || [];
}

export function roundHistory(artifact, ledgerHome) {
  return artifactHistory(artifact, ledgerHome).map((r) => r.actionable).filter(Number.isFinite);
}

/** One title contributes at most once per row; equality is exact, not fuzzy clustering. */
export function recurringFindings(rows) {
  const titles = new Map();
  for (const row of rows) {
    for (const title of new Set((row.actionableFindings || []).map((finding) => finding.title))) {
      if (!titles.has(title)) titles.set(title, []);
      titles.get(title).push(row.runnerRound ?? row.round);
    }
  }
  return [...titles].filter(([, rounds]) => rounds.length >= 3).map(([title, rounds]) => ({
    channel: "signal", label: "RECURRING FINDING", title, rounds,
  }));
}

/** Bank every round, append-only, so convergence and cost checks retain their evidence. */
function bank(record, ledgerHome) {
  try {
    mkdirSync(ledgerHome, { recursive: true });
    const month = new Date().toISOString().slice(0, 7);
    appendFileSync(join(ledgerHome, `${month}.ndjson`), `${JSON.stringify(record)}\n`, "utf8");
    return null;
  } catch (e) {
    return e.message;
  }
}

/** Any enabled leg without parseable findings leaves the round PARTIAL. */
export function panelRound(results, clusters, options = {}) {
  const remaining = results.filter((r) => r.kind !== "not-run");
  const summary = summariseRound({ legs: results, findings: clusters });
  const failed = results.filter((r) => r.kind === "not-run" || r.kind === "failed" || !r.answered || r.parseFailed);
  if (failed.length) { summary.complete = false; summary.quiet = false; }
  const decision = failed.length ? {
    action: "STOP", reason: "PARTIAL",
    why: `the panel was incomplete: ${failed.map((r) => `${r.leg}: ${r.error || r.reason || "unparseable findings"}`).join("; ")}. Fix the leg and rerun; PARTIAL does not end the convergence loop.`,
  } : loopDecision({ ...options, summary });
  return { remaining, summary, decision };
}

/**
 * A leg that answers from a NON-PRIMARY rung can complete the round with a different model
 * tier than configured. Show that demotion alongside refusals so a successful fallback does
 * not hide an unavailable primary behind the footer.
 */
export function demotionWarnings(results, registry) {
  const primaryOf = Object.fromEntries((registry || []).map((l) => [l.leg, l.id]));
  return results
    .filter((r) => r.kind === "answered" && r.model && primaryOf[r.leg] && r.model !== primaryOf[r.leg])
    .map((r) => `[panel] ${r.leg} DEMOTED: primary rung ${primaryOf[r.leg]} did not answer; ${r.model} answered in its place. Fix or re-pin the primary before trusting this seat's tier.`);
}

export function panelStatus(results) {
  const remaining = results.filter((r) => r.kind !== "not-run");
  const read = remaining.filter((r) => r.kind !== "failed" && r.answered && !r.parseFailed);
  return [
    `[panel] ${remaining.length} leg(s) remain, ${read.length} read. Proof requires at least ${MIN_PROOF_LEGS}.`,
    ...results.filter((r) => r.kind === "not-run").map((r) => `[panel] ${r.leg} not run: ${r.reason}`),
    ...results.filter((r) => r.kind === "failed").map((r) => `[panel] ${r.leg} failed: ${r.reason}`),
  ].join("\n");
}

/** Compare successive attempts of the same leg, across artifacts and month boundaries. */
// "PREVIOUS RUN" means the last ledger line for that leg, not the newest timestamp. Append-only
// ledgers merged as a union preserve append order rather than chronological order, so the last
// line can predate an earlier one. The warning requires consecutive matches in that stored
// order; it does not claim chronological adjacency or reorder the ledger.
export function repeatedReplyWarnings(results, readDir = readdirNative, readFile = readFileSync, ledgerHome = null) {
  const previous = new Map();
  let files;
  try { files = readDir(ledgerHome).filter((f) => f.endsWith(".ndjson")).sort(); }
  catch { return []; }
  for (const file of files) {
    let text;
    try { text = readFile(join(ledgerHome, file), "utf8"); }
    catch { previous.clear(); continue; }
    for (const line of text.split("\n").filter((line) => line.trim())) {
      try {
        for (const leg of JSON.parse(line).legs || []) previous.set(leg.leg, leg);
      } catch { previous.clear(); }
    }
  }
  return results.filter((r) => r.shortUnrecognised && previous.get(r.leg)?.shortUnrecognised
    && previous.get(r.leg)?.model === r.model).map((r) =>
    `[panel] ${r.leg}: consecutive short unrecognised replies. A quota or plan limit is possible; re-check FABLE_PLAN_LIMIT_REPLY in legRunner.mjs. This leg still blocks.`);
}

const PROOF_MARKER = "<!-- tribunal-proof -->";

/** Render each leg from the very same metered summary that was banked. */
function proofCostLine(metered) {
  if (!metered?.rows?.length) return "Cost: not reported.";
  return `Cost: ${metered.rows.map((row) => {
    const cost = /^plan/.test(row.basis || "") && row.usd === 0 ? "$0 (plan)"
      : row.usd === 0 ? "0 USD (measured)"
        : Number.isFinite(row.usd) ? `$${row.usd} (measured)` : "not reported";
    return `${row.leg}: ${cost}`;
  }).join("; ")}.`;
}

/** Build a proof, optionally post it; a failed comment must not invalidate the review. */
export function postLocalProof(artifact, round, elapsedMs, results, repo, spawn = spawnSync,
  decision = null, summary = null, { metered = null, post = true } = {}) {
  if (artifact.prNumber == null) return; // not a PR review; nothing to certify
  // Explain why proof is withheld so the operator can distinguish a moved PR head from an
  // unreadable head check and rerun the review against a stable artifact.
  if (!artifact.headSha) {
    console.error("[proof] no proof posted: the PR head could not be pinned to the diff that "
      + "was reviewed (a push during the review, or an unreadable re-read). Re-run the panel.");
    return;
  }
  // The legs that ANSWERED **AND PARSED**, read off the results, never a hardcoded list.
  //
  // A reply must parse, and every enabled leg must be represented. A degraded panel
  // is PARTIAL even when its readable legs returned no actionable findings.
  const remaining = results.filter((r) => r.kind !== "not-run");
  const read = remaining.filter((r) => r.kind !== "failed" && r.answered && !r.parseFailed).map((r) => r.leg);
  // Post nothing the guard is bound to reject, and nothing that overstates the panel.
  // MIN_PROOF_LEGS is a floor on BOTH sides because `results.length` counts the ENABLED
  // legs: without it, shrinking the registry to one leg makes "every leg was read" true
  // by construction. Three is the smallest number still worth calling cross-model.
  if (read.length < MIN_PROOF_LEGS || read.length !== results.length) {
    console.error(`[proof] no proof posted: ${read.length} of ${results.length} enabled leg(s) were `
      + `READ and the floor is ${MIN_PROOF_LEGS}. A degraded panel is not a clean bill, so `
      + "the merge gate will refuse this round. Fix the leg and re-run.");
    return;
  }
  const payload = {
    head_sha: artifact.headSha,
    panel_source: "local",
    round,
    verdict: decision ? `${decision.action}/${decision.reason}` : null,
    actionable: summary && typeof summary.actionableCount === "number" ? summary.actionableCount : null,
    legs: read,
    legs_total: remaining.length,
    // The known subtotal is not a total when any leg's cost is missing.
    costUSD_total: metered?.rows?.length && metered.rows.every((row) => Number.isFinite(row.usd))
      && Number.isFinite(metered.totalUsd) ? metered.totalUsd : null,
    metered,
  };
  const elapsedSeconds = (elapsedMs / 1000).toFixed(1);
  // The verdict goes in the VISIBLE body, not only the machine blob. This marker means "this
  // commit was reviewed", so whoever reads it must see what the review actually said
  // without decoding base64.
  const outcome = payload.actionable === null
    ? ""
    : payload.actionable === 0
      ? " No actionable findings."
      : ` **${payload.actionable} actionable finding(s)** — read them before merging.`;
  const body = `${PROOF_MARKER}\nLocal Tribunal round ${round}: ${read.length} of ${remaining.length} legs read, ${elapsedSeconds}s.${outcome}\n\n${proofCostLine(metered)}\n\n${panelStatus(results)}\n\n<!-- eval-data:v1: ${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")} :end -->`;
  if (!post) return body;
  try {
    // GH_REPO makes gh api's placeholders follow the same --repo selection as the PR read.
    // Paginate before matching: an unrelated newer comment must never become the edit target.
    const options = { encoding: "utf8", ...(repo ? { env: { ...process.env, GH_REPO: repo } } : {}) };
    const gh = (args, input) => {
      const result = spawn("gh", args, { ...options, ...(input === undefined ? {} : { input }) });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr?.trim() || `gh exited ${result.status}`);
      return result.stdout;
    };
    const endpoint = `repos/{owner}/{repo}/issues/${artifact.prNumber}/comments`;
    const pages = JSON.parse(gh(["api", "--paginate", "--slurp", endpoint]));
    if (!Array.isArray(pages)) throw new Error("GitHub returned an invalid comment list");
    const comments = pages.flat();
    if (comments.some((comment) => !comment || typeof comment.body !== "string"
      || !Number.isSafeInteger(comment.id) || comment.id <= 0)) {
      throw new Error("GitHub returned an invalid comment list");
    }
    const previous = comments.filter((comment) => comment.body.includes(PROOF_MARKER)).at(-1);
    gh(["api", "--method", previous ? "PATCH" : "POST",
      previous ? `repos/{owner}/{repo}/issues/comments/${previous.id}` : endpoint, "--input", "-"],
    JSON.stringify({ body }));
  } catch (e) {
    console.error(e.code === "ENOENT"
      ? `[proof] ${GH_MISSING_MESSAGE}`
      : `[proof] could not post local PR proof: ${e.message}`);
  }
  return body;
}

export async function main({ reviewLeg = runLeg, probeOptions = {}, probe = runProbe, policyOptions = {} } = {}) {
  if (process.argv.some((value) => value === "--round" || value.startsWith("--round="))) {
    console.error("Tribunal refused: --round is removed; runnerRound is assigned by the runner.");
    process.exitCode = 4;
    return;
  }
  const override = arg("override");
  if (flag("override") && (typeof override !== "string" || !override.trim() || override.startsWith("--"))) {
    console.error("Tribunal refused: --override requires a nonempty reason.");
    process.exitCode = 4;
    return;
  }
  const policy = resolvePolicy(process.cwd(), policyOptions);
  if (flag("print-policy")) { console.log(JSON.stringify(policy, null, 2)); return; }
  // --no-auto-probe keeps the strict behaviour: a missing or stale measurement refuses (exit 5)
  // and names the re-probe command, for operators who want the probe to be a deliberate step.
  const gate = await admitPanel(policy, { probeOptions, probe: flag("no-auto-probe") ? null : probe });
  if (!gate.ok) {
    console.error(`Tribunal refused to run: ${gate.why}`);
    process.exitCode = 5;
    return;
  }

  const all = policy.registry;
  for (const leg of all.filter((l) => l.skippedNotInstalled)) console.error(`[panel] ${leg.leg}: ${leg.disabledReason}`);
  const { run: legs, credentialAbsent, trustRefused = [] } = runnableLegs(all);
  const disabled = all
    .filter((l) => !l.enabled)
    .map((l) => `${l.leg}: ${l.disabledReason ? l.disabledReason.split(".")[0] + "." : "disabled in the model registry"}`);
  const artifact = buildArtifact();
  if (!artifact.contentHash) throw new Error("could not pin the artifact contentHash; retry after the PR head is stable");
  // Hold admission through banking so concurrent invocations cannot reuse a round or
  // race the ten-row limit. A stopped process may leave this visible lock for diagnosis.
  mkdirSync(policy.ledgerHome, { recursive: true });
  const lockPath = join(policy.ledgerHome, `${createHash("sha256").update(artifactKey(artifact)).digest("hex")}.lock`);
  let lock;
  try { lock = openSync(lockPath, "wx"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.error(`Tribunal refused: another attempt holds this artifact lock (${lockPath}); wait for it to finish, or remove a stale lock after confirming its process has stopped.`);
    process.exitCode = 6;
    return;
  }
  try {
    writeFileSync(lock, `${process.pid}\n`, "utf8");
    const history = artifactHistory(artifact, policy.ledgerHome);
    const latest = history.at(-1);
    if (!override && latest?.decision?.reason === "QUIET" && latest?.decision?.action === "STOP"
      && latest.contentHash === artifact.contentHash) {
      console.error("Tribunal refused: already quiet on unchanged content; change the artifact or pass --override with a reason.");
      process.exitCode = 2;
      return;
    }
    if (!override && history.length >= 10) {
      console.error("Tribunal refused: this artifact already has 10 or more recorded rows; pass --override with a reason.");
      process.exitCode = 3;
      return;
    }
    const round = 1 + Math.max(0, ...history.map((row) => Number.isSafeInteger(row.runnerRound) ? row.runnerRound : 0));
    const message = `${readFileSync(policy.reviewerPromptPath, "utf8")}\n\n${buildUserMessage(artifact)}`;

    const started = Date.now();
    // Run legs in parallel for speed, each in its own directory to prevent CLI conversation
    // state from carrying one reviewer's context into another review.
    const results = [
      ...await Promise.all(legs.map((l) => reviewLeg(l, message))),
      ...credentialAbsent.map(({ leg, missing }) => {
        const outcome = classifyLegOutcome({ missingCredentials: missing, model: leg.id });
        return { leg: leg.leg, model: leg.id, ...outcome, answered: false,
          error: `not run: ${outcome.reason}`, findings: [], raw: "", parseFailed: false };
      }),
      ...trustRefused.map(({ leg, reason }) => ({ leg: leg.leg, model: leg.id,
        kind: "not-run", reason, answered: false, error: `not run: ${reason}`,
        findings: [], raw: "", parseFailed: false })),
    ];
    const elapsedMs = Date.now() - started;

    const status = panelStatus(results);
    const warnings = [...demotionWarnings(results, all), ...repeatedReplyWarnings(results, readdirNative, readFileSync, policy.ledgerHome)];
    console.error([status, ...warnings].join("\n"));

    const perLeg = results.filter((r) => r.kind === "answered").map((r) => ({ leg: r.leg, findings: r.findings }));
    const clusters = clusterFindings(perLeg);
    // Feed the previous round's actionable findings from this artifact's ledger into the loop
    // decision so the REDO path can detect a fix that remains incomplete.
    // Whether each is STILL PRESENT is a judgment the operator makes and hands back with
    // --still-present <n>; the tool will not guess, because guessing would either invent a REDO or
    // suppress a real one.
    const previousActionable = previousRoundActionable(artifact, round, policy.ledgerHome);
    const stillPresentCount = Number(arg("still-present", 0)) || 0;
    const { remaining, summary, decision } = panelRound(results, clusters, {
      round,
      previousActionable,
      stillPresent: previousActionable.slice(0, Math.min(stillPresentCount, previousActionable.length)),
    });

    const record = {
      ts: new Date().toISOString(),
      artifact: { kind: artifact.kind, source: artifact.source, title: artifact.title, chars: artifact.text.length, prNumber: artifact.prNumber ?? null, headSha: artifact.headSha ?? null },
      round,
      runnerRound: round,
      contentHash: artifact.contentHash,
      ...(override ? { override } : {}),
      elapsedMs,
      legs: results.map((r) => ({ leg: r.leg, model: r.model, answered: r.answered, error: r.error,
        kind: r.kind, reason: r.reason, parseFailed: r.parseFailed, shortUnrecognised: Boolean(r.shortUnrecognised),
        findings: r.findings?.length ?? 0 })),
      // A 4-leg pass must be distinguishable from a 5-leg pass in the LEDGER, not only in the
      // rendered comment: name every enabled-or-known leg that did not run, with its reason.
      notRun: [...disabled, ...results.filter((r) => r.kind === "not-run").map((r) => `${r.leg}: ${r.reason}`)],
      legsRemaining: remaining.length,
      warnings,
      clusters: clusters.length,
      actionable: summary.actionableCount,
      // Banked so the next round can re-verify them. Without this the REDO path has nothing to
      // compare against and the loop can never notice a fix that did not land.
      actionableFindings: summary.actionable.map((f) => ({ title: f.title, file: f.file, severity: f.severity, category: f.category, foundBy: f.foundBy })),
      soleFinds: soleFindsByLeg(clusters),
      decision: { action: decision.action, reason: decision.reason },
      // Bank measured cost so metered legs cannot inherit an unconditional zero. A leg whose
      // runner reports no usage remains null ("not reported"), because silence is not free.
      metered: meteredSummary(results, all),
    };
    const recurrence = recurringFindings([...history, record]);
    const bankError = bank(record, policy.ledgerHome);
    // A proof certifies that a complete, parseable panel reviewed this commit; it can include
    // actionable findings. Requiring QUIET would hide completed reviews that found defects.
    // A panel that lost a leg or that nobody could parse cannot produce proof.
    //
    // The proof also follows a SUCCESSFUL bank: a run whose ledger record did not land must
    // not leave a comment claiming it did.
    const postProof = flag("post-proof");
    const proof = !bankError && isRecordableRound(summary)
      ? postLocalProof(artifact, round, elapsedMs, results, arg("repo"), spawnSync, decision, summary,
        { metered: record.metered, post: postProof })
      : null;
    const preview = !postProof && proof ? proof : null;

    const signal = recurrence.map((finding) => `RECURRING FINDING (channel signal)\n${finding.title}\nRounds: ${finding.rounds.join(", ")}`).join("\n\n");
    const out = [status, ...warnings, ...(signal ? ["", signal] : []), "", render({ artifact, clusters, summary, decision,
      legs: remaining, round, elapsedMs, disabled, metered: record.metered }), ...(preview ? ["", preview] : [])].join("\n");
    const text = flag("json") ? JSON.stringify({ record, clusters, summary, decision, recurrence, recurrenceSignal: signal || null,
      ...(preview ? { proof: preview } : {}) }, null, 2) : out;
    const dest = arg("out");
    if (dest) {
      writeFileSync(dest, text, "utf8");
      if (preview) console.log(flag("json") ? JSON.stringify({ proof: preview }, null, 2) : preview);
    }
    else console.log(text);

    if (bankError) console.error(`\n[ledger] could not bank this round: ${bankError}`);
    // Read actual ledger history: repeating the current count for every past round would make
    // both halves of the trend identical and force a misleading "flat" result.
    const trend = trendLine([...roundHistory(artifact, policy.ledgerHome), summary.actionableCount]);
    if (trend) console.error(`\n[trend] ${trend}`);

    // EXIT 0 MEANS "this artifact is done"; anything else is non-zero.
    //
    // Completeness alone does not imply success: a complete panel can reach the ceiling with
    // blockers or return actionable findings. Require a successfully banked QUIET result so
    // callers reading only the exit code cannot mistake those outcomes for a clean review.
    const succeeded = !bankError && decision.action === "STOP" && decision.reason === "QUIET";
    process.exitCode = succeeded ? 0 : 1;
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error("tribunal run failed:", e.message); process.exitCode = 1; });
}
