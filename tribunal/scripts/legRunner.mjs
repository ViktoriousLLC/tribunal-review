// Isolate each reviewer invocation and name every failure to return findings.
//
// Three properties this file enforces:
//
//   FRESH DIRECTORY PER INVOCATION. Two `claude -p` runs sharing a working directory are not
//   independent: conversation reuse can let the second rely on the first one's reading.
//   Each model must read the artifact cold and blind to the other reviewers.
//
//   PER-LEG MINIMAL ENVIRONMENT. Each leg receives exactly the variables models.default.json lists for
//   it and nothing else. The agent runners read untrusted input and can hold a shell, so a
//   spend-capable key never enters their environment. registry.mjs refuses a configuration
//   that would break this; here it is enforced at the spawn.
//
//   A LOST LEG IS NAMED, NEVER SWALLOWED. Every failure path returns a leg result with
//   `answered: false` and the real error, because panelLogic treats a partial panel as
//   something that can never be a quiet round.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExe } from "./executable.mjs";
import { redactSensitive as redact } from "./artifact.mjs";
import { openaiApiEnvironment, openaiApiEndpoint, OPENAI_API_TIMEOUT_MS } from "./openaiApi.mjs";
export const CODEX_DISABLED_FEATURES = [
  "shell_tool", // no command execution, so no reading the credential
  "browser_use", // network egress the read-only sandbox does not gate
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "multi_agent", // no sub-agent that would escape this argv
  "apps",
  "enable_mcp_apps",
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "hooks",
  // code_mode_host stays enabled: codex-cli 0.153.4 requires it for file work and
  // otherwise fails with "code-mode host is disabled". Version 0.144.5 did not have
  // that requirement. A feature name can remain valid while its meaning changes,
  // so checking names alone cannot establish that a CLI upgrade preserves the lane.
  // shell_tool is disabled separately to block command execution.
  "tool_suggest",
  "skill_mcp_dependency_install",
];

/**
 * Every built-in Grok Build tool, removed by name. `--tools` cannot be the guard: an allowlist
 * entry that names no tool leaves EVERY tool available (Grok Build 1.0.62 headless docs), so an
 * empty allowlist is a full toolset. The isolation probe's guarded run is what proves this list.
 */
export const GROK_DISALLOWED_TOOLS = [
  "run_terminal_cmd", "run_terminal_command", "read_file", "write", "search_replace", "list_dir", "grep",
  "web_search", "web_fetch", "task", "Agent", "kill_command_or_subagent", "get_command_or_subagent_output",
  "todo_write", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor", "search_tool",
  "use_tool", "workflow", "enter_plan_mode", "exit_plan_mode", "ask_user_question", "send_feedback",
  "image_gen", "image_edit", "image_to_video", "reference_to_video",
];

/** Replaces Grok Build's agent system prompt, which tells it to act on a codebase. */
export const GROK_REVIEW_SYSTEM = "You are one independent reviewer on a code review panel. You have no tools. Review only the text you are given and answer in the format it asks for.";

/** Set on every Grok leg: no self-update mid-panel (it would change the certified binary), no
 * API-key login (only the plan sign-in may bill), no telemetry, trace upload or feedback. */
export const GROK_FIXED_ENV = {
  GROK_DISABLE_AUTOUPDATER: "1", GROK_DISABLE_API_KEY_AUTH: "1", GROK_TELEMETRY_ENABLED: "false",
  GROK_TELEMETRY_TRACE_UPLOAD: "false", GROK_FEEDBACK_ENABLED: "false", DISABLE_ERROR_REPORTING: "1",
};

/** The home variables a Grok leg points at its own empty directory. */
export const GROK_HOME_VARS = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

/**
 * Names that move an Antigravity (agy) seat off the Google AI Pro plan and onto a bill. agy 1.1.13
 * signs in from GEMINI_API_KEY with no prompt, and 1.1.10+ from a service account or ADC; any of
 * them in the child's environment would silently replace the plan sign-in. envForLeg never copies
 * them, and a test hands it every one to prove that.
 */
export const AGY_FORBIDDEN_ENV = [
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
  "AGY_ADC_AUTH", "ANTIGRAVITY_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_GENAI_USE_VERTEXAI", "CLOUDSDK_CONFIG", "CLOUDSDK_AUTH_ACCESS_TOKEN",
];

/**
 * Per-run agy settings (never saved). `useG1Credits: false` keeps an exhausted plan allowance from
 * being paid out of purchased AI credits. The deny list removes every tool: without the read_file
 * rule agy read a file OUTSIDE its workspace on 2026-10-30, and the review is in the prompt anyway.
 */
export const AGY_SETTINGS = {
  useG1Credits: false,
  permissions: {
    deny: ["command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)", "unsandboxed(*)"],
  },
};

/**
 * Does an agy seat get its own empty home on this platform? On Windows the plan sign-in lives in
 * the system credential store, not the home: with HOME, USERPROFILE, APPDATA and LOCALAPPDATA all
 * pointed at an empty directory agy still answered on the account (measured 2026-10-30). An empty
 * home keeps the user's agy hooks, saved settings (a saved useG1Credits), .env files, gcloud ADC
 * file and any scheduled task out of the run. Elsewhere the sign-in may be a file in the home, so the
 * seat does not run there at all until that is measured (policy.mjs turns it off).
 */
export function agyHomeIsolated(platform = process.platform) {
  return platform === "win32";
}

