// Presets must resolve to complete validated registries and obey consumer policy overrides.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePolicy } from "./policy.mjs";
import { loadRegistry } from "./registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const seats = (legs) => legs.filter((leg) => leg.enabled).map((leg) => leg.leg);

function repo(t, config) {
  const root = mkdtempSync(join(tmpdir(), "trib-presets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify(config));
  return root;
}

test("claude-only is a full registry with only opus enabled", () => {
  // Mutation: omit claude-only.json; selecting the preset fails with ENOENT.
  const path = join(HERE, "presets", "claude-only.json");
  const raw = read(path);
  const full = read(join(HERE, "models.default.json"));
  assert.deepEqual(raw, { ...full, legs: full.legs.map((leg) => ({ ...leg, enabled: leg.leg === "opus" })) });
  assert.deepEqual(seats(loadRegistry(path)), ["opus"]);
});

test("claude-plus-chatgpt is a full registry with opus, sol, and astra enabled", () => {
  // Mutation: omit claude-plus-chatgpt.json; selecting the preset fails with ENOENT.
  const path = join(HERE, "presets", "claude-plus-chatgpt.json");
  const raw = read(path);
  const full = read(join(HERE, "models.default.json"));
  const enabled = ["opus", "sol", "astra"];
  assert.deepEqual(raw, { ...full, legs: full.legs.map((leg) => ({ ...leg, enabled: enabled.includes(leg.leg) })) });
  assert.deepEqual(seats(loadRegistry(path)), enabled);
});

test("claude-plus-api-keys enables opus and documents a disabled unpriced compatible example", () => {
  // Mutation: omit the API-key preset; an endpoint/key example cannot be selected safely.
  const path = join(HERE, "presets", "claude-plus-api-keys.json");
  const raw = read(path);
  const legs = loadRegistry(path);
  assert.deepEqual(seats(legs), ["opus"]);
  assert.deepEqual(legs.find((leg) => leg.leg === "opus"), read(join(HERE, "models.default.json")).legs.find((leg) => leg.leg === "opus"));
  const example = legs.find((leg) => leg.runner === "openai-api");
  assert.ok(example, "the new preset must carry an actual compatible runner row");
  assert.equal(example.enabled, false);
  assert.equal(example.id, "your-model-id");
  assert.equal(example.baseUrl, "https://api.example.com/v1");
  assert.equal(example.billing, "metered");
  assert.deepEqual(example.envKeys, ["COMPATIBLE_API_KEY"]);
  assert.deepEqual(example.requiredEnv, example.envKeys);
  assert.deepEqual(example.pricesUSDPer1M, {}, "a template must not promise invented vendor prices");
  assert.match(JSON.stringify([raw.$comment, example.$comment]), /example/i);
});

test("policy resolves each preset from a consumer repository", (t) => {
  // Mutation: omit preset from policy's supported fields; both names are rejected.
  for (const [preset, expected] of [["claude-only", ["opus"]], ["claude-plus-chatgpt", ["opus", "sol", "astra"]], ["claude-plus-api-keys", ["opus"]]]) {
    const root = repo(t, { preset });
    const policy = resolvePolicy(root);
    assert.equal(policy.modelsFile, join(HERE, "presets", `${preset}.json`));
    assert.deepEqual(seats(policy.registry), expected);
  }
});

test("an explicit modelsFile takes precedence over the preset", (t) => {
  // Mutation: omit preset support; even a valid explicit modelsFile is rejected.
  const root = repo(t, { preset: "claude-only", modelsFile: "custom.json" });
  const full = read(join(HERE, "models.default.json"));
  writeFileSync(join(root, "custom.json"), JSON.stringify({ ...full, legs: full.legs.map((leg) => ({ ...leg, enabled: leg.leg === "sol" })) }));
  const policy = resolvePolicy(root);
  assert.equal(policy.modelsFile, join(root, "custom.json"));
  assert.deepEqual(seats(policy.registry), ["sol"]);
});

test("enabled and disabled leg overrides still apply to the preset", (t) => {
  // Mutation: omit preset support; the consumer cannot enable a seat in the preset.
  const root = repo(t, { preset: "claude-only", enabledLegs: ["sol", "astra"], disabledLegs: ["astra"] });
  assert.deepEqual(seats(resolvePolicy(root).registry), ["opus", "sol"]);
});

test("preset accepts only the named registries", (t) => {
  // Mutation: omit explicit preset validation; invalid names lose the supported-values error.
  for (const preset of ["claude-api-keys", "../models.default", "", null, 42]) {
    const root = repo(t, { preset });
    assert.throws(() => resolvePolicy(root), /preset must be one of: claude-only, claude-plus-chatgpt/);
  }
});
