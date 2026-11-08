// The Antigravity (agy) seat: Gemini on the Google AI Pro sign-in, never on a key (DEV-1525).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolvePolicy } from "./policy.mjs";
import {
  argsForLeg, envForLeg, runLeg, unwrapAgyOutput, agyOutcome, agyInput,
  AGY_FORBIDDEN_ENV, AGY_SETTINGS, AGY_PLAN_LIMIT_REASON, AGY_SIGN_IN_REASON,
} from "./legRunner.mjs";
import { validateLegs } from "./registry.mjs";
import { resolveExe } from "./executable.mjs";
import { cliCommand, argvShapeHash } from "./isolationBinding.mjs";
import { probeAgy } from "./isolationProbe.mjs";
import { legVerdict } from "./isolationProbeLogic.mjs";
import { demotionWarnings } from "./run.mjs";
import { runDoctor } from "./doctor.mjs";

const agyLeg = { leg: "gemini", id: "gemini-4-argon-medium", fallback: "gemini-3.8-flash-high", vendor: "google",
  runner: "agy-cli", billing: "plan", envKeys: [], enabled: true };

const result = (r) => JSON.stringify({ event: "result", result: r });
const init = JSON.stringify({ event: "init", conversation_id: "c", init: { model: "m" } });
const step = JSON.stringify({ event: "step_update", step_update: { state: "ACTIVE", text_delta: '{"findings":[' } });
const FINDINGS = '{"findings":[{"title":"t","severity":"NIT"}]}';
const USAGE = { input_tokens: 100, output_tokens: 20, thinking_tokens: 30, cache_read_tokens: 5, total_tokens: 150 };

/** A fake agy: records argv, env, cwd and stdin, then prints `lines` and exits `code`. */
function fakeAgy(script) {
  const calls = [];
  const spawnFn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let input = "";
    child.stdin = { write(d) { input += d; }, end() {} };
    child.kill = () => {};
    const call = { file, args, opts, get input() { return input; } };
    calls.push(call);
    const { lines, code = 0, stderr = "" } = script(call, calls.length);
    setImmediate(() => {
      if (lines.length) child.stdout.emit("data", `${lines.join("\n")}\n`);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", code);
    });
    return child;
  };
  return { spawnFn, calls };
}

const run = (leg, script, sourceEnv = { PATH: "/bin", USERPROFILE: "C:/Users/u", LOCALAPPDATA: "C:/Users/u/AppData/Local" }) => {
  const fake = fakeAgy(script);
  return runLeg(leg, "review this", { spawnFn: fake.spawnFn, mkTemp: async () => "C:/tmp/tribunal-leg-agy",
    sourceEnv, platform: "win32" }).then((r) => ({ r, calls: fake.calls }));
};

test("an agy-cli row is valid only as a keyless google plan seat", () => {
  assert.deepEqual(validateLegs([agyLeg]), []);
  const cases = [
    [{ billing: "metered" }, /billing must be "plan"/],
    [{ envKeys: ["GEMINI_API_KEY"] }, /envKeys must be empty/],
    [{ envKeys: ["AGY_BIN"] }, /envKeys must be empty/],
    [{ requiredEnv: ["GEMINI_API_KEY"] }, /requires no environment variable/],
    [{ vendor: "anthropic" }, /vendor must be "google"/],
    [{ effort: "ultra" }, /no "ultra" effort/],
  ];
  for (const [change, pattern] of cases) {
    const problems = validateLegs([{ ...agyLeg, ...change }]);
    assert.ok(problems.some((p) => pattern.test(p)), `${JSON.stringify(change)}: ${problems.join("; ")}`);
  }
  assert.ok(validateLegs([{ ...agyLeg, envKeys: ["GEMINI_API_KEY"] }]).some((p) => /agent runner and would receive GEMINI_API_KEY/.test(p)));
});

