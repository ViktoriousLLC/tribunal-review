// Each leg needs its own environment and every failure must name the lost reviewer.
//
// The two that matter: a leg's environment must contain exactly what models.default.json grants it and
// nothing else, and every failure path must produce a NAMED lost leg rather than silence.
// panelLogic refuses to call a partial panel quiet, but only if the runner tells it the truth.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { envForLeg, argsForLeg, parseFindings, planLimitMessage, MAX_REFUSAL_CHARS, runLeg, FINDING_CONTRACT, isOurTempDir, TEMP_PREFIX, geminiUsage, geminiCostUSD, classifyLegOutcome } from "./legRunner.mjs";
import { loadRegistry } from "./registry.mjs";
import { panelRound, panelStatus, postLocalProof, repeatedReplyWarnings } from "./run.mjs";

// The vendor refusal sentence is 149 bytes; include the trailing LF to exercise
// the 150-byte stdout shape with a nonzero exit and unrelated stderr noise.
const capturedLimit = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.\n";
const trace = "Error: review crashed\n    at review (runner.js:12:3)";

test("classifier: a 150-byte plan-limit reply did not run", () => {
  assert.equal(Buffer.byteLength(capturedLimit), 150);
  const result = classifyLegOutcome({ code: 1, stdout: capturedLimit, stderr: "SessionEnd hook: unrelated noise" });
  assert.equal(result.kind, "not-run");
  assert.match(result.reason, /allowance for .* is spent/);
  // The reason must distinguish a usage cap from credential setup: `claude setup-token`
  // establishes a token but cannot reset a plan allowance.
  assert.match(result.reason, /allowance for .* is spent/);
  assert.match(result.reason, /Wait for the allowance to reset/);
  assert.doesNotMatch(result.reason, /setup-token/, "a cap is not a credential problem");
  assert.match(result.reason, /will not fix it/, "re-running is explicitly ruled out");
});

test("classifier: an absent credential names the variable", () => {
  assert.deepEqual(classifyLegOutcome({ missingCredentials: ["TEST_PLAN_TOKEN"] }), {
    kind: "not-run", reason: "TEST_PLAN_TOKEN is absent on this machine",
  });
});

test("classifier: Node's spawn error identifies an unreachable leg", () => {
  const result = classifyLegOutcome({ spawnError: { code: "ENOENT" }, model: "test-model" });
  assert.equal(result.kind, "not-run");
  assert.match(result.reason, /test-model could not be reached.*ENOENT/);
});

test("classifier: unmeasured vendor 5xx output remains a blocking unknown", () => {
  assert.deepEqual(classifyLegOutcome({ code: 1, stdout: "HTTP/1.1 503 Service Unavailable" }), {
    kind: "failed", reason: "unrecognised",
  });
});

test("classifier: our timer names the duration with no reply", () => {
  assert.deepEqual(classifyLegOutcome({ timedOut: true, timeoutMs: 12000, model: "test-model" }), {
    kind: "not-run", reason: "test-model: no reply in 12s",
  });
});

test("classifier: a nonzero exit with a trace crashed, on either stream", () => {
  for (const signals of [{ stdout: trace }, { stderr: trace }]) {
    assert.deepEqual(classifyLegOutcome({ code: 1, ...signals }), { kind: "failed", reason: "crashed" });
  }
});

test("classifier: a limit sentence plus other output crashed", () => {
  assert.deepEqual(classifyLegOutcome({ code: 1, stdout: `${capturedLimit}\nAnalysis started` }), {
    kind: "failed", reason: "crashed",
  });
});

test("classifier: an exit-zero unparseable reply still blocks", () => {
  assert.deepEqual(classifyLegOutcome({ code: 0, stdout: "The code seems fine." }), {
    kind: "failed", reason: "reply could not be parsed",
  });
});

test("classifier: an exit-zero empty reply still blocks", () => {
  assert.deepEqual(classifyLegOutcome({ code: 0, stdout: " \n" }), { kind: "failed", reason: "empty reply" });
});

test("classifier: valid findings quoting the limit sentence are answered", () => {
  const stdout = JSON.stringify({ findings: [{ title: capturedLimit }] });
  assert.equal(classifyLegOutcome({ code: 0, stdout }).kind, "answered");
});

