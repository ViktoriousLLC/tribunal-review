// envFile: a repo config may name a gitignored env file whose variables load only when unset.
// Policy validation must accept the field while preserving existing environment values.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePolicy } from "./policy.mjs";

function fakeRepo(config, envText) {
  const root = mkdtempSync(join(tmpdir(), "trib-envfile-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify(config));
  if (envText !== undefined) writeFileSync(join(root, "secrets.env"), envText);
  return root;
}

test("envFile vars load into process.env only when unset, quotes stripped", () => {
  const root = fakeRepo({ envFile: "secrets.env" },
    'TRIBUNAL_TEST_UNSET="from-file"\nTRIBUNAL_TEST_PRESET=loser\n# comment\n');
  delete process.env.TRIBUNAL_TEST_UNSET;
  process.env.TRIBUNAL_TEST_PRESET = "winner";
  try {
    const policy = resolvePolicy(root);
    assert.equal(process.env.TRIBUNAL_TEST_UNSET, "from-file");
    assert.equal(process.env.TRIBUNAL_TEST_PRESET, "winner");
    assert.equal(policy.envFile, join(root, "secrets.env"));
  } finally {
    delete process.env.TRIBUNAL_TEST_UNSET;
    delete process.env.TRIBUNAL_TEST_PRESET;
  }
});

test("a configured envFile that does not exist is skipped, matching a keyless checkout", () => {
  const root = fakeRepo({ envFile: "absent.env" });
  const policy = resolvePolicy(root);
  assert.equal(policy.envFile, join(root, "absent.env"));
});

test("envFile must be a nonempty path", () => {
  const root = fakeRepo({ envFile: "" });
  assert.throws(() => resolvePolicy(root), /envFile must be a nonempty path/);
});
