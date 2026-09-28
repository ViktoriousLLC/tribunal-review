// The goal wall's blocking fixtures must detect a do-nothing guard.
// Run: node --test tribunal/hooks/goal-wall.negative-control.cjs
//
// Substitutes a do-nothing guard for the real hook and runs the rig in EXPECT_NO_GUARD mode:
// every blocking fixture must then be OBSERVED as allowed. If this fails, the rig would be green
// against an empty guard and the real suite's blocks prove nothing about the hook.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');

const directory = fs.mkdtempSync(path.join(tmpdir(), 'tribunal-goal-wall-negctl-'));
const noopGuard = path.join(directory, 'noop-guard.js');
fs.writeFileSync(
  noopGuard,
  '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));\n',
);

const env = { ...process.env, GUARD_UNDER_TEST: noopGuard, EXPECT_NO_GUARD: '1' };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(__dirname, 'goal-wall.test.cjs')], {
  encoding: 'utf8',
  env,
});

assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
fs.rmSync(directory, { recursive: true, force: true });

// EMPTY_CONTROL_RUN is a false green: inherited Node test-worker context can suppress the
// nested runner. Require actual fixture counts as well as a successful process exit.
const counts = /^# tests (\d+)$/m.exec(result.stdout || '');
if (result.status !== 0 || !counts || Number(counts[1]) === 0) {
  process.stderr.write(
    'NEGATIVE CONTROL FAILED. No fixtures ran, or a blocking fixture did not pass a do-nothing guard,\n'
    + "which means the real suite's block proves nothing about this code.\n\n"
    + (result.stdout || '') + (result.stderr || ''),
  );
  process.exit(1);
}

process.stdout.write(`negative control: ${result.stdout.trim().split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join(' | ')}\n`);