test("classifier: a shape in no row is unrecognised and blocks", () => {
  for (const signals of [
    {}, { code: 17, stdout: "new vendor shape" }, { code: 1, stdout: '{"findings":[]}' },
    { code: 1 }, { code: 1, stdout: "ECONNRESET: connection failed" },
  ]) {
    assert.deepEqual(classifyLegOutcome(signals), { kind: "failed", reason: "unrecognised" });
  }
});

test("classifier: a limit sentence inside a stack trace cannot become not-run", () => {
  assert.deepEqual(classifyLegOutcome({ code: 1, stdout: `Error: ${capturedLimit}\n    at review (runner.js:12:3)` }), {
    kind: "failed", reason: "crashed",
  });
});

test("classifier: every ambiguous blocking row wins over not-run flags", () => {
  for (const flags of [{ timedOut: true }, { spawnError: { code: "ENOENT" } }, { missingCredentials: ["TEST_TOKEN"] }]) {
    for (const signals of [{ code: 1, stdout: trace }, { code: 0, stdout: "prose" }, { code: 0, stdout: "" }]) {
      assert.equal(classifyLegOutcome({ ...flags, ...signals }).kind, "failed");
    }
  }
  assert.equal(classifyLegOutcome({ code: 1, stdout: capturedLimit, stderr: trace }).reason, "crashed");
  assert.equal(classifyLegOutcome({ code: 1, stdout: `HTTP/1.1 503 Service Unavailable\n${trace}` }).reason, "crashed");
});

test("classifier: timer and spawn errors after reply text cannot discard work", () => {
  for (const flags of [{ timedOut: true }, { spawnError: { code: "EIO" } }]) {
    for (const stdout of ['{"findings":[', '{"findings":[]}', "analysis began"]) {
      assert.deepEqual(classifyLegOutcome({ ...flags, stdout }), { kind: "failed", reason: "unrecognised" });
    }
  }
});

test("classifier: a fabricated middle between the real opener and closer is NOT a plan limit", () => {
  // Anchoring only the first and last clause would allow arbitrary crash text between
  // them. Every clause of the vendor refusal shape must match.
  assert.equal(classifyLegOutcome({ code: 1, stdout: "You've reached your Zzz limit. everything exploded, to continue." }).kind, "failed");
  assert.equal(classifyLegOutcome({ code: 1, stdout: capturedLimit + " TypeError: boom" }).kind, "failed");
});

test("classifier: ANY model's limit sentence is a plan limit", () => {
  // Model names vary within the vendor refusal shape. Recognizing the shape prevents
  // another model's cap from falling through to an unrecognised failure.
  assert.equal(classifyLegOutcome({ code: 1, stdout: capturedLimit.replace("Fable", "Opus") }).kind, "not-run");

  // What must still NOT qualify, which is the whole reason the length bound exists.
  const longReview = `The new matcher fires on any reply saying "${capturedLimit}". ${"x".repeat(900)}`;
  assert.equal(classifyLegOutcome({ code: 1, stdout: longReview }).kind, "failed",
    "the sentence inside a long reply is a leg discussing it, not a leg refused by it");
  assert.equal(classifyLegOutcome({ code: 0, stdout: capturedLimit }).kind, "failed",
    "a clean exit means the leg ran; a zero-exit reply is never a plan limit");
});

test("classifier: no not-run reason is empty or a bare not run", () => {
  const cases = [
    [{ code: 1, stdout: capturedLimit }, /allowance for .* is spent/],
    [{ missingCredentials: ["TEST_TOKEN"] }, /TEST_TOKEN/],
    [{ spawnError: { code: "ENOENT" } }, /could not be reached.*ENOENT/],
    [{ timedOut: true, timeoutMs: 5000 }, /no reply in 5s/],
  ];
  for (const [signals, cause] of cases) {
    const result = classifyLegOutcome(signals);
    assert.equal(result.kind, "not-run");
    assert.ok(result.reason.trim());
    assert.doesNotMatch(result.reason, /^not[ -]run[.!]?$/i);
    assert.match(result.reason, cause);
  }
});

