// CLI fallback properties would advertise behavior the runner does not implement. The default
// registry and every preset must omit them while retaining implemented SDK fallbacks.
import test from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "./registry.mjs";
import { fileURLToPath } from "node:url";

for (const filename of ["models.default.json", "presets/claude-only.json", "presets/claude-plus-chatgpt.json"]) {
  // RED-FIRST mutation: add a CLI fallback property even though the runner has no safe
  // model-specific rejection classifier or fallback dispatch for CLI legs.
  test(`${filename} advertises fallback only for the SDK runner that implements it`, () => {
    const registry = loadRegistry(fileURLToPath(new URL(filename, import.meta.url)));
    const cli = registry.filter((leg) => ["claude-cli", "codex-cli"].includes(leg.runner));
    assert.ok(cli.length > 0);
    for (const leg of cli) assert.equal(Object.hasOwn(leg, "fallback"), false, `${leg.leg} has an inert CLI fallback`);
    assert.ok(registry.find((leg) => leg.runner === "genai-sdk").fallback,
      "the implemented Gemini fallback remains configured");
  });
}