export const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;

// Exact vendor refusal text; unrelated hook output on stderr does not turn it into a crash.
export const FABLE_PLAN_LIMIT_REPLY = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
export const SHORT_REPLY_BYTES = 256;
export const RATE_LIMIT_RETRY_MS = 60000;
// Prompt lines are removed before classification. Only the last remaining error marker
// (optionally timestamped) can name a refusal; short stdout must begin with one.
const ERROR_LINE = /^(?:\[[^\]\r\n]*\]\s*|\d{4}-\d\d-\d\dT\S+\s+)?(?:ERROR|Error|error|API Error)\b[^\r\n]*/gm;
// A spent quota is not a rate limit: waiting does not help (OpenAI insufficient_quota). Gemini's
// "exceeded your current quota" is NOT here: it uses the same words for a per-minute limit,
// where the one retry is what saves the round, and a spent daily quota only costs one wait.
const QUOTA_EXHAUSTED = /insufficient_quota/i;
const lastErrorLine = (stderr) => [...stderr.matchAll(ERROR_LINE)].at(-1)?.[0].trim() ?? "";
const RATE_LIMIT = /^(?:API Error:\s*429\b|(?:error:\s*)?(?:rate[ _-]?limit(?:ed|_error|_exceeded)?|too many requests)\b)/i;

/** Remove whole echoed prompt lines, including contracts, before trusting stderr. */
export function stripEchoedPrompt(stderr, promptText) {
  const lines = new Set(promptText.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean));
  return stderr.replace(/\r\n/g, "\n").split("\n").filter((line) => !lines.has(line.trim())).join("\n");
}

/** Classify observed signals. Optional context supplies names and our timer duration. */
export function classifyLegOutcome({ code, stdout = "", stderr = "", timedOut = false,
  spawnError, model = "the model", timeoutMs = DEFAULT_TIMEOUT_MS, missingCredentials = [] } = {}) {
  const output = stdout.trim();
  const hasFindings = !parseFindings(stdout).parseError;
  const nonzero = Number.isInteger(code) && code !== 0;
  const trace = /(?:^|\n)\s+at (?:.+\()?[^\n]*:\d+:\d+\)?\s*(?:\n|$)|Traceback \(most recent call last\):|thread '[^'\n]+' panicked at/;
  // Blocking evidence wins, including a trace on stderr. Ordinary hook noise does not.
  if (code !== 0 && (trace.test(stdout) || trace.test(stderr)
    || (stdout.includes(FABLE_PLAN_LIMIT_REPLY) && output !== FABLE_PLAN_LIMIT_REPLY))) {
    return { kind: "failed", reason: "crashed" };
  }
  // A timeout is never a rate limit: retrying it would spend a second full leg timeout.
  // A CLI may print banners on stdout before its stderr error line.
  // A plan-limit refusal is a not-run (handled below), never a retry, even beside a 429 line.
  if (code !== 0 && !timedOut && !hasFindings && output !== FABLE_PLAN_LIMIT_REPLY
    && !/^You've reached your .{1,40}? limit\./.test(output)
    && !QUOTA_EXHAUSTED.test(stderr) && !QUOTA_EXHAUSTED.test(stdout)
    // A Claude JSON envelope unwraps to result text that BEGINS `API Error: 429`, at any length.
    && (/\b429\b/.test(lastErrorLine(stderr)) || /^API Error:\s*429\b/.test(output)
      || (Buffer.byteLength(output, "utf8") <= SHORT_REPLY_BYTES
        && (RATE_LIMIT.test(output) || /\b429\b/.test(lastErrorLine(output)))))) {
    return { kind: "failed", reason: "rate limited" };
  }
  if (code === 0 && !hasFindings) {
    return { kind: "failed", reason: output ? "reply could not be parsed" : "empty reply" };
  }
  if (code === 0 && hasFindings) return { kind: "answered", reason: "findings received" };
  // Share the length and findings checks with planLimitMessage, then require the entire
  // reply to be the vendor refusal. A short crash message can contain the limit phrase
  // without a stack trace; it must remain failed rather than become not-run.
  // planLimitMessage returns display text, not the matched substring, so compare stdout
  // with the vendor's reply shape instead of removing that return value from it.
  const refusal = nonzero && !hasFindings ? planLimitMessage(stdout) : null;
  // Pin every clause: matching only the opener and closer would accept arbitrary crash
  // text between them as a refusal.
  const onlyTheRefusal =
    /^You've reached your .{1,40}? limit\. Switch to another model, or manage usage credits at \S+, to continue\.$/
      .test(output);
  if (refusal && onlyTheRefusal) {
    // A credential refresh cannot reset a usage cap. Reuse the shared explanation so
    // callers consistently advise waiting for the reset or accepting a degraded panel.
    return { kind: "not-run", reason: refusal };
  }
  if (!output && missingCredentials.length) {
    return { kind: "not-run", reason: `${missingCredentials.join(" and ")} is absent on this machine` };
  }
  if (!output && spawnError) {
    return { kind: "not-run", reason: `${model} could not be reached (${spawnError.code || spawnError.message || "spawn error"})` };
  }
  if (!output && timedOut) return { kind: "not-run", reason: `${model}: no reply in ${timeoutMs / 1000}s` };
  // Our flags establish a not-run only before a reply starts. Partial output is evidence
  // of work, so an interrupted reply stays blocking even without a close event's exit code.
  // Vendor 5xx and transport prose have no recognized refusal shape here. Treat unknown
  // output as failed; guessing that it means not-run would silently shrink a panel.
  // Name the CLI's own last error line so the operator can act on it: a bare "unrecognised"
  // can hide a cause as simple as a 429. Only a line that STARTS with an error marker is quoted, so an
  // echoed prompt has already been removed before classification.
  // A Claude JSON envelope carries its error as result text on stdout (`API Error: 529 ...`).
  const errorLine = lastErrorLine(stderr) || (/^API Error:/.test(output) ? output.split("\n")[0] : "");
  return { kind: "failed", reason: "unrecognised", ...(errorLine ? { detail: redact(errorLine).slice(0, 160) } : {}) };
}