function fakeChild({ stdout = "", stderr = "", code = 0, error, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => child.emit("close", null);
  setImmediate(() => {
    child.stdout.emit("data", stdout);
    child.stderr.emit("data", stderr);
    if (error) { child.emit("error", error); child.emit("close", null); }
    else if (!hang) child.emit("close", code);
  });
  return child;
}

// Use a short timeout only for cases that exercise expiry. Other cases need a generous
// wait ceiling so scheduling delays cannot replace their expected classifier outcome
// with a timeout. The timeout threshold and completion wait serve different purposes.
const HANG_TIMEOUT_MS = 20;
const SETTLE_TIMEOUT_MS = 5000;

test("runLeg routes close, emitted error and timeout through the classifier", async () => {
  const cases = [
    [{ code: 1, stdout: capturedLimit }, "not-run", /allowance for .* is spent/],
    [{ error: { code: "ENOENT", message: "missing executable" } }, "not-run", /could not be reached/],
    [{ hang: true }, "not-run", /no reply in 0\.02s/],
    [{ code: 1, stdout: trace }, "failed", /crashed/],
    [{ code: 0, stdout: "prose" }, "failed", /reply could not be parsed/],
    [{ code: 0, stdout: "" }, "failed", /empty reply/],
    [{ hang: true, stdout: '{"findings":[' }, "failed", /unrecognised/],
    [{ error: { code: "EIO" }, stdout: "analysis began" }, "failed", /unrecognised/],
  ];
  for (const [signals, kind, cause] of cases) {
    const result = await runLeg(claudeLeg, "review", {
      spawnFn: () => fakeChild(signals), mkTemp: async () => ".",
      timeoutMs: signals.hang ? HANG_TIMEOUT_MS : SETTLE_TIMEOUT_MS,
    });
    assert.equal(result.kind, kind);
    assert.match(result.error, cause);
    assert.equal(result.model, claudeLeg.id);
  }
});

const readLegs = ["opus", "sol", "astra"].map((leg) => ({ leg, kind: "answered", answered: true, parseFailed: false }));
function proofFor(results) {
  const calls = [];
  postLocalProof({ prNumber: 7, headSha: "a".repeat(40) }, 1, 100, results, undefined,
    (_cmd, _args, opts) => { calls.push(opts.input); return { status: 0 }; });
  if (!calls.length) return null;
  const marker = /eval-data:v1:\s*([A-Za-z0-9+/=]+)\s*:end/.exec(calls[0]);
  return JSON.parse(Buffer.from(marker[1], "base64").toString("utf8"));
}

// Every enabled leg must provide parseable findings, so capped legs remain PARTIAL.
test("a capped leg blocks proof and the quiet decision", async () => {
  const capped = await runLeg({ ...claudeLeg, leg: "fable" }, "review", {
    spawnFn: () => fakeChild({ code: 1, stdout: capturedLimit }), mkTemp: async () => ".",
  });
  const results = [...readLegs, capped];
  const proof = proofFor(results);
  assert.equal(proof, null, "an enabled leg that did not answer cannot certify a full round");
  assert.equal(panelRound(results, [], { round: 1 }).decision.reason, "PARTIAL");
  assert.match(panelStatus(results), /3 leg\(s\) remain, 3 read/);
  assert.match(panelStatus(results), /fable not run: plan allowance for Fable is spent/);
});

test("not-run causes never waive the three-leg proof floor", () => {
  const absent = { leg: "fable", kind: "not-run", answered: false, reason: "TEST_TOKEN is absent" };
  assert.equal(proofFor([...readLegs.slice(0, 2), absent]), null);
  assert.equal(proofFor([absent]), null);
  assert.notEqual(panelRound([absent], [], { round: 1 }).decision.reason, "QUIET");
});

test("every failed leg blocks proof and a quiet decision, including readable-looking legacy fields", () => {
  for (const signals of [
    { code: 1, stdout: trace }, { code: 0, stdout: "prose" }, { code: 0, stdout: "" },
    { code: 7, stdout: "new shape" }, { code: 1, stdout: "HTTP/1.1 503 Service Unavailable" },
  ]) {
    const outcome = classifyLegOutcome(signals);
    const results = [...readLegs, { leg: "failed-leg", answered: true, parseFailed: false, ...outcome }];
    assert.equal(proofFor(results), null);
    assert.equal(panelRound(results, [], { round: 1 }).decision.reason, "PARTIAL");
  }
});

test("the panel reports remaining count even when no leg drops", () => {
  assert.match(panelStatus(readLegs), /3 leg\(s\) remain, 3 read/);
});

test("runtime warning needs consecutive short unknown replies from the same leg and model", () => {
  const current = { leg: "fable", model: "test-model", shortUnrecognised: true };
  const warnings = (previous) => repeatedReplyWarnings([current], () => ["2026-09.ndjson"],
    () => previous.map((legs) => JSON.stringify({ legs })).join("\n"), ".");
  assert.deepEqual(warnings([]), []);
  assert.deepEqual(warnings([[{ ...current, leg: "opus" }]]), []);
  assert.deepEqual(warnings([[{ ...current, model: "other-model" }]]), []);
  assert.deepEqual(warnings([[current], [{ ...current, shortUnrecognised: false }]]), []);
  assert.match(warnings([[current]])[0], /fable.*quota.*FABLE_PLAN_LIMIT_REPLY.*still blocks/);
});

const claudeLeg = { leg: "opus", id: "claude-opus-5", runner: "claude-cli", envKeys: ["CLAUDE_CODE_OAUTH_TOKEN"] };
const codexLeg = { leg: "sol", id: "gpt-5.6-sol", runner: "codex-cli", envKeys: ["CODEX_HOME"] };
const geminiLeg = { leg: "gemini", id: "gemini-3.7-flash", runner: "genai-sdk", envKeys: ["GEMINI_API_KEY"] };

const SOURCE = {
  PATH: "/bin", HOME: "/home/user", USERPROFILE: "C:/Users/user",
  CLAUDE_CODE_OAUTH_TOKEN: "tok", GEMINI_API_KEY: "gkey", OPENAI_API_KEY: "okey",
  SOME_OTHER_SECRET: "nope",
};

test("a leg's environment contains its own keys and no others", () => {
  const { env, missing } = envForLeg(claudeLeg, SOURCE);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "tok");
  assert.deepEqual(missing, []);
  assert.equal(env.SOME_OTHER_SECRET, undefined, "an unrelated secret must not ride along");
});

