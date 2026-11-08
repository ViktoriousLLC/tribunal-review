import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveCodexFamilies, codexCliVersion } from "./modelFamilies.mjs";
import { allPinnedIds, validateLegs } from "./registry.mjs";
import { resolveExe } from "./executable.mjs";

const sol = { leg: "sol", runner: "codex-cli", id: "gpt-5.6-sol", family: "sol",
  billing: "plan", envKeys: [], enabled: true };
const model = (slug, extra = {}) => ({ slug, visibility: "list", default_reasoning_level: "low", ...extra });
const cache = { client_version: "0.163.0", models: [
  model("gpt-6-sol"), model("gpt-5.6-sol", { default_reasoning_level: "medium" }), model("gpt-6.1-sol"),
  model("gpt-7-sol", { visibility: "hide" }), model("gpt-9-astra"), model("gpt-10-sol-preview"),
] };
const options = { codexVersion: "0.163.0", readFile: () => JSON.stringify(cache) };

test("newest visible family version wins numerically, preserving the pin without mutation", () => {
  const [result] = resolveCodexFamilies([sol], options);
  assert.equal(result.id, "gpt-6.1-sol");
  assert.equal(result.pinnedId, sol.id);
  assert.equal(result.resolvedFrom, "family");
  assert.equal(result.effortShown, "low (model default)");
  assert.equal(result.notice, undefined);
  assert.equal(sol.id, "gpt-5.6-sol");
  assert.deepEqual(allPinnedIds([result]).map((entry) => entry.id), ["gpt-6.1-sol", sol.id]);
  const newer = { ...cache, models: [...cache.models, model("gpt-6.10-sol"), model("gpt-6.2-sol")] };
  assert.equal(resolveCodexFamilies([sol], { ...options, readFile: () => JSON.stringify(newer) })[0].id, "gpt-6.10-sol");
});

test("older CLI keeps its pin and that model's effort, with actionable upgrade notice", () => {
  const [result] = resolveCodexFamilies([sol], { ...options, codexVersion: "0.157.1" });
  assert.equal(result.id, sol.id);
  assert.equal(result.resolvedFrom, undefined);
  assert.equal(result.effortShown, "medium (model default)");
  assert.equal(result.notice, "Codex CLI 0.157.1 is older than its model list (0.163.0); gpt-6.1-sol is available after upgrading Codex (npm i -g @openai/codex). Using gpt-5.6-sol.");
  assert.equal(resolveCodexFamilies([{ ...sol, id: "gpt-6.1-sol" }], { ...options, codexVersion: "0.157.1" })[0].notice, undefined);
});

test("equal and newer CLI versions admit the model list", () => {
  for (const codexVersion of ["0.163.0", "0.164.0", "1.0.0"]) {
    assert.equal(resolveCodexFamilies([sol], { ...options, codexVersion })[0].id, "gpt-6.1-sol");
  }
});

test("unavailable, malformed, empty or unreadable model information keeps the pin and names the failure", () => {
  for (const override of [
    { readFile: () => { throw new Error("ENOENT"); } },
    { readFile: () => "{" }, { readFile: () => "null" }, { readFile: () => "{}" },
    { readFile: () => JSON.stringify({ ...cache, models: [null, {}, model("gpt-7-sol", { visibility: "hide" })] }) },
    { codexVersion: null }, { codexVersion: "unknown" },
    { readFile: () => JSON.stringify({ ...cache, client_version: "unknown" }) },
  ]) {
    const [result] = resolveCodexFamilies([sol], { ...options, ...override });
    assert.equal(result.id, sol.id);
    assert.equal(result.resolvedFrom, undefined);
    assert.match(result.notice, /using gpt-5\.6-sol/);
  }
});

test("reads the selected Codex home and explicit effort wins over defaults", () => {
  const codexHome = join("fixture", "codex");
  const [result] = resolveCodexFamilies([{ ...sol, effort: "high" }], { ...options, codexHome,
    readFile: (path, encoding) => {
      assert.equal(path, join(codexHome, "models_cache.json"));
      assert.equal(encoding, "utf8");
      return JSON.stringify(cache);
    } });
  assert.equal(result.effortShown, "high (set)");
  const [pinned] = resolveCodexFamilies([{ ...sol, family: undefined }], options);
  assert.equal(pinned.id, sol.id);
  assert.equal(pinned.effortShown, "medium (model default)");
  const claude = { runner: "claude-cli", id: "opus" };
  const rows = resolveCodexFamilies([claude, { ...claude, effort: "max" }], {
    readFile: () => assert.fail("Claude does not need the Codex cache"),
  });
  assert.deepEqual(rows.map((leg) => leg.effortShown), ["model default", "max (set)"]);
});

