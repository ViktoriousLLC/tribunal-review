// The Grok Build seat and the advisory/trial-seat fields it shipped with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argsForLeg, envForLeg, runLeg, unwrapGrokOutput, GROK_DISALLOWED_TOOLS, GROK_FIXED_ENV } from "./legRunner.mjs";
import { validateLegs, seatExpired } from "./registry.mjs";
import { resolvePolicy } from "./policy.mjs";
import { resolveExe } from "./executable.mjs";
import { splitAdvisory, renderAdvisory, panelRound } from "./run.mjs";
import { cliCommand } from "./isolationBinding.mjs";

const grokLeg = { leg: "grok", id: "grok-4.7", vendor: "xai", runner: "grok-cli", billing: "plan",
  envKeys: ["GROK_HOME"], enabled: true, advisory: true, until: "2026-11-06" };

test("a grok-cli row is valid, and an agent runner may never hold XAI_API_KEY", () => {
  assert.deepEqual(validateLegs([grokLeg]), []);
  const problems = validateLegs([{ ...grokLeg, envKeys: ["GROK_HOME", "XAI_API_KEY"] }]);
  assert.ok(problems.some((p) => /agent runner and would receive XAI_API_KEY/.test(p)), problems.join("\n"));
});

test("advisory must be boolean and until must be a real YYYY-MM-DD", () => {
  assert.ok(validateLegs([{ ...grokLeg, advisory: "yes" }]).some((p) => /non-boolean advisory/.test(p)));
  for (const until of ["11/06/2026", "2026-13-40", "2026-02-31", "2026-04-31", 20261106, ""]) {
    assert.ok(validateLegs([{ ...grokLeg, until }]).some((p) => /expected a real YYYY-MM-DD date/.test(p)), String(until));
  }
});

test("a grok seat may hold exactly GROK_HOME and nothing else", () => {
  for (const envKeys of [[], ["GROK_HOME", "GROK_API_KEY"], ["XAI_TOKEN"]]) {
    assert.ok(validateLegs([{ ...grokLeg, envKeys }]).some((p) => p.includes('envKeys must be exactly ["GROK_HOME"]')), JSON.stringify(envKeys));
  }
});

test("the probe's Grok shape hash covers the environment, and excludes the model id", async () => {
  const { createHash } = await import("node:crypto");
  const { argvShapeHash } = await import("./isolationBinding.mjs");
  const argvOnly = createHash("sha256").update(JSON.stringify(argsForLeg({ ...grokLeg, id: "" }))).digest("hex");
  assert.notEqual(argvShapeHash(grokLeg), argvOnly, "env switches and redirected homes are part of the certified shape");
  assert.equal(argvShapeHash(grokLeg), argvShapeHash({ ...grokLeg, id: "grok-4.6" }));
});

test("a seat runs through its until day (UTC) and is expired after it", () => {
  assert.equal(seatExpired(grokLeg, new Date("2026-11-06T23:59:00Z")), false);
  assert.equal(seatExpired(grokLeg, new Date("2026-11-07T00:00:01Z")), true);
  assert.equal(seatExpired({ ...grokLeg, until: undefined }, new Date("2099-01-01")), false);
});