function legResult(leg, signals) {
  const raw = signals.stdout || "";
  const outcome = classifyLegOutcome({ ...signals, model: leg.id });
  const { findings, parseError } = parseFindings(raw);
  return {
    leg: leg.leg, model: leg.id, ...outcome,
    // Keep the legacy distinction: prose is an answer we could not read.
    answered: outcome.kind !== "not-run" && outcome.reason !== "rate limited" && Boolean(raw.trim()),
    error: outcome.kind === "answered" ? null
      : `${outcome.kind === "not-run" ? "not run" : "failed"}: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`,
    findings, raw, parseFailed: Boolean(outcome.kind === "failed" && parseError && raw.trim()),
    // Bank only this shape flag, never reply text, for the consecutive-run warning.
    shortUnrecognised: outcome.kind === "failed" && outcome.reason === "unrecognised"
      && Number.isInteger(signals.code) && signals.code !== 0 && Boolean(raw.trim())
      && Buffer.byteLength(raw, "utf8") <= SHORT_REPLY_BYTES && Boolean(parseError),
  };
}

const CLAUDE_REFUSED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "BashOutput", "KillShell", "SlashCommand",
];

/** The contract every leg answers in. Kept small: a schema a model can satisfy in one pass. */
export const FINDING_CONTRACT = `Reply with ONLY a JSON object, no prose around it, in this exact shape:
{"findings":[{"title":"one line","severity":"BLOCKER|SUGGESTION|NIT","category":"correctness|security|money|data-loss|pii|perf|style","file":"path or null","line":0,"why":"what breaks, concretely","check":"how to verify this is real"}]}
Rules: a finding is a hypothesis, so every one names how to check it. Do not restate the artifact. Do not praise it. Do not propose new features. If you find no BLOCKER, say so by simply not emitting one. At most 8 findings.`;

/**
 * Exactly the variables this leg is allowed, plus the OS baseline it needs to start at all.
 *
 * `envKeys` is an ALLOWLIST, not a requirement list. Claude CLI can authenticate from
 * its own store under HOME without `CLAUDE_CODE_OAUTH_TOKEN`; CI may instead supply
 * that variable. Its absence alone therefore does not establish a missing credential.
 *
 * So: pass an allowlisted variable through when it exists, and only report a leg as lacking a
 * credential when `requiredEnv` names something absent. Nothing outside the allowlist and
 * OS baseline reaches the process, keeping spend-capable keys away from agent legs.
 */
export function envForLeg(leg, source = process.env, { home = null } = {}) {
  if (leg.runner === "openai-api") return openaiApiEnvironment(leg, source);
  const base = {};
  for (const k of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "ComSpec"]) {
    if (source[k]) base[k] = source[k];
  }
  for (const k of leg.envKeys || []) {
    if (k === "CODEX_HOME") {
      base[k] = source.CODEX_HOME || join(source.USERPROFILE || source.HOME || "", ".codex");
      continue;
    }
    if (k === "GROK_HOME") {
      // The panel's OWN Grok sign-in, never the user's ~/.grok: that one carries their MCP
      // servers, plugins and memory, and sharing its refresh token could log one of them out.
      base[k] = source.TRIBUNAL_GROK_HOME || join(source.USERPROFILE || source.HOME || "", ".tribunal", "grok-home");
      continue;
    }
    if (source[k]) base[k] = source[k];
  }
  if (leg.runner === "grok-cli") {
    Object.assign(base, GROK_FIXED_ENV);
    // Grok Build also reads the user's ~/.claude rules, skills and MCP servers from HOME, even in
    // headless mode. Point every home variable at the leg's own empty directory so it reads none.
    if (home) for (const k of GROK_HOME_VARS) base[k] = home;
  }
  // The registry already refuses envKeys on an agy seat; this holds even for a row built in code.
  // Case-insensitively: Windows reads `gemini_api_key` as GEMINI_API_KEY.
  if (leg.runner === "agy-cli") {
    const forbidden = new Set(AGY_FORBIDDEN_ENV.map((k) => k.toUpperCase()));
    for (const k of Object.keys(base)) if (forbidden.has(k.toUpperCase())) delete base[k];
    // The caller passes a home only where agyHomeIsolated() says the sign-in survives it.
    if (home) for (const k of GROK_HOME_VARS) base[k] = home;
  }
  const missing = (leg.requiredEnv || []).filter((k) => !source[k]);
  return { env: base, missing };
}

export const TEMP_PREFIX = "tribunal-leg-";

/**
 * Longest a reply can be and still be a REFUSAL rather than a review.
 *
 * The vendor's limit notice is a sentence or two and is the entire reply. A review
 * that happens to mention a limit runs to thousands of characters. Without this
 * bound the matcher can mistake a review discussing rate limits for a refusal.
 */
