// Test the proof producer so it cannot certify a partial or unreadable panel.
//
// Validate the marker writer as well as its reader: the producer must enforce every rule about
// which reviews can be certified before publishing proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import { postLocalProof } from "./run.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HEAD = "a".repeat(40);
const artifact = { prNumber: 7, headSha: HEAD };
const leg = (name, { answered = true, parseFailed = false } = {}) => ({ leg: name, answered, parseFailed });
const FOUR_READ = [leg("opus"), leg("fable"), leg("sol"), leg("terra")];

/** Capture the gh invocation instead of making one. */
function capture() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts && opts.input, env: opts && opts.env });
    return { status: 0, stdout: "[]", stderr: "" };
  };
  return { calls, spawn };
}

function blobOf(input) {
  const m = /eval-data:v1:\s*([A-Za-z0-9+/=]+)\s*:end/.exec(input);
  assert.ok(m, `no eval-data marker in the body: ${input}`);
  return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
}

test("a full, readable panel posts a marker naming every leg", () => {
  const { calls, spawn } = capture();
  postLocalProof(artifact, 3, 12345, FOUR_READ, undefined, spawn);
  assert.equal(calls.length, 2, "list existing comments, then create exactly one comment");
  const blob = blobOf(JSON.parse(calls[1].input).body);
  assert.equal(blob.head_sha, HEAD);
  assert.equal(blob.panel_source, "local");
  assert.deepEqual(blob.legs, ["opus", "fable", "sol", "terra"]);
  assert.equal(blob.legs_total, 4);
  assert.equal(blob.panel_run_id, undefined, "a local run must never claim an Actions run id");
});

test("an ANSWERED but UNREADABLE leg blocks the proof entirely", () => {
  // A reply that cannot be parsed contributes no findings. Counting only `answered` would
  // certify three readable legs and one unreadable leg as a full panel.
  const { calls, spawn } = capture();
  postLocalProof(artifact, 3, 1, [...FOUR_READ.slice(0, 3), leg("terra", { parseFailed: true })], undefined, spawn);
  assert.equal(calls.length, 0, "a partially unreadable panel must certify nothing");
});

test("a missing leg blocks the proof", () => {
  const { calls, spawn } = capture();
  postLocalProof(artifact, 3, 1, [...FOUR_READ.slice(0, 3), leg("terra", { answered: false })], undefined, spawn);
  assert.equal(calls.length, 0);
});

test("a registry shrunk below the floor cannot certify itself", () => {
  // `legs_total` is the count of ENABLED legs, so "every leg was read" is true by construction
  // for a one-leg registry. The floor is what stops a panel shrinking its way to a pass.
  const { calls, spawn } = capture();
  postLocalProof(artifact, 3, 1, [leg("opus"), leg("fable")], undefined, spawn);
  assert.equal(calls.length, 0, "two legs is below the cross-model floor");
});

test("no PR and no head SHA means nothing is posted", () => {
  const { calls, spawn } = capture();
  postLocalProof({ prNumber: null, headSha: HEAD }, 1, 1, FOUR_READ, undefined, spawn);
  postLocalProof({ prNumber: 7, headSha: null }, 1, 1, FOUR_READ, undefined, spawn);
  assert.equal(calls.length, 0);
});

test("--repo is threaded through API placeholders and a missing proof is created", () => {
  const { calls, spawn } = capture();
  postLocalProof(artifact, 1, 1, FOUR_READ, "owner/other", spawn);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.env.GH_REPO, "owner/other", "a run given a repo must not comment on a different one");
  assert.deepEqual(calls[1].args, ["api", "--method", "POST", "repos/{owner}/{repo}/issues/7/comments", "--input", "-"]);
});

test("a failed gh call warns and does not throw", () => {
  // The review succeeded; a comment that would not post must not turn that into a failure.
  const spawn = () => ({ status: 1, stdout: "", stderr: "no auth" });
  const original = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(" "));
  try {
    assert.doesNotThrow(() => postLocalProof(artifact, 1, 1, FOUR_READ, undefined, spawn));
  } finally {
    console.error = original;
  }
  assert.ok(seen.some((l) => /could not post/i.test(l)), `expected a warning, got ${JSON.stringify(seen)}`);
});

test("the parseFailed field this filter depends on is the one legRunner really sets", () => {
  // `postLocalProof` counts legs that answered AND did not set `parseFailed`. That field is
  // produced in another file, so a rename there would leave this filter silently counting
  // UNREADABLE legs as read and certifying a degraded panel as a full one. Pin the producer and
  // consumer together because tests with independently constructed fixtures can miss a field
  // rename across that boundary.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "legRunner.mjs"), "utf8");
  assert.match(src, /parseFailed:\s*Boolean\(/,
    "legRunner must still emit parseFailed on its leg results");
  const summary = readFileSync(join(here, "panelLogic.mjs"), "utf8");
  assert.match(summary, /l\.answered && l\.parseFailed/,
    "and summariseRound must still read it the same way, or 'readable' means two different things");
});

test("importing this module does NOT run the CLI", () => {
  // The entry-point guard allows helpers to be imported without starting reviews or making
  // external calls. Removing the guard must fail this assertion.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "run.mjs"), "utf8");
  assert.match(src, /if \(process\.argv\[1\][\s\S]{0,120}main\(\)/,
    "run.mjs must only call main() when it IS the entry point");
});