test("envForLeg hands an agy seat none of the names that would put it on a bill", () => {
  const source = { PATH: "/bin", USERPROFILE: "C:/Users/u", APPDATA: "C:/a", LOCALAPPDATA: "C:/l" };
  for (const k of AGY_FORBIDDEN_ENV) source[k] = `secret-${k}`;
  // Even a row built in code that names them (the registry refuses this shape) gets none.
  const { env, missing } = envForLeg({ ...agyLeg, envKeys: [...AGY_FORBIDDEN_ENV] }, source);
  for (const k of AGY_FORBIDDEN_ENV) assert.equal(env[k], undefined, k);
  assert.deepEqual(missing, []);
  assert.equal(env.USERPROFILE, "C:/Users/u");
  assert.equal(env.LOCALAPPDATA, "C:/l");
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AGY_ADC_AUTH"]) {
    assert.ok(AGY_FORBIDDEN_ENV.includes(k), k);
  }
  // Windows variable names are case-insensitive, so a lower-case spelling is the same key.
  const lower = envForLeg({ ...agyLeg, envKeys: ["gemini_api_key", "Google_Api_Key"] },
    { PATH: "/bin", gemini_api_key: "g", Google_Api_Key: "k" }).env;
  assert.equal(lower.gemini_api_key, undefined);
  assert.equal(lower.Google_Api_Key, undefined);
});

test("agy argv: stream-json both ways, the model, no prompt argument, and the deny-all settings", () => {
  const args = argsForLeg(agyLeg);
  assert.deepEqual(args, [
    "--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-4-argon-medium",
    "--disable-slash-commands", "--settings", JSON.stringify(AGY_SETTINGS),
  ]);
  assert.ok(!args.includes("-p") && !args.includes("--print") && !args.includes("--dangerously-skip-permissions"));
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.equal(settings.useG1Credits, false, "a spent allowance must never be paid from AI credits");
  for (const rule of ["command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)", "unsandboxed(*)"]) {
    assert.ok(settings.permissions.deny.includes(rule), rule);
  }
  assert.deepEqual(argsForLeg({ ...agyLeg, effort: "high" }).slice(6, 8), ["--effort", "high"]);
});

test("agyInput is one stream-json user line carrying the prompt verbatim", () => {
  const prompt = 'diff with "quotes"\nand a newline';
  const line = agyInput(prompt);
  assert.ok(line.endsWith("\n"));
  assert.equal(line.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(line), { event: "user", message: { content: prompt } });
});

test("unwrapAgyOutput reads the last result event and skips everything else", () => {
  const ok = unwrapAgyOutput([init, step, "not json", result({ status: "SUCCESS", response: FINDINGS, usage: USAGE })].join("\n"));
  assert.equal(ok.found, true);
  assert.equal(ok.stdout, FINDINGS);
  assert.equal(ok.status, "SUCCESS");
  assert.deepEqual(ok.usage, { tokensIn: 100, tokensOut: 50, tokensCached: 5 });
  const none = unwrapAgyOutput([init, step].join("\n"));
  assert.equal(none.found, false);
  assert.equal(none.stdout, "", "step deltas are never a reply");
  const err = unwrapAgyOutput(result({ status: "ERROR", response: "", error: "boom", finished_reason: "error" }));
  assert.equal(err.status, "ERROR");
  assert.equal(err.error, "boom");
  assert.equal(err.finishedReason, "error");
  assert.equal(unwrapAgyOutput(result({ status: "SUCCESS", response: "x", usage: { input_tokens: -1 } })).usage.tokensIn, null);
  assert.equal(unwrapAgyOutput("").found, false);
});

