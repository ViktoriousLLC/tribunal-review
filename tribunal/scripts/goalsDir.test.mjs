import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { resolvePolicy } from "./policy.mjs";

function withRepo(config, check) {
  const root = mkdtempSync(join(tmpdir(), "tribunal-goals-policy-test-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify(config));
  try { check(root); } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  }
}

// Mutation M4A_FIXED_GOALS_DIR: omit goalsDir from the shared policy or keep a hook-local constant.
test("goalsDir defaults to the consumer repository's docs/reference/goals", () => {
  withRepo({}, (root) => {
    const policy = resolvePolicy(join(root, "nested"));
    assert.equal(policy.repoRoot, root);
    assert.equal(policy.goalsDir, join(root, "docs", "reference", "goals"));
  });
});

test("goalsDir accepts relative and absolute configured paths through policy resolution", () => {
  withRepo({ goalsDir: "planning/Decisions" }, (root) => {
    assert.equal(resolvePolicy(join(root, "nested")).goalsDir, join(root, "planning", "Decisions"));
    const absolute = join(root, "absolute-goals");
    writeFileSync(join(root, "tribunal.config.json"), JSON.stringify({ goalsDir: absolute }));
    assert.equal(resolvePolicy(root).goalsDir, absolute);
  });
});

test("goalsDir rejects every non-path value using the existing path-field validation", () => {
  for (const goalsDir of ["", "  ", null, false, 7, [], {}]) {
    withRepo({ goalsDir }, (root) => {
      assert.throws(() => resolvePolicy(root), /goalsDir must be a nonempty path/);
    });
  }
});