test("family is Codex-only and effort accepts exactly the supported vocabulary", () => {
  assert.deepEqual(validateLegs([sol]), []);
  for (const family of ["", "Sol", "sol.*", 42, null]) {
    assert.ok(validateLegs([{ ...sol, family }]).some((problem) => problem.includes("family")));
  }
  assert.ok(validateLegs([{ ...sol, runner: "claude-cli" }]).some((problem) => problem.includes("family")));
  for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
    assert.deepEqual(validateLegs([{ ...sol, effort }]), []);
  }
  for (const effort of ["", "default", "HIGH", null, 1]) {
    assert.ok(validateLegs([{ ...sol, effort }]).some((problem) => problem.includes("effort")));
  }
});

test("CLI version probe uses the runner executable, no shell and a ten-second timeout", () => {
  const executable = resolveExe("codex");
  assert.equal(codexCliVersion((file, args, config) => {
    assert.equal(file, executable.file);
    assert.deepEqual(args, [...executable.prefix, "--version"]);
    assert.equal(config.timeout, 10000);
    assert.equal(config.shell, false);
    return { status: 0, stdout: "codex-cli 0.157.1\n" };
  }), "0.157.1");
  for (const result of [{ status: 1, stdout: "codex-cli 0.157.1" }, { status: 0, stdout: "invalid" },
    { status: 0, stdout: "" }, { status: null, error: new Error("timeout") }]) {
    assert.equal(codexCliVersion(() => result), null);
  }
  assert.equal(codexCliVersion(() => { throw new Error("missing"); }), null);
});

test("two seats never resolve onto one model", () => {
  const pinned61 = { leg: "custom", runner: "codex-cli", id: "gpt-6.1-sol", billing: "plan", envKeys: [], enabled: true };
  const [, result] = resolveCodexFamilies([pinned61, sol], options);
  assert.equal(result.id, "gpt-6-sol", "the family seat takes the next newest when the newest is another seat's");
  assert.match(result.notice, /already the custom seat's model; using gpt-6-sol/);
  const twin = { ...sol, leg: "sol-b", id: "gpt-6-sol" };
  const [first, second] = resolveCodexFamilies([sol, twin], options);
  assert.equal(first.id, "gpt-6.1-sol");
  assert.equal(second.id, "gpt-6-sol");
  assert.notEqual(first.id, second.id);
});

test("a family seat that would collide takes the next newest model, in either seat order", () => {
  const a = { ...sol, leg: "a", id: "gpt-6-sol" }, b = { ...sol, leg: "b", id: "gpt-6.1-sol" };
  for (const order of [[a, b], [b, a]]) {
    const ids = resolveCodexFamilies(order, options).map((leg) => leg.id);
    assert.equal(new Set(ids).size, 2, `distinct models for ${order.map((l) => l.leg)}: ${ids}`);
  }
  const c = { ...sol, leg: "c", id: "gpt-5.6-sol" }, d = { ...sol, leg: "d", id: "gpt-5.6-sol-old" };
  const ids = resolveCodexFamilies([c, d], options).map((leg) => leg.id);
  assert.deepEqual(ids, ["gpt-6.1-sol", "gpt-6-sol"], "the second seat takes the next newest");
});

test("a Claude seat's effort is the documented default for the model that answered, never a guess", async () => {
  const { claudeEffortShown } = await import("./modelFamilies.mjs");
  assert.equal(claudeEffortShown("claude-opus-5-5"), "medium (model default)");
  assert.equal(claudeEffortShown("claude-fable-5-1"), "high (model default)");
  assert.equal(claudeEffortShown("claude-opus-9"), "model default (level not reported)");
  assert.equal(claudeEffortShown("constructor"), "model default (level not reported)");
  assert.equal(claudeEffortShown("claude-opus-5-5", "xhigh"), "xhigh (set)");
});
