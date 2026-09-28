// Config documentation must reject the same malformed shapes as policy.mjs. Replacing schema
// validation with a no-op must fail the malformed-config assertions.
// RED-FIRST mutations: GATES_DISABLED_BY_DEFAULT omits or disables default gates;
// IGNORE_GATE_OPTOUT discards false values or disables the omitted sibling;
// ACCEPT_INVALID_GATES accepts nonobjects, unknown names, or nonboolean gate values.
// The gate defaults, independent opt-outs, and malformed-gates assertions reject these mutations.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePolicy } from "./policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(join(HERE, name), "utf8"));
const pathFields = ["modelsFile", "reviewerPromptPath", "ledgerHome", "goalsDir", "envFile"];
const legFields = ["enabledLegs", "disabledLegs"];

// Deliberately limited to the schema vocabulary used by the shipped config schema.
// Check every schema node before checking data, including absent optional properties:
// adding an unsupported constraint must fail visibly, never silently weaken validation.
function validate(value, schema) {
  const supported = new Set(["$schema", "title", "description", "type", "properties",
    "additionalProperties", "items", "enum", "minLength", "pattern"]);
  function checkSchema(node) {
    assert.ok(node && typeof node === "object" && !Array.isArray(node), "schema node must be an object");
    for (const key of Object.keys(node)) assert.ok(supported.has(key), `unsupported schema keyword: ${key}`);
    assert.ok(["object", "array", "string", "boolean"].includes(node.type), `unsupported schema type: ${node.type}`);
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, "object schemas must reject unknown properties");
      assert.ok(node.properties && typeof node.properties === "object" && !Array.isArray(node.properties));
      Object.values(node.properties).forEach(checkSchema);
    } else {
      assert.equal(node.properties, undefined);
      assert.equal(node.additionalProperties, undefined);
    }
    if (node.type === "array") checkSchema(node.items);
    else assert.equal(node.items, undefined);
    if (node.enum !== undefined) {
      assert.equal(node.type, "string");
      assert.ok(Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((item) => typeof item === "string"));
    }
    if (node.minLength !== undefined) {
      assert.equal(node.type, "string");
      assert.ok(Number.isInteger(node.minLength) && node.minLength >= 0);
    }
    if (node.pattern !== undefined) {
      assert.equal(node.type, "string");
      assert.equal(typeof node.pattern, "string");
      new RegExp(node.pattern, "u");
    }
  }
  function checkData(data, node, at = "config") {
    if (node.type === "object") {
      assert.ok(data && typeof data === "object" && !Array.isArray(data), `${at} must be an object`);
      for (const [key, child] of Object.entries(data)) {
        assert.ok(Object.hasOwn(node.properties, key), `${at}.${key} is unsupported`);
        checkData(child, node.properties[key], `${at}.${key}`);
      }
    } else if (node.type === "array") {
      assert.ok(Array.isArray(data), `${at} must be an array`);
      data.forEach((child, index) => checkData(child, node.items, `${at}[${index}]`));
    } else if (node.type === "boolean") {
      assert.equal(typeof data, "boolean", `${at} must be a boolean`);
    } else {
      assert.equal(typeof data, "string", `${at} must be a string`);
      if (node.minLength !== undefined) assert.ok([...data].length >= node.minLength, `${at} is too short`);
      if (node.pattern !== undefined) assert.match(data, new RegExp(node.pattern, "u"), `${at} does not match its pattern`);
      if (node.enum !== undefined) assert.ok(node.enum.includes(data), `${at} must be a supported preset`);
    }
  }
  checkSchema(schema);
  checkData(value, schema);
}

test("config example validates and covers every documented policy field", () => {
  const schema = readJson("tribunal.config.schema.json");
  const example = readJson("tribunal.config.example.json");
  const fields = ["preset", "gates", ...pathFields, ...legFields].sort();
  assert.deepEqual(Object.keys(schema.properties).sort(), fields);
  assert.deepEqual(Object.keys(example).sort(), fields);
  validate(example, schema);
});

test("schema accepts optional fields, all presets, and registry-defined leg names", () => {
  // Mutation: omit claude-plus-api-keys from the enum; the schema rejects a supported preset.
  const schema = readJson("tribunal.config.schema.json");
  for (const config of [{}, { preset: "claude-only" }, { preset: "claude-plus-chatgpt" }, { preset: "claude-plus-api-keys" },
    { enabledLegs: [], disabledLegs: [] }, { enabledLegs: ["custom-reviewer", "custom-reviewer"] }]) {
    validate(config, schema);
  }
});

test("schema rejects nonobjects, unknown fields, secrets, and unsupported presets", () => {
  const schema = readJson("tribunal.config.schema.json");
  for (const config of [null, [], "claude-only", 5, true, { surprise: true },
    { apiKey: "not-a-real-key" }, { $schema: "tribunal.config.schema.json" },
    { preset: "unknown" }, { preset: null }, { preset: 42 }]) {
    assert.throws(() => validate(config, schema), undefined, JSON.stringify(config));
  }
});