test("NO agent leg ever receives a spend-capable key, even though the process holds one", () => {
  // Agent subprocesses must not inherit spend-capable keys from the parent environment.
  for (const leg of [claudeLeg, codexLeg]) {
    const { env } = envForLeg(leg, SOURCE);
    assert.equal(env.GEMINI_API_KEY, undefined, `${leg.leg} must not see GEMINI_API_KEY`);
    assert.equal(env.OPENAI_API_KEY, undefined, `${leg.leg} must not see OPENAI_API_KEY`);
  }
});

test("the gemini leg is the only one that gets the key", () => {
  assert.equal(envForLeg(geminiLeg, SOURCE).env.GEMINI_API_KEY, "gkey");
});

test("CODEX_HOME is derived rather than demanded, so it is never reported missing", () => {
  const { env, missing } = envForLeg(codexLeg, { PATH: "/bin", USERPROFILE: "C:/Users/user" });
  assert.match(env.CODEX_HOME, /\.codex$/);
  assert.deepEqual(missing, []);
});

test("envKeys is an ALLOWLIST, so an absent one is not a missing credential", () => {
  // A CLI can authenticate from its own credential store. Treating every allowlisted
  // environment variable as required would incorrectly reject that working configuration.
  const { env, missing } = envForLeg(claudeLeg, { PATH: "/bin" });
  assert.deepEqual(missing, [], "an absent allowlisted variable is not a missing credential");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("requiredEnv is what makes a leg genuinely unrunnable, and it is reported", () => {
  const { missing } = envForLeg({ ...geminiLeg, requiredEnv: ["GEMINI_API_KEY"] }, { PATH: "/bin" });
  assert.deepEqual(missing, ["GEMINI_API_KEY"]);
});

test("the shipped registry marks NO agent leg's credential as required", () => {
  // A required variable the local CLI does not use turns a working leg into a lost one, and a
  // lost leg makes every round PARTIAL, which blocks the loop forever.
  for (const leg of loadRegistry().filter((l) => l.runner !== "genai-sdk")) {
    assert.deepEqual(leg.requiredEnv ?? [], [], `${leg.leg} must not require an env var the CLI may not use`);
  }
});

test("a leg with a missing credential is a named not-run, never a silent skip", async () => {
  const r = await runLeg({ ...claudeLeg, requiredEnv: ["NOT_SET_ANYWHERE_XYZ"] }, "review this");
  assert.equal(r.answered, false);
  assert.match(r.error, /NOT_SET_ANYWHERE_XYZ is absent/);
  assert.equal(r.kind, "not-run");
  assert.equal(r.leg, "opus");
});

test("the Claude argv refuses every tool and reads a COLD artifact", () => {
  const a = argsForLeg(claudeLeg);
  const denied = a[a.indexOf("--disallowedTools") + 1];
  for (const t of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "Task"]) {
    assert.ok(denied.includes(t), `${t} must be refused`);
  }
  // --setting-sources "" is what stops the leg inheriting the user's own always-on context.
  assert.equal(a[a.indexOf("--setting-sources") + 1], "");
  assert.ok(a.includes("--strict-mcp-config"));
});

test("the Codex argv disables the shell and reads its prompt from stdin", () => {
  const a = argsForLeg(codexLeg);
  assert.ok(a.includes("read-only"));
  assert.ok(a.includes("--ephemeral"));
  assert.ok(a.includes("--ignore-user-config"));
  const disabled = a.filter((x, i) => a[i - 1] === "--disable");
  assert.ok(disabled.includes("shell_tool"), "the one that matters");
  assert.equal(a.at(-1), "-", "the artifact goes on stdin, never onto a command line");
});

test("neither agent leg's refusal list is a subset of the other's blind spot", () => {
  // Checking only one runner leaves the other's restrictions unverified. Both must
  // constrain shell, filesystem and sub-agent capabilities.
  const claude = argsForLeg(claudeLeg).join(" ");
  const codex = argsForLeg(codexLeg).join(" ");
  assert.ok(/Bash/.test(claude) && /shell_tool/.test(codex), "shell closed on both");
  assert.ok(/Read/.test(claude) && /read-only/.test(codex), "filesystem bounded on both");
  assert.ok(/Task/.test(claude) && /multi_agent/.test(codex), "sub-agents closed on both");
});

test("argsForLeg refuses a runner it has no argv for, rather than inventing one", () => {
  assert.throws(() => argsForLeg({ runner: "genai-sdk" }), /no argv for runner/);
});

test("every runner named in the shipped registry either has an argv or is the SDK leg", () => {
  for (const leg of loadRegistry()) {
    if (leg.runner === "genai-sdk") continue;
    assert.doesNotThrow(() => argsForLeg(leg), `${leg.leg} has no argv`);
  }
});

test("findings parse from bare JSON, from a fenced block, and from JSON with prose around it", () => {
  const body = '{"findings":[{"title":"x","severity":"BLOCKER","category":"correctness"}]}';
  assert.equal(parseFindings(body).findings.length, 1);
  assert.equal(parseFindings("```json\n" + body + "\n```").findings.length, 1);
  assert.equal(parseFindings("Here you go:\n" + body + "\nHope that helps.").findings.length, 1);
});

test("an empty findings array parses cleanly — a clean review is a real answer", () => {
  const r = parseFindings('{"findings":[]}');
  assert.deepEqual(r.findings, []);
  assert.equal(r.parseError, null);
});

test("an unparseable reply is an ANSWERED leg with an error, not a dead one", async () => {
  // A talking leg treated as a dead leg would stop the loop for the wrong reason.
  const fake = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdin = { write() {}, end() {} };
    setImmediate(() => { c.stdout.emit("data", "I think the code is fine, honestly."); c.emit("close", 0); });
    return c;
  };
  const r = await runLeg(codexLeg, "review", { spawnFn: fake, mkTemp: async () => "." });
  assert.equal(r.answered, true, "it answered; we just could not read it");
  assert.match(r.error, /reply could not be parsed/);
  assert.equal(r.kind, "failed");
  assert.equal(r.parseFailed, true);
});

