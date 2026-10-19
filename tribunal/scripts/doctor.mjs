#!/usr/bin/env node
// Run from the consumer repository: node <plugin-root>/scripts/doctor.mjs.
// No model requests: only help/auth status, credential names, and filesystem checks.
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, openSync, closeSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argsForLeg, envForLeg } from "./legRunner.mjs";
import { resolveExe } from "./executable.mjs";
import { resolvePolicy } from "./policy.mjs";

const require = createRequire(import.meta.url);
const NODE_RANGE = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).engines.node;
const PROBE_TIMEOUT_MS = 15_000;
const firstLine = (text) => String(text || "").split(/\r?\n/)[0];
const outputOf = (result) => [result.stdout, result.stderr].filter(Boolean).join("\n");
const failureOf = (result) => result.error?.code || result.error?.message || `exit ${result.status}`;

function hasCommand(help, command) {
  return new RegExp(`^\\s+${command}(?:\\s|$)`, "m").test(help);
}

function authStatus(result) {
  const stdout = String(result.stdout || ""), stderr = String(result.stderr || "");
  const reply = firstLine(stdout || stderr);
  let data;
  for (const candidate of [stdout.trim(), firstLine(stdout)]) {
    try { data = JSON.parse(candidate); break; } catch { /* text status is supported too */ }
  }
  const text = outputOf(result).trim();
  let login = "not detectable", billing = "not detectable";
  if (!result.error) {
    if (data?.loggedIn === false || /^(?:not logged in|not authenticated|logged out)\b/im.test(text)) login = "not logged-in";
    else if (result.status === 0 && (data?.loggedIn === true || /^logged in\b/im.test(text))) login = "logged-in";
    // Only explicit CLI evidence establishes billing; exit 0 alone says nothing about it.
    if (login === "logged-in") {
      const method = String(data?.authMethod || "").toLowerCase();
      const subscription = typeof data?.subscriptionType === "string" ? data.subscriptionType.trim() : "";
      if (["api_key", "api-key", "apikey"].includes(method) || /^logged in using (?:an? )?api[ -]key\b/im.test(text)) billing = "API key";
      else if (subscription && !/^(none|null|unknown)$/i.test(subscription)) billing = `subscription (${subscription})`;
      else if (method === "claude.ai" || /^logged in using (?:chatgpt|claude\.ai)\b/im.test(text)) billing = "subscription";
    }
  }
  // A pretty-printed JSON status has "{" as its first line, which tells the reader nothing;
  // show the parsed authentication fields compactly instead.
  const shown = data && typeof data === "object"
    ? JSON.stringify(Object.fromEntries(Object.entries(data).filter(([k]) => ["loggedIn", "authMethod", "subscriptionType"].includes(k))))
    : reply;
  return { login, billing, reply: shown || (result.error ? failureOf(result) : "(no output)") };
}

function writableDirectory(path, create, openFile) {
  let handle, file, created = false;
  try {
    if (create) mkdirSync(path, { recursive: true });
    file = join(path, `.tribunal-doctor-${randomUUID()}`);
    handle = openFile(file, "wx");
    created = true;
    closeSync(handle); handle = undefined;
    unlinkSync(file); file = undefined;
    return { ok: true, detail: `writable (${path})` };
  } catch (error) {
    return { ok: false, detail: `not writable (${path}): ${error.code || error.message}` };
  } finally {
    if (handle !== undefined) { try { closeSync(handle); } catch { /* report original failure */ } }
    if (created && file) { try { unlinkSync(file); } catch { /* report original failure */ } }
  }
}

function sdkAvailable() {
  try { require.resolve("@google/genai"); return true; } catch { return false; }
}

