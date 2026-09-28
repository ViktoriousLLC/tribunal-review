// RED-FIRST mutations: let execFileSync ENOENT escape unchanged at the metadata and diff
// reads; swallow ENOENT at the head reread; print raw returned/thrown spawn ENOENT for proof.
import test from "node:test";
import assert from "node:assert/strict";
import { fromPr } from "./artifact.mjs";
import { postLocalProof } from "./run.mjs";

const MESSAGE = "`gh` is not on PATH; --pr and proof posting need the GitHub CLI; --file and --stdin do not";
const HEAD = "a".repeat(40);
const RESULTS = ["opus", "sol", "astra"].map((leg) => ({ leg, kind: "answered", answered: true, parseFailed: false }));
const missingGh = () => Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" });

for (const [stage, failureAt] of [["metadata read", 1], ["diff read", 2], ["head reread", 3]]) {
  test(`fromPr names the missing GitHub CLI once at the ${stage}`, (t) => {
    // RED-FIRST: leave this exec ENOENT raw (or swallow it at the head reread).
    const messages = [];
    t.mock.method(console, "error", (...args) => messages.push(args.join(" ")));
    let calls = 0;
    const exec = (command, args) => {
      assert.equal(command, "gh");
      calls++;
      if (calls === failureAt) throw missingGh();
      return args.includes("diff") ? "diff text" : JSON.stringify({ title: "Review", headRefOid: HEAD });
    };
    try { fromPr(7, { exec }); }
    catch (error) { console.error("tribunal run failed:", error.message); }
    assert.deepEqual(messages, [`tribunal run failed: ${MESSAGE}`]);
    assert.equal(calls, failureAt, "stop before any subsequent gh request");
  });
}

for (const mode of ["returned", "thrown"]) {
  test(`proof posting names ${mode} missing-gh errors once without invalidating the review`, (t) => {
    // RED-FIRST: the returned/thrown proof error path prints its raw ENOENT message.
    const messages = [];
    t.mock.method(console, "error", (...args) => messages.push(args.join(" ")));
    let calls = 0;
    const spawn = (command) => {
      assert.equal(command, "gh");
      calls++;
      const error = missingGh();
      if (mode === "thrown") throw error;
      return { status: null, error, stderr: "" };
    };
    assert.doesNotThrow(() => postLocalProof({ prNumber: 7, headSha: HEAD }, 1, 20, RESULTS, undefined, spawn));
    assert.deepEqual(messages, [`[proof] ${MESSAGE}`]);
    assert.equal(calls, 1);
  });
}