function repoWith(legs, config = {}) {
  const root = mkdtempSync(join(tmpdir(), "tribunal-grok-policy-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "models.json"), JSON.stringify({ legs }));
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify({ modelsFile: "models.json", ...config }));
  return root;
}

test("policy turns an expired trial seat off, even when enabledLegs names it", () => {
  const root = repoWith([grokLeg], { enabledLegs: ["grok"] });
  const before = resolvePolicy(root, { now: new Date("2026-11-01T12:00:00Z") }).registry[0];
  assert.equal(before.enabled, true);
  const after = resolvePolicy(root, { now: new Date("2026-11-08T12:00:00Z") }).registry[0];
  assert.equal(after.enabled, false);
  assert.equal(after.expired, true);
  assert.match(after.disabledReason, /Trial seat ended on 2026-11-06/);
});

test("grok argv removes every built-in tool, runs one turn, and never auto-approves", () => {
  const args = argsForLeg(grokLeg);
  const at = args.indexOf("--disallowed-tools");
  assert.ok(at >= 0);
  const removed = args[at + 1].split(",");
  for (const tool of ["run_terminal_cmd", "run_terminal_command", "read_file", "write", "search_replace", "list_dir", "grep", "web_fetch", "web_search"]) {
    assert.ok(removed.includes(tool), `${tool} is not removed`);
  }
  assert.deepEqual(removed, GROK_DISALLOWED_TOOLS);
  for (const flag of ["--disable-web-search", "--no-subagents", "--no-memory", "--no-plan", "--system-prompt-override"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--max-turns") + 1], "1");
  assert.deepEqual(args.slice(0, 2), ["-p", "-"]); // prompt on stdin, never on the command line
  for (const unsafe of ["--always-approve", "--yolo", "--dangerously-skip-permissions", "--tools"]) assert.ok(!args.includes(unsafe), unsafe);
});

test("grok env: the panel's own sign-in, the leg's own homes, fixed switches, and no xAI key", () => {
  const source = { PATH: "/bin", USERPROFILE: "C:/Users/u", HOME: "C:/Users/u", APPDATA: "C:/Users/u/AppData/Roaming",
    XAI_API_KEY: "xai-secret", GROK_HOME: "C:/Users/u/.grok" };
  const { env } = envForLeg(grokLeg, source, { home: "C:/tmp/tribunal-leg-1" });
  assert.equal(env.GROK_HOME, join("C:/Users/u", ".tribunal", "grok-home"), "never the user's own ~/.grok");
  for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) assert.equal(env[k], "C:/tmp/tribunal-leg-1", k);
  assert.equal(env.XAI_API_KEY, undefined);
  for (const [k, v] of Object.entries(GROK_FIXED_ENV)) assert.equal(env[k], v, k);
  assert.equal(env.GROK_DISABLE_API_KEY_AUTH, "1");
  assert.equal(envForLeg(grokLeg, { ...source, TRIBUNAL_GROK_HOME: "D:/panel" }).env.GROK_HOME, "D:/panel");
});

test("unwrapGrokOutput reads the reply text and token counts, and passes anything else through", () => {
  const wrapped = JSON.stringify({ text: '{"findings":[]}', usage: { input_tokens: 3835, output_tokens: 810, cache_read_input_tokens: 1152 } });
  assert.deepEqual(unwrapGrokOutput(wrapped), { stdout: '{"findings":[]}', usage: { tokensIn: 3835, tokensOut: 810, tokensCached: 1152 } });
  assert.deepEqual(unwrapGrokOutput("Error: not signed in"), { stdout: "Error: not signed in", usage: null });
  assert.deepEqual(unwrapGrokOutput('{"findings":[]}'), { stdout: '{"findings":[]}', usage: null });
  assert.equal(unwrapGrokOutput(JSON.stringify({ text: "x", usage: { input_tokens: -1 } })).usage.tokensIn, null);
});

test("runLeg runs grok with the message on stdin and its homes in the fresh directory", async () => {
  let seen;
  const fake = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let input = "";
    child.stdin = { write(d) { input += d; }, end() {} };
    child.kill = () => {};
    seen = { file, args, opts, get input() { return input; } };
    setImmediate(() => {
      child.stdout.emit("data", JSON.stringify({ text: '{"findings":[{"title":"t","severity":"NIT"}]}', usage: { input_tokens: 10, output_tokens: 2 } }));
      child.emit("close", 0);
    });
    return child;
  };
  const r = await runLeg(grokLeg, "review this", { spawnFn: fake, mkTemp: async () => "C:/tmp/tribunal-leg-x",
    sourceEnv: { PATH: "/bin", USERPROFILE: "C:/Users/u", XAI_API_KEY: "xai-secret" } });
  assert.equal(r.kind, "answered");
  assert.equal(r.findings.length, 1);
  assert.equal(r.tokensIn, 10);
  assert.equal(seen.opts.env.HOME, "C:/tmp/tribunal-leg-x");
  assert.equal(seen.opts.env.XAI_API_KEY, undefined);
  assert.equal(seen.opts.cwd, "C:/tmp/tribunal-leg-x");
  assert.match(seen.input, /^review this/);
  assert.ok(!seen.args.includes("review this"), "the artifact never rides on argv");
});

test("resolveExe finds grok in the installer's ~/.grok/bin when PATH predates the install", () => {
  const installed = join("C:\\Users\\u", ".grok", "bin", "grok.exe");
  const r = resolveExe("grok", { env: { Path: "C:\\nowhere", USERPROFILE: "C:\\Users\\u" }, platform: "win32",
    isFile: (p) => p === installed });
  assert.equal(r.found, true);
  assert.equal(r.file, installed);
  assert.equal(resolveExe("codex", { env: { Path: "C:\\nowhere", USERPROFILE: "C:\\Users\\u" }, platform: "win32", isFile: () => false }).found, false);
  assert.equal(cliCommand("grok-cli"), "grok");
});

const counted = ["opus", "sol", "astra"].map((leg) => ({ leg, model: leg, kind: "answered", answered: true, parseFailed: false, findings: [] }));
const registry = [...counted.map((r) => ({ leg: r.leg })), { leg: "grok", advisory: true }];

test("a lost advisory seat cannot make a round PARTIAL", () => {
  const lostGrok = { leg: "grok", model: "grok-4.7", kind: "failed", reason: "unrecognised", answered: false, parseFailed: false, error: "failed: unrecognised", findings: [] };
  const { counted: rest, advisory } = splitAdvisory([...counted, lostGrok], registry);
  assert.equal(advisory.length, 1);
  const { decision } = panelRound(rest, [], { round: 1 });
  assert.equal(decision.reason, "QUIET");
  assert.match(renderAdvisory(advisory), /grok \(grok-4\.7\): did not review/);
});

test("an advisory BLOCKER is shown but never counted", () => {
  const grok = { leg: "grok", model: "grok-4.7", kind: "answered", answered: true, parseFailed: false,
    findings: [{ title: "SQL injection", severity: "BLOCKER", file: "a.ts", line: 3, why: "unescaped" }] };
  const { counted: rest, advisory } = splitAdvisory([...counted, grok], registry);
  assert.equal(rest.some((r) => r.leg === "grok"), false);
  const { summary, decision } = panelRound(rest, [], { round: 1 });
  assert.equal(summary.actionableCount, 0);
  assert.equal(decision.reason, "QUIET");
  const text = renderAdvisory(advisory);
  assert.match(text, /heard, not counted/);
  assert.match(text, /\[BLOCKER\] SQL injection \(a\.ts:3\): unescaped/);
  assert.equal(renderAdvisory([]), "");
});

test("a seat without advisory: true keeps counting", () => {
  const { counted: rest, advisory } = splitAdvisory(counted, [{ leg: "opus", advisory: false }]);
  assert.equal(rest.length, 3);
  assert.equal(advisory.length, 0);
});