/** Exit 0 means all enabled seats and mandatory machine checks passed; gh is optional. */
export function runDoctor({ cwd = process.cwd(), policy = resolvePolicy(cwd), sourceEnv = process.env,
  nodeVersion = process.versions.node, tempDir = tmpdir(), spawnFn = spawnSync,
  resolveExeFn = resolveExe, sdkAvailableFn = sdkAvailable, openFileFn = openSync } = {}) {
  const lines = [];
  let ok = true;
  for (const leg of policy.registry) {
    const { env, missing, refusal } = envForLeg(leg, sourceEnv);
    const credentials = (leg.requiredEnv || []).map((key) =>
      `${key}=${refusal ? "not read (untrusted origin)" : env[key] ? "set" : "unset"}`).join(", ") || "none required";
    let runnable = !refusal && missing.length === 0;
    const details = [];
    if (leg.runner === "claude-cli" || leg.runner === "codex-cli") {
      const command = leg.runner === "claude-cli" ? "claude" : "codex";
      const executable = resolveExeFn(command, { env });
      if (!executable.found) {
        runnable = false;
        details.push(`binary: ${command} missing on PATH (searched: ${executable.searchedDirs.join(", ") || "PATH is empty"})`,
          "login: not detectable", "auth reply: (not run)", "billing: not detectable", "flags: not checked (binary missing)");
      } else {
        details.push(`binary: ${[executable.file, ...executable.prefix].join(" ")}`);
        const invoke = (args) => {
          try {
            return spawnFn(executable.file, [...executable.prefix, ...args], {
              cwd: policy.repoRoot, env, shell: false, encoding: "utf8", input: "",
              timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true,
            });
          } catch (error) { return { error, status: null, stdout: "", stderr: "" }; }
        };
        const args = argsForLeg(leg);
        const help = invoke([...args, "--help"]);
        const flags = [...new Set(args.filter((value) => /^--?[^-]/.test(value)))];
        const documented = new Set(outputOf(help).match(/--?[A-Za-z][\w-]*/g) || []);
        const absent = flags.filter((flag) => !documented.has(flag));
        const flagsOK = !help.error && help.status === 0 && absent.length === 0;
        const flagDetail = help.error || help.status !== 0 ? `help failed (${failureOf(help)})`
          : absent.length ? `missing ${absent.join(", ")}` : "accepted";

        // Discover Claude's auth -> status and Codex's login -> status commands in CLI help
        // before invoking them, so unsupported commands produce a named diagnostic.
        // Always the ROOT help: `claude -p ... --help` prints the options only and omits the
        // Commands section needed to discover authentication status.
        const rootHelp = invoke(["--help"]);
        const group = command === "claude" ? "auth" : "login";
        let auth = { login: "not detectable", billing: "not detectable", reply: "(auth status not advertised by --help)" };
        if (!rootHelp.error && rootHelp.status === 0 && hasCommand(outputOf(rootHelp), group)) {
          const groupHelp = invoke([group, "--help"]);
          if (!groupHelp.error && groupHelp.status === 0 && hasCommand(outputOf(groupHelp), "status")) {
            auth = authStatus(invoke([group, "status"]));
          }
        }
        details.push(`login: ${auth.login}`, `auth reply: ${auth.reply}`, `billing: ${auth.billing}`, `flags: ${flagDetail}`);
        runnable &&= flagsOK && auth.login === "logged-in";
      }
    } else if (leg.runner === "grok-cli") {
      // Grok Build has no auth-status command; the panel's own sign-in is its auth.json in the
      // panel Grok home (never ~/.grok). Presence is all this can say, so a stale refresh token
      // still shows as signed in here and is caught by the isolation probe instead.
      const executable = resolveExeFn("grok", { env });
      const signedIn = Boolean(env.GROK_HOME) && existsSync(join(env.GROK_HOME, "auth.json"));
      runnable &&= executable.found && signedIn;
      details.push(executable.found ? `binary: ${executable.file}` : "binary: grok missing on PATH and ~/.grok/bin",
        `login: ${signedIn ? "panel Grok home has a sign-in" : `not signed in; run GROK_HOME=${env.GROK_HOME} grok login --device-auth`}`,
        `billing: ${leg.billing}`, `advisory: ${leg.advisory === true}`);
    } else if (leg.runner === "genai-sdk") {
      const installed = sdkAvailableFn();
      runnable &&= installed;
      details.push("binary: n/a (SDK)", "login: n/a (requiredEnv)", `billing: ${leg.billing}`,
        `SDK: @google/genai ${installed ? "installed" : "missing; run npm ci in tribunal/scripts"}`);
    } else if (leg.runner === "openai-api") {
      details.push("binary: n/a (built-in fetch)", "login: n/a (requiredEnv)", `billing: ${leg.billing}`,
        refusal ? `trust: ${refusal}` : "trust: authorized variable/origin pair");
    } else {
      runnable = false;
      details.push(`runner: unsupported ${leg.runner}`);
    }
    details.push(`credentials: ${credentials}`);
    const state = leg.skippedNotInstalled ? "skipped" : leg.enabled ? "enabled" : "disabled";
    lines.push(`${leg.leg} [${state}]: ${runnable ? "runnable" : "not runnable"}; ${details.join("; ")}`);
    // An advisory seat that cannot run is reported, never a failed doctor: it never counts.
    if (leg.enabled && !runnable && !leg.advisory) ok = false;
  }

  lines.push("machine:");
  // package-lock.json pins @google/genai 2.21.0 with engines.node >=20.0.0.
  // The root deliberately uses the same major floor, including for dependency-free CLI legs.
  const floor = /^>=(\d+)$/.exec(NODE_RANGE);
  const version = /^v?(\d+)\.\d+\.\d+$/.exec(nodeVersion);
  const nodeOK = Boolean(floor && version && Number(version[1]) >= Number(floor[1]));
  lines.push(`Node: ${nodeVersion}; required ${NODE_RANGE}; ${nodeOK ? "OK" : "FAIL"}`);
  const ledger = writableDirectory(policy.ledgerHome, true, openFileFn);
  const temp = writableDirectory(tempDir, false, openFileFn);
  lines.push(`ledger home: ${ledger.detail}`, `OS temp: ${temp.detail}`);
  const gh = resolveExeFn("gh", { env: sourceEnv });
  lines.push(`gh: ${gh.found ? gh.file : "missing on PATH"}; only --pr and proof posting need it`);
  // A seat whose CLI is absent is skipped rather than failed, so the one state that must
  // still exit 1 is "no seat can run at all": nothing installed, nothing enabled.
  if (!policy.registry.some((leg) => leg.enabled)) {
    lines.push("no seat can run: install the Claude CLI (claude) or the Codex CLI (codex) and sign in, then run doctor again");
    ok = false;
  }
  return { lines, exitCode: ok && nodeOK && ledger.ok && temp.ok ? 0 : 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runDoctor();
    console.log(result.lines.join("\n"));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`tribunal doctor failed: ${error.message}`);
    process.exitCode = 1;
  }
}