test("a nonzero empty reply with unmeasured stderr prose remains a named blocking failure", async () => {
  const fake = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdin = { write() {}, end() {} };
    setImmediate(() => { c.stderr.emit("data", "credential expired"); c.emit("close", 1); });
    return c;
  };
  const r = await runLeg(codexLeg, "review", { spawnFn: fake, mkTemp: async () => "." });
  assert.equal(r.answered, false);
  assert.match(r.error, /unrecognised/);
  assert.equal(r.kind, "failed");
});

test("a spawn that throws synchronously is caught — a crash produces no measurement at all", async () => {
  const fake = () => { const e = new Error("nope"); e.code = "EINVAL"; throw e; };
  const r = await runLeg(codexLeg, "review", { spawnFn: fake, mkTemp: async () => "." });
  assert.equal(r.answered, false);
  assert.match(r.error, /could not be reached.*EINVAL/);
  assert.equal(r.kind, "not-run");
});

test("the contract tells the leg a finding is a hypothesis and must name its check", () => {
  assert.match(FINDING_CONTRACT, /hypothesis/);
  assert.match(FINDING_CONTRACT, /how to check it|how to verify/);
  assert.match(FINDING_CONTRACT, /Do not praise/);
});

test("the empty --setting-sources argument SURVIVES the spawn, measured not assumed", async (t) => {
  // Losing the empty argument would let the CLI inherit the operator's context and
  // compromise the cold read. Exercise a real child process with shell:false to verify
  // that the empty value and following flag both survive argument transport.
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "tribunal-argv-echo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const echo = join(dir, "echo.cjs");
  writeFileSync(echo, `console.log(JSON.stringify(process.argv.slice(2)));${"\n"}`, "utf8");
  const args = argsForLeg(claudeLeg);
  const r = spawnSync(process.execPath, [echo, ...args], { encoding: "utf8", shell: false });
  const got = JSON.parse(r.stdout.trim());
  const i = got.indexOf("--setting-sources");
  assert.notEqual(i, -1, "the flag itself must reach the child");
  assert.equal(got[i + 1], "", "and its EMPTY value must reach it too, or the leg is not cold");
  assert.equal(got[i + 2], "--strict-mcp-config", "and the next flag must not be swallowed");
});

