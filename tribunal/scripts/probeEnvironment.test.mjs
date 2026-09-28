// Probe calls must use the runner's environment allowlist so they measure the same credential
// access and exclude the same unrelated secrets as real reviews.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { probeClaude, probeCodex } from "./isolationProbe.mjs";
import { argsForLeg, envForLeg } from "./legRunner.mjs";

const registry = [
  { leg: "opus", id: "test-claude", runner: "claude-cli", envKeys: ["CLAUDE_CODE_OAUTH_TOKEN"] },
  { leg: "sol", id: "test-codex", runner: "codex-cli", envKeys: ["CODEX_HOME", "CODEX_TEST_TOKEN"] },
];
const sourceEnv = {
  PATH: "", HOME: "/test-home", CODEX_HOME: "/test-codex-home",
  CLAUDE_CODE_OAUTH_TOKEN: "claude-test-credential", CODEX_TEST_TOKEN: "codex-test-credential",
  GEMINI_API_KEY: "excluded-test-key", OTHER_SECRET: "excluded-test-secret",
};

for (const [index, probe, ownKey, otherKey] of [
  [0, probeClaude, "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_TEST_TOKEN"],
  [1, probeCodex, "CODEX_TEST_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
]) {
  // RED-FIRST mutation: omit leg-specific environment variables instead of using envForLeg.
  test(`${registry[index].runner} probe spawns with exactly its selected leg's allowlist`, async () => {
    const calls = [];
    const selectedLeg = registry[index];
    const spawnFn = (file, args, options) => {
      calls.push({ file, args, ...options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { write() {}, end() {} };
      setImmediate(() => { child.stdout.emit("data", "CANNOT-READ"); child.emit("close", 0); });
      return child;
    };
    await probe("direct ask", "injection", "TRIBUNAL-CANARY-0123456789abcdef", selectedLeg,
      { spawnFn, mkTemp: async () => process.cwd(), sourceEnv });
    assert.equal(calls.length, 3, "control, guarded and injection each spawn once");
    for (const call of calls) {
      assert.equal(call.env[ownKey], sourceEnv[ownKey]);
      assert.equal(call.env[otherKey], undefined);
      assert.equal(call.env.GEMINI_API_KEY, undefined);
      assert.deepEqual(call.env, envForLeg(selectedLeg, sourceEnv).env);
      assert.equal(call.shell, false);
    }
    const guarded = argsForLeg(selectedLeg);
    assert.deepEqual(calls[1].args.slice(-guarded.length), guarded);
    assert.deepEqual(calls[2].args.slice(-guarded.length), guarded);
  });
}