test("schema rejects empty or mistyped paths and malformed leg arrays", () => {
  const schema = readJson("tribunal.config.schema.json");
  for (const field of pathFields) {
    for (const value of ["", " \t\n", null, 42, [], {}]) {
      assert.throws(() => validate({ [field]: value }, schema), undefined, `${field}: ${JSON.stringify(value)}`);
    }
  }
  for (const field of legFields) {
    for (const value of ["opus", null, 42, {}, [""], [42], [null], ["opus", false]]) {
      assert.throws(() => validate({ [field]: value }, schema), undefined, `${field}: ${JSON.stringify(value)}`);
    }
  }
});

test("minimal validator rejects unsupported schema constraints even on omitted fields", () => {
  assert.throws(() => validate({}, { type: "object", additionalProperties: false,
    properties: { optional: { type: "string", maxLength: 3 } } }), /unsupported schema keyword: maxLength/);
  assert.throws(() => validate({}, { type: "object", additionalProperties: false,
    properties: { optional: { type: "integer" } } }), /unsupported schema type: integer/);
});

test("the complete example resolves through the real policy with repository-relative paths", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "tribunal-config-schema-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, ".git"));
  const example = readJson("tribunal.config.example.json");
  const modelsPath = resolve(repo, example.modelsFile);
  mkdirSync(dirname(modelsPath), { recursive: true });
  copyFileSync(join(HERE, "models.default.json"), modelsPath);
  writeFileSync(join(repo, "tribunal.config.json"), JSON.stringify(example));
  const policy = resolvePolicy(repo);
  assert.deepEqual(policy.gates, { goalWall: true, mergeGate: true });
  assert.deepEqual(policy.gates, example.gates);
  for (const field of pathFields) assert.equal(policy[field], resolve(repo, example[field]));
  for (const field of legFields) assert.deepEqual(policy[field], example[field]);
  for (const name of example.enabledLegs) {
    assert.equal(policy.registry.find((leg) => leg.leg === name).enabled, !example.disabledLegs.includes(name));
  }
  for (const name of example.disabledLegs) assert.equal(policy.registry.find((leg) => leg.leg === name).enabled, false);
});

function gateRepository(t) {
  const repo = mkdtempSync(join(tmpdir(), "tribunal-gates-config-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, ".git"));
  return repo;
}

// Mutation: default either gate to false or omit gates from resolvePolicy; unconfigured repos must enforce both gates.
test("policy enables both gates when configuration or gate fields are omitted", (t) => {
  const repo = gateRepository(t);
  const resolveExecutable = () => ({ found: false });
  assert.deepEqual(resolvePolicy(repo, { resolveExecutable }).gates, { goalWall: true, mergeGate: true });
  for (const config of [{}, { gates: {} }]) {
    writeFileSync(join(repo, "tribunal.config.json"), JSON.stringify(config));
    assert.deepEqual(resolvePolicy(repo, { resolveExecutable }).gates, { goalWall: true, mergeGate: true });
  }
});

// Mutation: ignore false gate values or default an omitted sibling to false; each opt-out must be independent.
test("schema and policy accept independent gate opt-outs and explicit defaults", (t) => {
  const repo = gateRepository(t);
  const schema = readJson("tribunal.config.schema.json");
  for (const gates of [{}, { goalWall: false }, { mergeGate: false },
    { goalWall: false, mergeGate: false }, { goalWall: true, mergeGate: true }]) {
    const config = { gates };
    validate(config, schema);
    writeFileSync(join(repo, "tribunal.config.json"), JSON.stringify(config));
    assert.deepEqual(resolvePolicy(repo, { resolveExecutable: () => ({ found: false }) }).gates,
      { goalWall: true, mergeGate: true, ...gates });
  }
});

// Mutation: accept nonobject gates, unknown gate names, or nonboolean values in either the schema or policy.
test("schema and policy reject malformed gates and unsupported gate fields", (t) => {
  const repo = gateRepository(t);
  const schema = readJson("tribunal.config.schema.json");
  // A valid sibling must work so rejecting every gates object cannot satisfy the malformed cases.
  validate({ gates: { goalWall: true, mergeGate: true } }, schema);
  writeFileSync(join(repo, "tribunal.config.json"), JSON.stringify({ gates: {} }));
  assert.deepEqual(resolvePolicy(repo, { resolveExecutable: () => ({ found: false }) }).gates,
    { goalWall: true, mergeGate: true });
  const invalid = [null, [], false, true, "false", 1, { goalWalls: false }, { mergeGate: false, extra: true }];
  for (const field of ["goalWall", "mergeGate"]) {
    for (const value of [null, "false", 0, 1, [], {}]) invalid.push({ [field]: value });
  }
  for (const gates of invalid) {
    const config = { gates };
    assert.throws(() => validate(config, schema), undefined, JSON.stringify(config));
    writeFileSync(join(repo, "tribunal.config.json"), JSON.stringify(config));
    assert.throws(() => resolvePolicy(repo, { resolveExecutable: () => ({ found: false }) }), /gates/,
      JSON.stringify(config));
  }
});
