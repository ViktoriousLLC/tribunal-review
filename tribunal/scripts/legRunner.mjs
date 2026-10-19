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

export const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;

// Exact vendor refusal text; unrelated hook output on stderr does not turn it into a crash.
export const FABLE_PLAN_LIMIT_REPLY = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
export const SHORT_REPLY_BYTES = 256;

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
  return { kind: "failed", reason: "unrecognised" };
}

function legResult(leg, signals) {
  const raw = signals.stdout || "";
  const outcome = classifyLegOutcome({ ...signals, model: leg.id });
  const { findings, parseError } = parseFindings(raw);
  return {
    leg: leg.leg, model: leg.id, ...outcome,
    // Keep the legacy distinction: prose is an answer we could not read.
    answered: outcome.kind !== "not-run" && Boolean(raw.trim()),
    error: outcome.kind === "answered" ? null : `${outcome.kind === "not-run" ? "not run" : "failed"}: ${outcome.reason}`,
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
      "--disallowedTools", CLAUDE_REFUSED_TOOLS.join(","),
      "--setting-sources", "",
      "--strict-mcp-config",
    ];
  }
  if (leg.runner === "codex-cli") {
    return [
      "exec", "-m", leg.id, "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
      ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
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
export async function runGeminiLeg(leg, userMessage) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return legResult(leg, { missingCredentials: ["GEMINI_API_KEY"] });
  let GoogleGenAI;
  try {
    ({ GoogleGenAI } = await import("@google/genai"));
  } catch (e) {
    return { ...legResult(leg, {}), error: `failed: @google/genai is not installed: ${e.message}` };
  }
  const ai = new GoogleGenAI({ apiKey: key });
  const ladder = [...new Set([leg.id, leg.fallback].filter(Boolean))];
  const errors = [];
  for (const model of ladder) {
    try {
      const res = await ai.models.generateContent({ model, contents: `${userMessage}\n\n${FINDING_CONTRACT}` });
      const raw = res?.text ?? "";
      const usage = geminiUsage(res?.usageMetadata);
      return {
        ...legResult({ ...leg, id: model }, { code: 0, stdout: raw }),
        tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null,
        usd: geminiCostUSD(model, usage, leg.pricesUSDPer1M),
      };
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
    }
  }
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

export function runLeg(leg, userMessage, { timeoutMs, sourceEnv = process.env, spawnFn = spawn, mkTemp = () => mkdtemp(join(tmpdir(), "tribunal-leg-")) } = {}) {
  if (leg.runner === "genai-sdk") return runGeminiLeg(leg, userMessage);
  if (leg.runner === "openai-api") return runOpenAIAPILeg(leg, userMessage, { timeoutMs, sourceEnv, spawnFn });
  timeoutMs ??= DEFAULT_TIMEOUT_MS;
  const { missing } = envForLeg(leg, sourceEnv);
  if (missing.length) {
    return Promise.resolve(legResult(leg, { missingCredentials: missing }));
  }
  const grok = leg.runner === "grok-cli";
  return mkTemp().then((cwd) => new Promise((resolve) => {
    // The Grok leg's home variables point at this same fresh directory (see envForLeg).
    const { env } = envForLeg(leg, sourceEnv, { home: grok ? cwd : null });
    // Remove each invocation's temporary directory to prevent accumulation during loops.
    // Cleanup is best-effort so a failed removal cannot delay or discard the review result.
    const done = (r) => {
      if (isOurTempDir(cwd)) rm(cwd, { recursive: true, force: true }).catch(() => {});
      if (!grok) { resolve(legResult(leg, { stdout: out, stderr: err, timeoutMs, ...r })); return; }
      const unwrapped = unwrapGrokOutput(out);
      resolve({ ...legResult(leg, { stdout: unwrapped.stdout, stderr: err, timeoutMs, ...r }),
        tokensIn: unwrapped.usage?.tokensIn ?? null, tokensOut: unwrapped.usage?.tokensOut ?? null,
        tokensCached: unwrapped.usage?.tokensCached ?? null });
    };
    let out = "", err = "", settled = false, child;
    const { file, prefix } = resolveExe(leg.runner === "claude-cli" ? "claude" : grok ? "grok" : "codex");
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
    child.stdin.write(`${userMessage}\n\n${FINDING_CONTRACT}`);
    child.stdin.end();
  }));
}
