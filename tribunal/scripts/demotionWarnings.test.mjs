// A fallback can complete a review with a different model tier than configured. Require a
// visible warning naming both the unavailable primary and the model that answered.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { demotionWarnings } from "./run.mjs";

const REGISTRY = [
  { leg: "gemini", id: "gemini-3.1-pro-preview", fallback: "gemini-3.8-flash" },
  { leg: "opus", id: "claude-opus-5" },
];

test("an answer from a non-primary rung produces a loud warning naming both rungs", () => {
  const w = demotionWarnings([{ leg: "gemini", model: "gemini-3.8-flash", kind: "answered", answered: true }], REGISTRY);
  assert.equal(w.length, 1);
  assert.match(w[0], /DEMOTED/);
  assert.match(w[0], /gemini-3\.1-pro-preview/);
  assert.match(w[0], /gemini-3\.8-flash/);
});

test("an answer from the primary rung warns nothing, and unknown legs are ignored", () => {
  assert.deepEqual(demotionWarnings([
    { leg: "gemini", model: "gemini-3.1-pro-preview", kind: "answered", answered: true },
    { leg: "mystery", model: "x", kind: "answered", answered: true },
    { leg: "opus", model: "claude-opus-5", kind: "not-run" },
  ], REGISTRY), []);
});

test("run.mjs actually prints these warnings (source pin: a consumer test cannot see the producer stop calling it)", () => {
  const src = readFileSync(fileURLToPath(new URL("./run.mjs", import.meta.url)), "utf8");
  assert.match(src, /demotionWarnings\(results/, "run.mjs must feed results through demotionWarnings");
});
