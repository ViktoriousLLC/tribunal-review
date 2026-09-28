// RED-FIRST mutations: automatic-proof (post without --post-proof), edit-last (overwrite
// an unrelated newest comment), unowned-marker (omit the plugin marker), zero-cost-proof
// (replace the ledger's measured/unknown costs with a hardcoded zero).
// Additional mutations: out-json-raw-proof (emit plain proof with --out --json),
// measured-zero-as-plan (render a measured zero with the plan-only "$0" shorthand).
// The integration fixture runs real main/policy/artifact/banking/rendering with only gh
// and model calls stubbed. All scratch paths stay in the OS temp directory.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { argsForLeg } from "./legRunner.mjs";
import { postLocalProof } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HEAD = "a".repeat(40);
const MARKER = "<!-- tribunal-proof -->";
const RESULTS = ["plan", "measured", "unreported"].map((leg) => ({ leg, kind: "answered", answered: true, parseFailed: false }));
const METERED = { rows: [
  { leg: "plan", usd: 0, basis: "plan (no key can reach this process)" },
  { leg: "measured", usd: 0.012345, basis: "computed from the runner's own token counts" },
  { leg: "unreported", usd: null, basis: "NOT REPORTED" },
], totalUsd: 0.012345, unmeasured: ["unreported"] };
const blobOf = (body) => JSON.parse(Buffer.from(/eval-data:v1:\s*([A-Za-z0-9+/=]+)\s*:end/.exec(body)?.[1] || "", "base64").toString("utf8"));

function capture(comments = []) {
  const calls = [];
  return { calls, spawn: (cmd, args, options) => {
    assert.equal(cmd, "gh");
    calls.push({ args, options });
    return { status: 0, stdout: JSON.stringify(comments), stderr: "" };
  } };
}
function post(spawn, options = {}) {
  return postLocalProof({ prNumber: 7, headSha: HEAD }, 1, 20, RESULTS, "owner/other", spawn,
    { action: "STOP", reason: "QUIET" }, { actionableCount: 0 }, { metered: METERED, ...options });
}
function bodyOf(call) {
  try { return JSON.parse(call.options.input).body; }
  catch { return call.options.input; }
}

test("proof marker selects its own comment across pages among unrelated comments", () => {
  const f = capture([[{ id: 10, body: "An unrelated first comment" }, { id: 22, body: `${MARKER}\nOld proof` }],
    [{ id: 33, body: "An unrelated newest comment" }]]);
  post(f.spawn);
  assert.equal(f.calls.length, 2, "list comments, then edit the identified proof");
  assert.deepEqual(f.calls[0].args, ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/issues/7/comments"]);
  assert.equal(f.calls[0].options.env.GH_REPO, "owner/other");
  assert.deepEqual(f.calls[1].args, ["api", "--method", "PATCH", "repos/{owner}/{repo}/issues/comments/22", "--input", "-"]);
  assert.equal(f.calls[1].options.env.GH_REPO, "owner/other");
  assert.ok(bodyOf(f.calls[1]).includes(MARKER));
});

test("when no plugin proof exists a fresh comment is created with its marker", () => {
  const f = capture([[{ id: 33, body: "An unrelated newest comment" }]]);
  post(f.spawn);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].args, ["api", "--method", "POST", "repos/{owner}/{repo}/issues/7/comments", "--input", "-"]);
  assert.ok(bodyOf(f.calls[1]).includes(MARKER));
});

test("proof preserves measured dollars and names unreported costs without claiming a zero total", () => {
  const f = capture([]);
  post(f.spawn);
  const body = bodyOf(f.calls.at(-1));
  assert.match(body, /plan: \$0 \(plan\)/);
  assert.match(body, /measured: \$0\.012345/);
  assert.match(body, /unreported: not reported/);
  const payload = blobOf(body);
  assert.deepEqual(payload.metered, METERED);
  assert.equal(payload.costUSD_total, null, "unknown spend must not be certified as the known subtotal");
  const zero = capture([]);
  const measuredZero = { rows: [{ leg: "measured", usd: 0, basis: "measured token counts" }], totalUsd: 0, unmeasured: [] };
  post(zero.spawn, { metered: measuredZero });
  const zeroBody = bodyOf(zero.calls.at(-1));
  assert.match(zeroBody, /measured: 0 USD \(measured\)/);
  assert.ok(!zeroBody.includes("$0"), "the $0 shorthand is reserved for plan coverage");
  assert.deepEqual(blobOf(zeroBody).metered, measuredZero);
});

test("a fully measured proof retains its exact cost total", () => {
  const f = capture([]);
  const metered = { rows: METERED.rows.slice(0, 2), totalUsd: 0.012345, unmeasured: [] };
  post(f.spawn, { metered });
  assert.equal(blobOf(bodyOf(f.calls.at(-1))).costUSD_total, metered.totalUsd);
});

for (const stdout of ["not json", JSON.stringify({ message: "bad response" })]) {
  test(`an unreadable comment list does not risk creating or editing comments: ${stdout}`, (t) => {
    const warnings = [];
    t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
    const calls = [];
    post((cmd, args) => { calls.push(args); return { status: 0, stdout, stderr: "" }; });
    assert.equal(calls.length, 1);
    assert.ok(warnings.some((warning) => /could not post/.test(warning)));
  });
}