export const MAX_REFUSAL_CHARS = 600;

/**
 * Is this a directory WE created, and therefore one we may recursively delete?
 *
 * `mkTemp` is injectable and can return "." or another real directory. Unconditional
 * recursive cleanup would then target the repository or unrelated data. Platform refusal
 * to remove a working directory and swallowed errors are not deletion safeguards.
 * Require the resolved path to be below the OS temp directory and carry our prefix
 * before allowing recursive cleanup.
 */
export function isOurTempDir(dir) {
  if (typeof dir !== "string" || !dir) return false;
  const resolved = resolve(dir);
  const tmp = resolve(tmpdir());
  if (resolved === tmp || !resolved.startsWith(tmp + sep)) return false;
  return basename(resolved).startsWith(TEMP_PREFIX);
}

export function argsForLeg(leg) {
  if (leg.runner === "claude-cli") {
    return [
      "-p", "--model", leg.id,
      "--output-format", "json",
      ...(leg.effort ? ["--effort", leg.effort] : []),
      "--disallowedTools", CLAUDE_REFUSED_TOOLS.join(","),
      "--setting-sources", "",
      "--strict-mcp-config",
    ];
  }
  if (leg.runner === "codex-cli") {
    return [
      "exec", "-m", leg.id, "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
      ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
      ...(leg.effort ? ["-c", `model_reasoning_effort="${leg.effort}"`] : []),
      "-",
    ];
  }
  if (leg.runner === "grok-cli") {
    return [
      "-p", "-", "-m", leg.id, "--output-format", "json",
      "--disallowed-tools", GROK_DISALLOWED_TOOLS.join(","),
      "--disable-web-search", "--no-subagents", "--no-memory", "--no-plan", "--max-turns", "1",
      "--system-prompt-override", GROK_REVIEW_SYSTEM,
    ];
  }
  if (leg.runner === "agy-cli") {
    // No prompt argument: print mode does not read plain stdin, and argv cannot hold a large
    // diff, so the prompt arrives as one stream-json message (see agyInput).
    return [
      "--input-format", "stream-json", "--output-format", "stream-json", "--model", leg.id,
      ...(leg.effort ? ["--effort", leg.effort] : []),
      "--disable-slash-commands", "--settings", JSON.stringify(AGY_SETTINGS),
    ];
  }
  throw new Error(`argsForLeg has no argv for runner "${leg.runner}"`);
}

/**
 * Did this leg refuse because its plan allowance is spent?
 *
 * Returned as an ERROR, not as findings, because the two need opposite responses:
 * an unparseable reply is a formatting problem in the leg, and an exhausted
 * allowance is a fact about the account that no amount of re-running will fix.
 * Treating an exhausted allowance as a formatting error invites ineffective retries.
 * A capped plan leg is named as not-run so the panel can run degraded or wait.
 */
export function planLimitMessage(out) {
  if (typeof out !== "string") return null;

  // Check length before the phrase so a long review quoting a limit notice cannot
  // be mistaken for the notice itself. Refusals are short and occupy the whole reply.
  const trimmed = out.trim();
  if (trimmed.length > MAX_REFUSAL_CHARS) return null;

  // A short review can quote the notice too. Parseable findings prove that a review
  // occurred, so they take precedence over both the length bound and the phrase.
  if (parseFindings(trimmed).parseError === null) return null;

  // Matched on the vendor's own sentence rather than a status code, because the CLI
  // exits 1 for every failure and the code cannot tell these apart.
  const m = trimmed.match(/reached your ([A-Za-z0-9.\- ]{1,40}?) limit/i);
  if (!m) return null;
  return (
    `plan allowance for ${m[1].trim()} is spent, so this leg did not review anything. ` +
    "It is NOT a formatting problem and re-running will not fix it. Wait for the allowance to " +
    "reset, or run the panel knowing it is degraded. Do not buy the leg back."
  );
}

/** Pull the findings JSON out of a reply that may have prose around it despite the contract. */
export function parseFindings(out) {
  if (typeof out !== "string" || !out.trim()) return { findings: [], parseError: "the leg returned nothing" };
  // Inspect every fenced block: a quoted snippet or diff can precede the findings.
  // Using only the first block would miss them, and a brace-slice fallback spanning
  // that snippet and the findings can also be invalid JSON.
  const fenced = [...out.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  // A slice anchored on indexOf("{") is defeated by ANY earlier brace -- a leg that
  // writes "the { shape } of this" before its JSON loses its whole reply. So the
  // brace search actually searches: every opening brace, nearest the end first,
  // because the findings block is what a leg writes last. Bounded so a reply full
  // of braces cannot turn this into a parsing marathon.
  const opens = [];
  for (let i = out.indexOf("{"); i !== -1 && opens.length < 24; i = out.indexOf("{", i + 1)) opens.push(i);
  const lastClose = out.lastIndexOf("}") + 1;
  const candidates = [
    ...fenced,
    ...opens.reverse().map((i) => (lastClose > i ? out.slice(i, lastClose) : "")),
    out,
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (Array.isArray(parsed?.findings)) return { findings: parsed.findings, parseError: null };
    } catch { /* try the next shape */ }
  }
  // A leg that answered in prose HAS answered. Losing that is worse than losing the structure:
  // panelLogic would then treat a talking leg as a dead one and stop the loop for the wrong reason.
  return { findings: [], parseError: "could not parse findings JSON from this leg's reply" };
}