test("THE CLEANUP NEVER DELETES A DIRECTORY IT DID NOT CREATE", async () => {
  // mkTemp can be injected with "." or another real directory. Unconditional recursive
  // cleanup would then target repository data. Require both the OS temp parent and the
  // runner prefix; platform refusal to delete a working directory is not a safeguard.
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.equal(isOurTempDir("."), false, "the cwd is never ours to delete");
  assert.equal(isOurTempDir(process.cwd()), false);
  assert.equal(isOurTempDir(tmpdir()), false, "the temp root itself is not ours");
  assert.equal(isOurTempDir(join(tmpdir(), "someone-elses-dir")), false, "our prefix is required");
  assert.equal(isOurTempDir(join(tmpdir(), `${TEMP_PREFIX}abc123`)), true, "and this one IS ours");
  assert.equal(isOurTempDir(null), false);
  assert.equal(isOurTempDir(""), false);
});

test("a leg run against an injected cwd leaves that directory ALIVE", async () => {
  // The end-to-end proof, not just the predicate: run a leg with mkTemp pointing at a real
  // directory we control and assert it still exists afterwards.
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const survivor = mkdtempSync(join(tmpdir(), "must-survive-"));
  const fake = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdin = { write() {}, end() {} };
    setImmediate(() => { c.stdout.emit("data", '{"findings":[]}'); c.emit("close", 0); });
    return c;
  };
  try {
    await runLeg(codexLeg, "review", { spawnFn: fake, mkTemp: async () => survivor });
    assert.equal(existsSync(survivor), true, "a directory the runner did not create must survive");
  } finally {
    rmSync(survivor, { recursive: true, force: true });
  }
});