test("agyOutcome names the refusals agy reports inside its result", () => {
  const e = (error) => agyOutcome({ found: true, status: "ERROR", error, finishedReason: "error" });
  assert.deepEqual(e("Your AI credits balance is too low to continue."), { kind: "not-run", reason: AGY_PLAN_LIMIT_REASON,
    detail: "Your AI credits balance is too low to continue." });
  assert.equal(e("You have reached your 7-day limit for this model").reason, AGY_PLAN_LIMIT_REASON);
  // A per-minute limit uses quota words too; it is a retryable rate limit, never a parked seat.
  for (const text of ["429 RESOURCE_EXHAUSTED: exceeded your current quota", "Too Many Requests", "rate limit exceeded"]) {
    assert.equal(e(text).reason, "rate limited", text);
  }
  assert.equal(e("token limit reached for this prompt").reason, "unrecognised", "an oversized prompt is not a spent allowance");
  assert.equal(e("sign in failed: unexpected token").reason, "unrecognised", "only the sign-in prompts themselves are a missing sign-in");
  assert.deepEqual(e("Authentication expired. Please log back in."), { kind: "not-run", reason: AGY_SIGN_IN_REASON });
  const bad = e('invalid model selection (--model "x"): model x is not recognized');
  assert.equal(bad.kind, "failed");
  assert.equal(bad.invalidModel, true);
  assert.equal(e("something else").reason, "unrecognised");
  assert.match(agyOutcome({ found: true, status: "SUCCESS", finishedReason: "print_timeout" }).reason, /stopped early/);
  assert.equal(agyOutcome({ found: true, status: "SUCCESS", finishedReason: null }), null);
  for (const finishedReason of ["stop", "end_turn"]) {
    assert.equal(agyOutcome({ found: true, status: "SUCCESS", finishedReason }), null, finishedReason);
  }
  assert.equal(agyOutcome({ found: true, status: "SUCCESS", finishedReason: "error", error: "x" }).kind, "failed");
  // A reply cut off at its output limit can still parse; it is not a whole review.
  assert.match(agyOutcome({ found: true, status: "SUCCESS", finishedReason: "max_tokens" }).reason, /stopped early \(max_tokens\)/);
  assert.equal(agyOutcome({ found: true, status: "SUCCESS", finishedReason: "MAX_TOKENS" }).kind, "failed", "vendor casing");
  for (const finishedReason of ["SAFETY", "RECITATION", "OTHER", "something_new"]) {
    assert.match(agyOutcome({ found: true, status: "SUCCESS", finishedReason }).reason, /stopped early/, finishedReason);
  }
  assert.equal(agyOutcome({ found: true, status: "SUCCESS", finishedReason: "STOP" }), null);
  assert.equal(agyOutcome({ found: false }), null);
});