/**
 * What the SDK's usageMetadata says this call consumed, or null when it said nothing.
 *
 * tokensOut is total minus prompt when a total is reported, because THINKING tokens bill as
 * output and candidatesTokenCount does not include them; candidatesTokenCount is the fallback.
 * Null, never 0, when the SDK reports nothing: silence must not read as free.
 */
export function geminiUsage(u) {
  if (!u || typeof u !== "object") return null;
  // A COUNT is a non-negative finite number; anything else the SDK reports is not a
  // measurement. A negative count on either side would bank negative dollars.
  const count = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  const tokensIn = count(u.promptTokenCount);
  let tokensOut = null;
  if (count(u.totalTokenCount) != null && tokensIn != null) {
    // total < prompt is INCONSISTENT, not a discount; count() nulls the negative result.
    tokensOut = count(u.totalTokenCount - tokensIn);
  } else if (count(u.candidatesTokenCount) != null) {
    // No total reported: thoughts still billed, so add them rather than drop them.
    tokensOut = count(u.candidatesTokenCount) + (count(u.thoughtsTokenCount) ?? 0);
  }
  if (tokensIn == null && tokensOut == null) return null;
  return { tokensIn, tokensOut };
}

/**
 * Dollars for one call, from MEASURED tokens and the per-model price pinned in models.default.json
 * (`pricesUSDPer1M`, keyed by the model id that actually answered — the fallback rung has a
 * different price than the primary). Null whenever a factor is missing or non-finite: an
 * unpriced or unreported call renders "not reported", never $0.
 */
export function geminiCostUSD(model, usage, prices, now = new Date()) {
  const p = prices && Object.prototype.hasOwnProperty.call(prices, model) ? prices[model] : undefined;
  if (!p || !usage) return null;
  // A price pin past its own `until` date is NO pin: pricing at an expired promotional rate
  // silently under-reports every round after the flip. Unpriced is loud; wrong is not.
  // Written so an unparseable `until` also refuses (NaN comparisons are false).
  if (p.until && !(now <= new Date(`${p.until}T23:59:59Z`))) return null;
  if (!Number.isFinite(usage.tokensIn) || !Number.isFinite(usage.tokensOut)) return null;
  // Some vendors re-rate the WHOLE request once the prompt crosses a threshold (Gemini Pro:
  // $2/$12 up to 200k prompt tokens, $4/$18 above). A pin may carry that second tier as
  // tierAt/tierIn/tierOut; a flat pin behaves as before. A tiered pin with a broken tier rate
  // refuses to price an over-threshold call rather than falling back to a cheaper base rate.
  const tiered = Number.isFinite(p.tierAt) && usage.tokensIn > p.tierAt;
  const rateIn = tiered ? p.tierIn : p.in;
  const rateOut = tiered ? p.tierOut : p.out;
  if (!Number.isFinite(rateIn) || !Number.isFinite(rateOut)) return null;
  return (usage.tokensIn * rateIn + usage.tokensOut * rateOut) / 1e6;
}

/**
 * The Gemini leg. A plain SDK call: no subprocess, no shell, no filesystem, nothing to abuse
 * through. Like the compatible API runner, it may hold its own spend-capable key.
 *
 * It is a METERED leg in the panel, so it fails loudly and never silently retries
 * onto a fallback that costs more than the one that failed.
 */
export async function runGeminiLeg(leg, userMessage, { sourceEnv = process.env, generateContent } = {}) {
  const key = sourceEnv.GEMINI_API_KEY;
  if (!key) return legResult(leg, { missingCredentials: ["GEMINI_API_KEY"] });
  if (!generateContent) {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: key });
      generateContent = (request) => ai.models.generateContent(request);
    } catch (e) {
      return { ...legResult(leg, {}), error: `failed: @google/genai is not installed: ${e.message}` };
    }
  }
  const ladder = [...new Set([leg.id, leg.fallback].filter(Boolean))];
  const errors = [];
  let rateLimited = 0;
  for (const model of ladder) {
    try {
      const res = await generateContent({ model, contents: `${userMessage}\n\n${FINDING_CONTRACT}` });
      const raw = res?.text ?? "";
      const usage = geminiUsage(res?.usageMetadata);
      return {
        ...legResult({ ...leg, id: model }, { code: 0, stdout: raw }),
        tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null,
        usd: geminiCostUSD(model, usage, leg.pricesUSDPer1M),
      };
    } catch (e) {
      if ((e.status === 429 || e.code === 429) && !QUOTA_EXHAUSTED.test(String(e.message))) {
        rateLimited += 1;
      }
      errors.push(`${model}: ${e.message}`);
    }
  }
  if (rateLimited === ladder.length) return legResult(leg, { code: 1, stderr: "ERROR: 429 Too Many Requests" });
  return { ...legResult(leg, {}), error: `failed: every Gemini rung failed: ${errors.join("; ")}` };
}

/** Chat Completions reports cached tokens as a subset of prompt tokens. The common
 * pin shape prices the entire prompt; retain cache counts separately for the ledger. */
export function openaiApiUsage(usage) {
  const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const tokensIn = count(usage?.prompt_tokens);
  const tokensOut = count(usage?.completion_tokens);
  const cached = count(usage?.prompt_tokens_details?.cached_tokens);
  return { tokensIn, tokensOut,
    tokensCached: cached !== null && (tokensIn === null || cached <= tokensIn) ? cached : null };
}