function fixture(t, mode = "quiet") {
  const root = mkdtempSync(join(tmpdir(), "tribunal-proof-posting-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  const ledger = join(root, "ledger");
  mkdirSync(ledger);
  const registry = [
    { leg: "plan", id: "fixture-plan", runner: "codex-cli", billing: "plan", envKeys: [], enabled: true },
    { leg: "measured", id: "fixture-metered", runner: "genai-sdk", billing: "metered", envKeys: [], enabled: true },
    { leg: "unreported", id: "fixture-unreported", runner: "genai-sdk", billing: "metered", envKeys: [], enabled: true },
  ];
  if (mode === "below-floor") registry.pop();
  writeFileSync(join(root, "models.json"), JSON.stringify({ legs: registry }));
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify({ modelsFile: "models.json", ledgerHome: ledger }));
  const executable = join(root, "fixture-codex");
  const probe = { schemaVersion: 1, probeVersion: "fixture", measuredAt: new Date().toISOString(),
    enabledCliRunners: ["codex-cli"], cli: { "codex-cli": { executablePath: executable, executablePrefix: [],
      version: "fixture-cli 1.0", argvShapeHash: createHash("sha256").update(JSON.stringify(argsForLeg({ runner: "codex-cli", id: "" }))).digest("hex"),
      verdict: "PASS" } }, overall: { ok: true, verdict: "PASS" } };
  writeFileSync(join(ledger, "isolation-probe.md"), `\x60\x60\x60json\n${JSON.stringify(probe)}\n\x60\x60\x60\n`);
  const callsFile = join(root, "gh-calls.json");
  const wrapper = join(root, "invoke.mjs");
  writeFileSync(wrapper, `import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import fs, { writeFileSync } from "node:fs";
    const calls = [];
    childProcess.execFileSync = (cmd, args) => {
      if (cmd !== "gh") throw new Error("unexpected command: " + cmd);
      return args.includes("diff") ? "diff fixture" : JSON.stringify({ title: "Fixture PR", body: "Review", headRefOid: ${JSON.stringify(HEAD)} });
    };
    childProcess.spawnSync = (cmd, args, options) => {
      if (cmd !== "gh") throw new Error("unexpected command: " + cmd);
      calls.push({ args, input: options.input });
      return { status: 0, stdout: "[]", stderr: "" };
    };
    if (${JSON.stringify(mode)} === "bank-failure") fs.appendFileSync = () => { throw new Error("fixture ledger write failed"); };
    syncBuiltinESMExports();
    const { main } = await import(${JSON.stringify(pathToFileURL(join(HERE, "run.mjs")).href)});
    await main({ probeOptions: {
      resolveExecutable: () => ({ file: ${JSON.stringify(executable)}, prefix: [], found: true }),
      spawnVersion: () => ({ status: 0, stdout: "fixture-cli 1.0\\n", stderr: "" }),
    }, reviewLeg: async (leg) => {
      return { leg: leg.leg, model: leg.id, kind: "answered", answered: true,
        parseFailed: ${JSON.stringify(mode)} === "partial", error: null, raw: "stub", findings: [],
        ...(leg.leg === "measured" ? { usd: 0.012345, tokensIn: 123, tokensOut: 45 } : {}) };
    }});
    writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));`);
  return {
    root,
    invoke: (args = []) => spawnSync(process.execPath, [wrapper, "--pr", "7", ...args], {
      cwd: root, encoding: "utf8", timeout: 15000, env: process.env,
    }),
    calls: () => JSON.parse(readFileSync(callsFile, "utf8")),
    rows: () => readdirSync(ledger).filter((name) => name.endsWith(".ndjson")).map((name) => JSON.parse(readFileSync(join(ledger, name), "utf8").trim())),
  };
}

test("a PR round without --post-proof prints proof and calls no comment API", (t) => {
  const f = fixture(t);
  const result = f.invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [], "default PR review must not list or mutate comments");
  assert.ok(result.stdout.includes(MARKER), result.stdout);
  assert.deepEqual(blobOf(result.stdout).metered, f.rows()[0].metered);
  assert.match(result.stdout, /measured: \$0\.012345/);
  assert.match(result.stdout, /unreported: not reported/);
});

test("--post-proof posts the same metered summary banked by the real runner", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--post-proof"]);
  assert.equal(result.status, 0, result.stderr);
  const body = bodyOf({ options: { input: f.calls().at(-1).input } });
  assert.ok(body.includes(MARKER));
  assert.deepEqual(blobOf(body).metered, f.rows()[0].metered);
  assert.match(body, /measured: \$0\.012345/);
  assert.match(body, /unreported: not reported/);
});

test("--json keeps valid JSON and includes the unposted proof field", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.proof.includes(MARKER));
  assert.deepEqual(blobOf(output.proof).metered, output.record.metered);
  assert.deepEqual(f.calls(), []);
});

test("--out --json prints a JSON proof field while saving the full JSON report", (t) => {
  const f = fixture(t);
  const destination = join(f.root, "report.json");
  const result = f.invoke(["--out", destination, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  const saved = JSON.parse(readFileSync(destination, "utf8"));
  assert.deepEqual(stdout, { proof: saved.proof });
  assert.ok(stdout.proof.includes(MARKER));
  assert.deepEqual(blobOf(stdout.proof).metered, saved.record.metered);
  assert.deepEqual(f.calls(), []);
});

for (const mode of ["partial", "below-floor", "bank-failure"]) {
  test(`--post-proof still withholds proof for ${mode}`, (t) => {
    const f = fixture(t, mode);
    const result = f.invoke(["--post-proof"]);
    assert.equal(result.status, mode === "below-floor" ? 0 : 1, result.stderr);
    assert.deepEqual(f.calls(), []);
    assert.ok(!result.stdout.includes(MARKER));
  });
}