test("REGRESSION: every leg invocation gets its OWN directory", async (t) => {
  // Two claude -p runs sharing a working directory are not independent: the second continues the
  // first one's conversation, silently, with every leg still answering.
  const { existsSync } = await import("node:fs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const seen = [];
  const created = new Set();
  t.after(async () => {
    for (const dir of created) {
      assert.equal(isOurTempDir(dir), true, "delete only this fixture's runner-prefixed temp directories");
      // Fixture cleanup can race the runner's own deletion. Windows may report EPERM
      // during that race, so an already absent or busy directory is not a fixture failure.
      try { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
      catch (error) { if (!["ENOENT", "EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error; }
    }
  });
  const fake = (_file, _args, { cwd }) => {
    assert.ok(created.has(cwd), "each spawned cwd was created by this fixture");
    assert.equal(existsSync(cwd), true);
    seen.push(cwd);
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdin = { write() {}, end() {} };
    setImmediate(() => { c.stdout.emit("data", '{"findings":[]}'); c.emit("close", 0); });
    return c;
  };
  // Mutation: reuse fixed /tmp paths; these checks fail before cleanup can run.
  const mkTemp = async () => {
    const d = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
    created.add(d);
    assert.equal(isOurTempDir(d), true, "only runner-prefixed paths under OS temp may reach cleanup");
    assert.equal(existsSync(d), true, "the fixture must create the directory before using it");
    return d;
  };
  await runLeg(codexLeg, "a", { spawnFn: fake, mkTemp });
  await runLeg(codexLeg, "b", { spawnFn: fake, mkTemp });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], "two invocations must never share a working directory");
});

test("geminiUsage: thinking tokens bill as output, and silence is null, never 0", () => {
  // total - prompt covers thoughtsTokenCount, which candidatesTokenCount omits.
  assert.deepEqual(
    geminiUsage({ promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 300, totalTokenCount: 1500 }),
    { tokensIn: 1000, tokensOut: 500 },
  );
  assert.deepEqual(
    geminiUsage({ promptTokenCount: 1000, candidatesTokenCount: 200 }),
    { tokensIn: 1000, tokensOut: 200 },
    "candidates is the fallback when no total is reported",
  );
  assert.deepEqual(
    geminiUsage({ promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 300 }),
    { tokensIn: 1000, tokensOut: 500 },
    "the fallback path must not drop billed thinking tokens either",
  );
  assert.deepEqual(
    geminiUsage({ promptTokenCount: 1000, totalTokenCount: 400 }),
    { tokensIn: 1000, tokensOut: null },
    "total below prompt is an inconsistent report, not a negative charge",
  );
  assert.deepEqual(
    geminiUsage({ promptTokenCount: -5, candidatesTokenCount: 200 }),
    { tokensIn: null, tokensOut: 200 },
    "a negative count on the input side is not a measurement either",
  );
  assert.equal(geminiUsage(undefined), null);
  assert.equal(geminiUsage({}), null, "an empty usage report is not zero usage");
});

test("geminiCostUSD prices the model that ANSWERED, and refuses to guess", () => {
  const prices = { "gemini-3.7-flash": { in: 0.75, out: 3.75 }, "gemini-3.5-flash": { in: 1.5, out: 9.0 } };
  // Independent literal: 200k in at $0.75/1M is $0.15, 40k out at $3.75/1M is $0.15.
  assert.equal(geminiCostUSD("gemini-3.7-flash", { tokensIn: 200000, tokensOut: 40000 }, prices), 0.3);
  // The fallback rung costs more, so pricing it at the primary's rate would under-report.
  assert.equal(geminiCostUSD("gemini-3.5-flash", { tokensIn: 1000000, tokensOut: 1000000 }, prices), 10.5);
  assert.equal(geminiCostUSD("gemini-99-unknown", { tokensIn: 1, tokensOut: 1 }, prices), null, "unpriced model is null, not $0");
  assert.equal(geminiCostUSD("gemini-3.7-flash", null, prices), null, "no usage is null, not $0");
  assert.equal(geminiCostUSD("gemini-3.7-flash", { tokensIn: 1, tokensOut: null }, prices), null, "half a measurement is not a measurement");
  assert.equal(geminiCostUSD("constructor", { tokensIn: 1, tokensOut: 1 }, prices), null, "a prototype key is not a price");
});

test("an expired price pin refuses to price rather than silently billing at the promo rate", () => {
  const prices = { "gemini-3.7-flash": { in: 0.75, out: 3.75, until: "2026-12-31" } };
  const usage = { tokensIn: 1000000, tokensOut: 1000000 };
  assert.equal(geminiCostUSD("gemini-3.7-flash", usage, prices, new Date("2026-12-31T12:00:00Z")), 4.5, "still valid on the last day");
  assert.equal(geminiCostUSD("gemini-3.7-flash", usage, prices, new Date("2027-01-01T00:00:01Z")), null, "expired pin is no pin");
  const garbled = { "gemini-3.7-flash": { in: 0.75, out: 3.75, until: "not-a-date" } };
  assert.equal(geminiCostUSD("gemini-3.7-flash", usage, garbled, new Date("2026-09-07T00:00:00Z")), null, "an unreadable expiry refuses too");
});

test("findings survive a leg that fences something else FIRST", () => {
  // A quoted fenced snippet can precede the findings. Inspecting only the first fence
  // would miss the JSON; a fallback slice spanning braces in both blocks can fail too.
  const reply = [
    "Looking at this hunk:",
    "```ts",
    "const x = { a: 1 };",
    "```",
    "Here are my findings:",
    "```json",
    '{"findings":[{"title":"a real finding"}]}',
    "```",
  ].join(String.fromCharCode(10));
  const r = parseFindings(reply);
  assert.equal(r.parseError, null, "a leg that fenced a snippet first was treated as unparseable");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].title, "a real finding");
});

test("findings survive prose containing a brace before the JSON", () => {
  // The other half: a slice anchored on indexOf("{") starts inside the prose and
  // parses as nothing.
  // Built by join rather than written with an escape, so the fixture cannot be
  // broken by whatever writes this file next.
  const reply = ["I considered the { shape } of this and concluded:", '{"findings":[{"title":"x"}]}'].join(
    String.fromCharCode(10),
  );
  const r = parseFindings(reply);
  assert.equal(r.parseError, null);
  assert.equal(r.findings.length, 1);
});

test("a leg that genuinely answered in prose is still a parse FAILURE, not an empty pass", () => {
  // The counterweight. Widening the parser must not start reporting "no findings"
  // for a leg that never produced any, because panelLogic would then treat a
  // talking leg as a clean one even though its findings were unreadable.
  const r = parseFindings("I think the drain logic looks fine to me, no JSON here.");
  assert.match(r.parseError, /could not parse findings JSON/);
  assert.deepEqual(r.findings, []);
});

test("A SPENT PLAN ALLOWANCE IS NOT A PARSE FAILURE", () => {
  // A limit notice must not be reported as a formatting problem. The responses differ:
  // a formatting problem can require a parser fix, while a
  // spent allowance is a fact about the account that re-running cannot change.
  const real = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage to continue.";
  const msg = planLimitMessage(real);
  assert.ok(msg, "the limit message was not recognised");
  assert.match(msg, /Fable/, "it must name which allowance is spent");
  assert.match(msg, /re-running will not fix it/, "it must say retrying is pointless");
  assert.match(msg, /Do not buy the leg back/, "the message must not suggest purchasing a replacement review");
});

test("the limit matcher does not fire on ordinary review prose", () => {
  // The counterweight: a matcher that fires on a finding ABOUT rate limits would
  // silently drop a real review.
  for (const innocent of [
    "The drain reached your limit of 1000 rows",
    "rate limit handling looks correct",
    "We reached the ceiling and refused",
    "",
  ]) {
    assert.equal(planLimitMessage(innocent), null, `false positive on: ${innocent}`);
  }
});

test("A LONG REVIEW THAT QUOTES THE LIMIT SENTENCE IS NOT A REFUSAL", () => {
  // A review may quote a limit notice from the artifact. A phrase-only matcher would
  // discard that review; the length bound distinguishes it from a short refusal.
  const quotingReview = [
    "Reviewing the diff in scripts/legRunner.mjs.",
    "The new matcher looks for the sentence \"You've reached your Fable limit\" in the leg output.",
    "My concern is that it matches anywhere in the reply, so a review mentioning it trips the check.",
    "x".repeat(MAX_REFUSAL_CHARS),
    '{"findings":[{"title":"the matcher is unanchored"}]}',
  ].join(String.fromCharCode(10));
  assert.equal(planLimitMessage(quotingReview), null, "a review quoting the sentence was read as a refusal");

  // And the genuine short refusal still registers, or the fix has just disabled it.
  const realRefusal = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage to continue.";
  assert.ok(planLimitMessage(realRefusal), "the real refusal stopped being recognised");
  assert.ok(realRefusal.length < MAX_REFUSAL_CHARS, "the bound must leave room for the real message");
});

test("A SHORT REVIEW THAT QUOTES THE SENTENCE AND PRODUCES FINDINGS IS NOT A REFUSAL", () => {
  // A review quoting a limit notice can fit under the length bound. Parseable findings
  // still establish that a review occurred and must prevent classification as a refusal.
  const shortReviewQuotingIt = [
    "The matcher fires on any reply saying \"reached your Fable limit\".",
    '{"findings":[{"title":"the limit matcher is too eager"}]}',
  ].join(String.fromCharCode(10));
  assert.ok(shortReviewQuotingIt.length < MAX_REFUSAL_CHARS, "the fixture must be inside the length bound");
  assert.equal(planLimitMessage(shortReviewQuotingIt), null, "a short review with findings was read as a refusal");

  // The genuine refusal still registers, or the fix has disabled the check.
  const realRefusal = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage to continue.";
  assert.ok(planLimitMessage(realRefusal), "the real refusal stopped being recognised");
});