test("runLeg runs agy in the fresh directory with the prompt on stdin and banks its tokens", async () => {
  const { r, calls } = await run(agyLeg, () => ({ lines: [init, step, result({ status: "SUCCESS", response: FINDINGS, usage: USAGE })] }),
    { PATH: "/bin", USERPROFILE: "C:/Users/u", GEMINI_API_KEY: "g-secret", GOOGLE_APPLICATION_CREDENTIALS: "C:/sa.json" });
  assert.equal(r.kind, "answered");
  assert.equal(r.findings.length, 1);
  assert.equal(r.model, "gemini-4-argon-medium");
  assert.deepEqual([r.tokensIn, r.tokensOut, r.tokensCached], [100, 50, 5]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.cwd, "C:/tmp/tribunal-leg-agy");
  assert.equal(calls[0].opts.env.GEMINI_API_KEY, undefined);
  assert.equal(calls[0].opts.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  const sent = JSON.parse(calls[0].input);
  assert.equal(sent.event, "user");
  assert.match(sent.message.content, /^review this/);
  assert.ok(!calls[0].args.some((a) => a.includes("review this")), "the artifact never rides on argv");
});

test("an ERROR result that exits 0 is never an answer", async () => {
  const { r } = await run(agyLeg, () => ({ lines: [result({ status: "ERROR", response: "", error: "Agent execution terminated due to error." })], code: 0 }));
  assert.equal(r.kind, "failed");
  assert.equal(r.answered, false);
  assert.match(r.error, /unrecognised \(Agent execution terminated due to error\.\)/);
});

test("a spent allowance is a named not-run, and nothing is re-run on a key", async () => {
  const { r, calls } = await run(agyLeg, () => ({ lines: [result({ status: "ERROR", error: "Your AI credits balance is too low to continue." })] }));
  assert.equal(r.kind, "not-run");
  assert.equal(r.reason, AGY_PLAN_LIMIT_REASON);
  assert.equal(calls.length, 1, "no retry, no fallback rung, no SDK call");
});

test("on Windows the seat runs in its own empty home; elsewhere it does not run at all", async () => {
  const sourceEnv = { PATH: "/bin", HOME: "/home/u", USERPROFILE: "C:/Users/u", APPDATA: "C:/Users/u/AppData/Roaming",
    LOCALAPPDATA: "C:/Users/u/AppData/Local" };
  const ok = () => ({ lines: [result({ status: "SUCCESS", response: FINDINGS, usage: USAGE })] });
  const win = fakeAgy(ok);
  await runLeg(agyLeg, "review this", { spawnFn: win.spawnFn, mkTemp: async () => "C:/tmp/tribunal-leg-agy", sourceEnv, platform: "win32" });
  for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) assert.equal(win.calls[0].opts.env[k], "C:/tmp/tribunal-leg-agy", k);
  for (const platform of ["linux", "darwin"]) {
    const fake = fakeAgy(ok);
    const r = await runLeg(agyLeg, "review this", { spawnFn: fake.spawnFn, mkTemp: async () => "C:/tmp/tribunal-leg-agy", sourceEnv, platform });
    assert.equal(fake.calls.length, 0, `${platform}: agy is never started with the real home`);
    assert.equal(r.kind, "not-run");
    assert.match(r.reason, /runs only on Windows/);
  }
});

test("policy turns an enabled Antigravity seat off outside Windows, even when enabledLegs names it", () => {
  const root = mkdtempSync(join(tmpdir(), "tribunal-agy-policy-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "models.json"), JSON.stringify({ legs: [agyLeg] }));
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify({ modelsFile: "models.json", enabledLegs: ["gemini"] }));
  const resolveExecutable = () => ({ found: true, file: "agy", prefix: [] });
  assert.equal(resolvePolicy(root, { resolveExecutable, platform: "win32" }).registry[0].enabled, true);
  const off = resolvePolicy(root, { resolveExecutable, platform: "linux" }).registry[0];
  assert.equal(off.enabled, false);
  assert.match(off.disabledReason, /runs only on Windows, where its empty-home isolation was measured; linux is not measured/);
});

test("a per-minute rate limit is retried once, and the second answer wins", async () => {
  const { r, calls } = await run(agyLeg, (call, n) => (n === 1
    ? { lines: [result({ status: "ERROR", error: "429 RESOURCE_EXHAUSTED: exceeded your current quota" })] }
    : { lines: [result({ status: "SUCCESS", response: FINDINGS, usage: USAGE })] }),
  { PATH: "/bin", USERPROFILE: "C:/Users/u", TRIBUNAL_RATE_LIMIT_RETRY_MS: "0" });
  assert.equal(calls.length, 2);
  assert.equal(r.kind, "answered");
});

test("a missing sign-in is a named not-run", async () => {
  const { r } = await run(agyLeg, () => ({ lines: [result({ status: "ERROR", error: "Authentication expired. Please log back in." })], code: 1 }));
  assert.equal(r.kind, "not-run");
  assert.equal(r.reason, AGY_SIGN_IN_REASON);
});

test("an id agy does not offer gets one run on the fallback id, and run.mjs calls it DEMOTED", async () => {
  const { r, calls } = await run(agyLeg, (call, n) => (n === 1
    ? { lines: [result({ status: "ERROR", error: 'invalid model selection (--model "gemini-4-argon-medium")' })] }
    : { lines: [result({ status: "SUCCESS", response: FINDINGS, usage: USAGE })] }));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[calls[1].args.indexOf("--model") + 1], "gemini-3.8-flash-high");
  assert.equal(r.kind, "answered");
  assert.equal(r.model, "gemini-3.8-flash-high");
  const warnings = demotionWarnings([r], [agyLeg]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gemini DEMOTED: primary rung gemini-4-argon-medium did not answer; gemini-3.8-flash-high answered/);
});