/** One request, one origin binding, one credential. No SDK, retries, or fallback. */
export async function runOpenAIAPILeg(leg, userMessage, { sourceEnv = process.env, timeoutMs, spawnFn = spawn } = {}) {
  const failure = (kind, reason, extra = {}) => ({
    ...legResult(leg, {}), kind, reason, answered: false,
    error: `${kind === "not-run" ? "not run" : "failed"}: ${leg.leg} (${leg.id}): ${reason}`,
    tokensIn: null, tokensOut: null, tokensCached: null, usd: null, ...extra,
  });
  const { env, missing, refusal } = envForLeg(leg, sourceEnv);
  if (refusal) return failure("not-run", refusal);
  if (missing.length) return failure("not-run", `${missing[0]} is absent on this machine`);
  const key = env[leg.envKeys[0]];
  const redact = (value) => String(value).split(key).join("[REDACTED]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
  const duration = timeoutMs ?? leg.timeoutMs ?? OPENAI_API_TIMEOUT_MS;
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 2_147_483_647) {
    return failure("not-run", "openai-api timeoutMs must be a positive integer no greater than 2147483647");
  }
  try {
    // An in-process env object would not isolate Node's TLS startup settings. Start a
    // fresh Node worker with ONLY this key and no inherited argv/execArgv or dispatcher.
    const response = await new Promise((resolveRequest, rejectRequest) => {
      let child, out = "", err = "", settled = false;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { try { child?.kill("SIGKILL"); } catch { /* process already ended */ } }
        if (error) rejectRequest(error); else resolveRequest(value);
      };
      const timer = setTimeout(() => {
        done(new Error(`openai-api timed out after ${duration}ms`));
      }, duration);
      try {
        child = spawnFn(process.execPath, [fileURLToPath(new URL("./openaiApiWorker.mjs", import.meta.url))], {
          env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdout.setEncoding?.("utf8");
        child.stderr.setEncoding?.("utf8");
        child.stdout.on("data", (data) => { out += data.toString(); });
        child.stderr.on("data", (data) => { err += data.toString(); });
        child.on("error", (error) => done(error));
        child.on("close", (code) => {
          let result;
          try { result = JSON.parse(out); }
          catch { done(new Error(`openai-api worker exited ${code}: ${err || "no valid response"}`)); return; }
          if (code !== 0 || result.error) done(new Error(result.error || `openai-api worker exited ${code}`));
          else done(null, result);
        });
        child.stdin.on?.("error", (error) => done(error));
        child.stdin.write(JSON.stringify({ endpoint: openaiApiEndpoint(leg), model: leg.id,
          content: `${userMessage}\n\n${FINDING_CONTRACT}`, keyName: leg.envKeys[0], timeoutMs: duration }));
        child.stdin.end();
      } catch (error) { done(error); }
    });
    const { status, body } = response;
    if (status < 200 || status >= 300) {
      if (status === 429 && !QUOTA_EXHAUSTED.test(body)) return failure("failed", "rate limited", { status });
      return failure(status === 401 ? "not-run" : "failed",
        `HTTP ${status}: ${redact(body).slice(0, 200)}`, { status });
    }
    let result;
    try { result = JSON.parse(body); }
    catch { return failure("failed", "response was not valid JSON"); }
    const content = result?.choices?.[0]?.message?.content;
    const raw = typeof content === "string" ? redact(content) : "";
    const usage = openaiApiUsage(result?.usage);
    return { ...legResult(leg, { code: 0, stdout: raw }), ...usage,
      usd: geminiCostUSD(leg.id, usage, leg.pricesUSDPer1M) };
  } catch (error) {
    return failure("failed", `openai-api request failed: ${redact(error.message).slice(0, 200)}`);
  }
}

/**
 * Grok's `--output-format json` wraps the reply as { text, usage, ... }. Unwrap it so the findings
 * parser reads the model's words, and keep the counts it reports. Anything that is not that
 * wrapper passes through untouched, so a crash or refusal is classified on what was printed.
 */
export function unwrapGrokOutput(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout || "").trim()); } catch { return { stdout, usage: null }; }
  if (!parsed || typeof parsed !== "object" || typeof parsed.text !== "string") return { stdout, usage: null };
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const u = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {};
  return { stdout: parsed.text, usage: { tokensIn: count(u.input_tokens), tokensOut: count(u.output_tokens),
    tokensCached: count(u.cache_read_input_tokens) } };
}

/** The one stdin line an agy seat receives: a stream-json user message carrying the prompt. */
export function agyInput(promptText) {
  return `${JSON.stringify({ event: "user", message: { content: promptText } })}\n`;
}

/**
 * agy's stream-json stdout is NDJSON ending in one `result` event. Read the LAST result line and
 * skip anything unparseable. `found: false` means no result arrived, so the caller classifies on
 * the exit code and timer alone; the step_update deltas are never treated as a reply.
 * Thinking tokens are counted as output, as Gemini bills them.
 */