test("without a fallback, an unknown id fails loudly after one run", async () => {
  const { r, calls } = await run({ ...agyLeg, fallback: undefined },
    () => ({ lines: [result({ status: "ERROR", error: "invalid model selection" })] }));
  assert.equal(calls.length, 1);
  assert.equal(r.kind, "failed");
  assert.match(r.error, /model not offered by Antigravity/);
});

test("no result event with exit 0 is an empty reply, not an answer", async () => {
  const { r } = await run(agyLeg, () => ({ lines: [init, step], code: 0 }));
  assert.equal(r.kind, "failed");
  assert.equal(r.reason, "empty reply");
});

test("resolveExe finds agy at the installer path when PATH predates the install", () => {
  const winInstalled = join("C:\\Users\\u\\AppData\\Local", "agy", "bin", "agy.exe");
  const win = resolveExe("agy", { env: { Path: "C:\\nowhere", USERPROFILE: "C:\\Users\\u", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    platform: "win32", isFile: (p) => p === winInstalled });
  assert.equal(win.found, true);
  assert.equal(win.file, winInstalled);
  const posixInstalled = "/home/u/.local/bin/agy";
  const nix = resolveExe("agy", { env: { PATH: "/nowhere", HOME: "/home/u" }, platform: "linux",
    isFile: (p) => p === posixInstalled, canExecute: () => true });
  assert.equal(nix.found, true);
  assert.equal(nix.file, posixInstalled);
  assert.equal(cliCommand("agy-cli"), "agy");
});

test("the isolation probe certifies the agy seat: permissive control, guarded argv, stream-json input", async () => {
  const fake = fakeAgy(() => ({ lines: [result({ status: "SUCCESS", response: "no" })] }));
  let dirs = 0;
  const r = await probeAgy("read the canary", "injected diff", "CANARY-TOKEN-0123456789abcdef", agyLeg,
    { spawnFn: fake.spawnFn, mkTemp: async () => `C:/tmp/tribunal-leg-probe-cwd-${dirs++}`,
      sourceEnv: { PATH: "/bin", USERPROFILE: "C:/Users/u", GEMINI_API_KEY: "g-secret" }, executable: { file: "agy", prefix: [] },
      platform: "win32" });
  assert.equal(fake.calls.length, 3);
  const [control, guarded, injected] = fake.calls;
  assert.ok(control.args.includes("--dangerously-skip-permissions"));
  assert.ok(control.args.includes("--disable-slash-commands"), "control and guarded differ only by the deny list");
  const controlSettings = JSON.parse(control.args[control.args.indexOf("--settings") + 1]);
  assert.deepEqual(controlSettings, { useG1Credits: false }, "the control carries no deny list, and never spends AI credits");
  assert.deepEqual(guarded.args, argsForLeg(agyLeg));
  assert.deepEqual(JSON.parse(guarded.input), { event: "user", message: { content: "read the canary" } });
  assert.deepEqual(JSON.parse(injected.input), { event: "user", message: { content: "injected diff" } });
  for (const call of fake.calls) {
    assert.equal(call.opts.env.GEMINI_API_KEY, undefined);
    assert.equal(call.opts.env.USERPROFILE, call.opts.cwd, "the probe measures the seat in its own empty home");
  }
  assert.equal(new Set(fake.calls.map((c) => c.opts.cwd)).size, 3, "a fresh directory per invocation");
  assert.equal(r.guardedLeaked, false);
  assert.equal(argvShapeHash(agyLeg), argvShapeHash({ ...agyLeg, id: "gemini-3.8-flash-high" }));
});

test("a guarded probe run that agy refused (ERROR result, exit 0) is a measurement error, never a pass", async () => {
  const fake = fakeAgy((call, n) => (n === 1
    ? { lines: [result({ status: "SUCCESS", response: "CANARY-TOKEN-0123456789abcdef" })] }
    : { lines: [result({ status: "ERROR", error: "429 RESOURCE_EXHAUSTED" })], code: 0 }));
  let dirs = 0;
  const r = await probeAgy("read the canary", "injected diff", "CANARY-TOKEN-0123456789abcdef", agyLeg,
    { spawnFn: fake.spawnFn, mkTemp: async () => `C:/tmp/tribunal-leg-probe-cwd-${dirs++}`,
      sourceEnv: { PATH: "/bin" }, executable: { file: "agy", prefix: [] }, platform: "win32" });
  assert.equal(r.controlLeaked, true);
  assert.match(r.guardedError, /agy result ERROR: rate limited \(429 RESOURCE_EXHAUSTED\)/);
  assert.match(r.injectionError, /agy result ERROR/);
  assert.equal(legVerdict(r).verdict, "UNKNOWN");
});

test("a probe run cut off early (max_tokens) is a measurement error too", async () => {
  const fake = fakeAgy((call, n) => (n === 1
    ? { lines: [result({ status: "SUCCESS", response: "CANARY-TOKEN-0123456789abcdef" })] }
    : { lines: [result({ status: "SUCCESS", response: "partial", finished_reason: "max_tokens" })] }));
  let dirs = 0;
  const r = await probeAgy("read the canary", "injected diff", "CANARY-TOKEN-0123456789abcdef", agyLeg,
    { spawnFn: fake.spawnFn, mkTemp: async () => `C:/tmp/tribunal-leg-probe-cwd-${dirs++}`,
      sourceEnv: { PATH: "/bin" }, executable: { file: "agy", prefix: [] }, platform: "win32" });
  assert.match(r.guardedError, /stopped early \(max_tokens\)/);
  assert.equal(legVerdict(r).verdict, "UNKNOWN");
});

test("a CLI that closes stdin early cannot crash the panel", async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.write = () => { setImmediate(() => stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))); };
    stdin.end = () => {};
    child.stdin = stdin; child.kill = () => {};
    setImmediate(() => { child.stdout.emit("data", `${result({ status: "ERROR", error: "invalid model selection" })}
`); child.emit("close", 1); });
    return child;
  };
  const r = await runLeg({ ...agyLeg, fallback: undefined }, "review", { spawnFn, mkTemp: async () => "C:/tmp/tribunal-leg-agy",
    sourceEnv: { PATH: "/bin" }, platform: "win32" });
  assert.equal(r.kind, "failed");
});

test("doctor reports the agy binary and never claims a sign-in it cannot see", () => {
  const policy = { registry: [agyLeg], repoRoot: "C:/repo", modelsFile: "m", ledgerHome: "C:/l", probeRecord: "C:/l/p.md" };
  const doctor = (found) => runDoctor({ policy, sourceEnv: { PATH: "/bin" }, openFileFn: () => 0,
    resolveExeFn: (cmd) => (cmd === "agy" && found ? { found: true, file: "C:/agy.exe", prefix: [] } : { found: false, searchedDirs: [] }) })
    .lines.join("\n");
  assert.match(doctor(true), /gemini \[enabled\]: runnable; binary: C:\/agy\.exe; login: not detectable without a model call/);
  assert.match(doctor(true), /billing: plan \(Google AI Pro; no key reaches this process and AI-credit overflow is switched off for each run\)/);
  assert.match(doctor(false), /gemini \[enabled\]: not runnable; binary: agy missing/);
  assert.match(doctor(true), /web search: cannot be denied/);
});