export function unwrapAgyOutput(stdout) {
  let result = null;
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.event === "result" && parsed.result && typeof parsed.result === "object") result = parsed.result;
    } catch { /* a partial or foreign line is not the result */ }
  }
  if (!result) return { found: false, stdout: "", status: null, error: null, finishedReason: null, usage: null };
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const u = result.usage && typeof result.usage === "object" ? result.usage : {};
  const out = count(u.output_tokens);
  return {
    found: true,
    stdout: typeof result.response === "string" ? result.response : "",
    status: typeof result.status === "string" ? result.status : null,
    error: typeof result.error === "string" ? result.error : null,
    finishedReason: typeof result.finished_reason === "string" ? result.finished_reason : null,
    usage: { tokensIn: count(u.input_tokens), tokensOut: out === null ? null : out + (count(u.thinking_tokens) ?? 0),
      tokensCached: count(u.cache_read_tokens) },
  };
}

export const AGY_PLAN_LIMIT_REASON = "Google AI Pro allowance used up; waits for the reset (the paid key is never used instead)";
export const AGY_SIGN_IN_REASON = "Antigravity is not signed in; run agy once to sign in with the Google AI Pro account";

/**
 * The agy outcomes the shared classifier cannot see, because agy reports them inside the result
 * event (and has exited 0 while doing so). Null means "classify the response as any other leg".
 */
export function agyOutcome(unwrapped) {
  if (!unwrapped?.found) return null;
  // agy omits finished_reason on a normal finish (measured). Only that, or a value that names a
  // normal stop, lets a SUCCESS be read as a review: max_tokens, a timeout, SAFETY, RECITATION or
  // any reason not on this list may have cut the findings short.
  const finished = unwrapped.finishedReason?.toLowerCase() ?? null;
  if (unwrapped.status === "SUCCESS" && (finished === null || ["stop", "end_turn", "completed"].includes(finished))) return null;
  if (unwrapped.status === "SUCCESS" || ["print_timeout", "interrupted", "max_tokens"].includes(finished)) {
    return { kind: "failed", reason: `agy stopped early (${unwrapped.finishedReason}); a partial answer is not a review` };
  }
  const error = unwrapped.error || "";
  const detail = error ? redact(error.split("\n")[0]).slice(0, 160) : undefined;
  // A spent allowance in agy's own words. Kept narrow: Gemini's per-minute 429 also says
  // "quota" and RESOURCE_EXHAUSTED, and that one is retried once below rather than parked.
  if (/AI credits balance is too low|(?:weekly|daily|7-day|5-hour) (?:usage )?limit|usage limit (?:reached|exceeded)|allowance (?:is )?(?:used up|exhausted)/i.test(error)) {
    return { kind: "not-run", reason: AGY_PLAN_LIMIT_REASON, ...(detail ? { detail } : {}) };
  }
  if (/\b429\b|too many requests|rate[ _-]?limit|resource[ _-]?exhausted|quota/i.test(error)) {
    return { kind: "failed", reason: "rate limited", ...(detail ? { detail } : {}) };
  }
  if (/authentication expired|not logged in|log back in|please sign in|sign in to continue/i.test(error)) {
    return { kind: "not-run", reason: AGY_SIGN_IN_REASON };
  }
  if (/^invalid model selection/i.test(error)) {
    return { kind: "failed", reason: "model not offered by Antigravity", invalidModel: true, ...(detail ? { detail } : {}) };
  }
  return { kind: "failed", reason: "unrecognised", ...(detail ? { detail } : {}) };
}

/** Claude's JSON envelope names the answering model separately from the CLI alias. */
export function unwrapClaudeOutput(stdout) {
  const unchanged = { stdout, model: null, usage: null, isError: false };
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return unchanged; }
  if (!parsed || typeof parsed.result !== "string") return unchanged;
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const usage = parsed.usage;
  const models = parsed.modelUsage;
  return {
    stdout: parsed.result,
    // The reviewer is the model that wrote the most output; a helper model can be listed first.
    model: models && typeof models === "object" && !Array.isArray(models)
      ? Object.entries(models).sort(([, a], [, b]) => (Number(b?.outputTokens) || 0) - (Number(a?.outputTokens) || 0))[0]?.[0] ?? null
      : null,
    usage: { tokensIn: count(usage?.input_tokens), tokensOut: count(usage?.output_tokens),
      tokensCached: count(usage?.cache_read_input_tokens) },
    isError: Boolean(parsed.is_error),
  };
}

/** A vendor refusal gets one delayed retry, regardless of the runner that produced it. */
export async function retryRateLimited(leg, invoke, { sourceEnv = process.env, log = console.error,
  wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)), random = Math.random } = {}) {
  const first = await invoke();
  if (first.reason !== "rate limited") return first;
  const configured = Number(sourceEnv.TRIBUNAL_RATE_LIMIT_RETRY_MS?.trim() || RATE_LIMIT_RETRY_MS);
  const delay = Number.isSafeInteger(configured) && configured >= 0 && configured <= 2_147_483_647
    ? configured : RATE_LIMIT_RETRY_MS;
  const actualWait = Math.min(2_147_483_647, delay + Math.floor(random() * delay / 4));
  log(`[panel] ${leg.leg}: rate limited by the vendor, retrying once in ${actualWait >= 1000 ? Math.round(actualWait / 1000) : actualWait / 1000}s`);
  await wait(actualWait);
  const second = await invoke();
  if (second.reason !== "rate limited") return second;
  const reason = "rate limited (retried once); wait a few minutes and run again";
  return { ...second, reason, error: `failed: ${reason}` };
}

export function runLeg(leg, userMessage, options = {}) {
  return retryRateLimited(leg, () => runLegOnce(leg, userMessage, options), options);
}

function runLegOnce(leg, userMessage, options = {}) {
  // An agy id the CLI does not offer gets ONE try on the row's fallback id; run.mjs then prints
  // the DEMOTED warning because the answering model differs from the primary.
  if (leg.runner === "agy-cli" && leg.fallback && leg.fallback !== leg.id) {
    return spawnLeg(leg, userMessage, options).then((first) => (first.invalidModel
      ? spawnLeg({ ...leg, id: leg.fallback }, userMessage, options) : first));
  }
  return spawnLeg(leg, userMessage, options);
}

function spawnLeg(leg, userMessage, { timeoutMs, sourceEnv = process.env, spawnFn = spawn, mkTemp = () => mkdtemp(join(tmpdir(), "tribunal-leg-")), contract = FINDING_CONTRACT, generateContent, platform = process.platform } = {}) {
  if (leg.runner === "genai-sdk") return runGeminiLeg(leg, userMessage, { sourceEnv, generateContent });
  if (leg.runner === "openai-api") return runOpenAIAPILeg(leg, userMessage, { timeoutMs, sourceEnv, spawnFn });
  timeoutMs ??= DEFAULT_TIMEOUT_MS;
  const { missing } = envForLeg(leg, sourceEnv);
  if (missing.length) {
    return Promise.resolve(legResult(leg, { missingCredentials: missing }));
  }
  const grok = leg.runner === "grok-cli";
  const agy = leg.runner === "agy-cli";
  // policy.mjs already turns the seat off here; this holds for a leg built in code too.
  if (agy && !agyHomeIsolated(platform)) {
    return Promise.resolve({ ...legResult(leg, {}), kind: "not-run", answered: false, findings: [], raw: "",
      reason: `the Antigravity seat runs only on Windows; ${platform} is not measured`,
      error: `not run: the Antigravity seat runs only on Windows; ${platform} is not measured` });
  }
  const promptText = `${userMessage}\n\n${contract}`;
  return mkTemp().then((cwd) => new Promise((resolve) => {
    // The Grok leg's home variables point at this same fresh directory (see envForLeg).
    const { env } = envForLeg(leg, sourceEnv, { home: grok || (agy && agyHomeIsolated(platform)) ? cwd : null });
    // Remove each invocation's temporary directory to prevent accumulation during loops.
    // Cleanup is best-effort so a failed removal cannot delay or discard the review result.
    const done = (r) => {
      const stderr = stripEchoedPrompt(err, promptText);
      if (isOurTempDir(cwd)) rm(cwd, { recursive: true, force: true }).catch(() => {});
      if (leg.runner === "claude-cli") {
        const unwrapped = unwrapClaudeOutput(out);
        const signals = { stdout: unwrapped.stdout, stderr, timeoutMs, ...r };
        // An error envelope cannot become a successful review just because the CLI exited zero.
        if (unwrapped.isError && signals.code === 0) signals.code = 1;
        resolve({ ...legResult({ ...leg, id: unwrapped.model ?? leg.id }, signals),
          ...(unwrapped.usage || {}) });
        return;
      }
      if (agy) {
        const unwrapped = unwrapAgyOutput(out);
        const tokens = { tokensIn: unwrapped.usage?.tokensIn ?? null, tokensOut: unwrapped.usage?.tokensOut ?? null,
          tokensCached: unwrapped.usage?.tokensCached ?? null };
        const fixed = r.timedOut || r.spawnError ? null : agyOutcome(unwrapped);
        if (fixed) {
          const { invalidModel, ...outcome } = fixed;
          resolve({ ...legResult(leg, {}), ...outcome, answered: false, findings: [], raw: unwrapped.stdout,
            parseFailed: false, shortUnrecognised: false, ...(invalidModel ? { invalidModel: true } : {}),
            error: `${outcome.kind === "not-run" ? "not run" : "failed"}: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`,
            ...tokens });
          return;
        }
        // Only a SUCCESS result can be a review; with no result event an exit 0 is an empty reply.
        resolve({ ...legResult(leg, { stdout: unwrapped.stdout, stderr, timeoutMs, ...r }), ...tokens });
        return;
      }
      if (!grok) { resolve(legResult(leg, { stdout: out, stderr, timeoutMs, ...r })); return; }
      const unwrapped = unwrapGrokOutput(out);
      resolve({ ...legResult(leg, { stdout: unwrapped.stdout, stderr, timeoutMs, ...r }),
        tokensIn: unwrapped.usage?.tokensIn ?? null, tokensOut: unwrapped.usage?.tokensOut ?? null,
        tokensCached: unwrapped.usage?.tokensCached ?? null });
    };
    let out = "", err = "", settled = false, child;
    const { file, prefix } = resolveExe(leg.runner === "claude-cli" ? "claude" : grok ? "grok" : agy ? "agy" : "codex");
    try {
      child = spawnFn(file, [...prefix, ...argsForLeg(leg)], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      done({ spawnError: e });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done({ timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      done({ spawnError: e });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      done({ code });
    });
    // A CLI that exits before reading (agy refusing an unknown --model) closes the pipe; the
    // write then errors, and an unheard error would crash the whole panel.
    child.stdin.on?.("error", () => {});
    child.stdin.write(agy ? agyInput(promptText) : promptText);
    child.stdin.end();
  }));
}
