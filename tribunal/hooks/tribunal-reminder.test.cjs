// Tests for the Tribunal reminder hook with isolated policy/ledger paths.
//
// The hook is SPAWNED, never required. A Claude hook reads stdin at load, so an in-process
// import can hang a runner with no failing assertion. spawnSync closes stdin; require does not.
//
// Unreviewed PR merges block within a per-session budget; goal writes still only remind.
// Reviewed PRs, unrelated commands, and unrelated paths stay silent.
// Mutations: MERGE_REMINDER_ONLY restores exit 0 for an unreviewed PR; MERGE_NO_BRAKE keeps
// blocking after three attempts; MERGE_SHARED_BUDGET shares counts across PRs or sessions;
// MERGE_IGNORE_BREAKGLASS and MERGE_IGNORE_ENV disregard the explicit escape hatches;
// MERGE_IGNORE_OPTOUT disregards gates.mergeGate; MERGE_BROKEN_STATE blocks without a
// readable/writable budget; MERGE_CORRUPT_STATE silently disarms instead of repairing it.
// MERGE_FIRST_ONLY checks only the first merge in a chain; MERGE_DUPLICATE_BLOCKS spends
// multiple attempts for the same PR within one tool invocation.
// MERGE_NON_PR_SUFFIX mistakes a repository flag value or branch suffix for a PR number.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join, resolve, sep, dirname } = require("node:path");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");

const HOOK = join(__dirname, "tribunal-reminder.js");
const TEST_ROOT = mkdtempSync(join(tmpdir(), "tribunal-reminder-test-"));
const LEDGER = join(TEST_ROOT, "ledger");
mkdirSync(join(TEST_ROOT, ".git"));
writeFileSync(join(TEST_ROOT, "tribunal.config.json"), JSON.stringify({ ledgerHome: LEDGER }));
after(() => {
  assert.ok(resolve(TEST_ROOT).startsWith(resolve(tmpdir()) + sep));
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function fire(payload, options = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: TEST_ROOT, ...payload }), encoding: "utf8", cwd: TEST_ROOT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: "", TRIBUNAL_ALLOW_UNREVIEWED_MERGE: "" }, ...options,
  });
  // THE NOTICE IS ON STDOUT, AS JSON. Claude Code does not surface stderr on a successful
  // hook exit, so assertions must read stdout to verify that users receive the notice.
  let notice = "";
  try { notice = JSON.parse(r.stdout || "{}").systemMessage || ""; } catch { notice = ""; }
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", notice };
}

test("a gh pr merge for an unreviewed PR blocks with exit 2 and names the command", () => {
  const r = fire({ tool_name: "Bash", tool_input: { command: "gh pr merge 999123 --squash" } });
  assert.equal(r.code, 2, "an unreviewed PR must block by default");
  assert.match(r.err, /PR #999123 has no recorded local panel/);
  assert.match(r.err, /\/tribunal-review:review 999123/);
  assert.match(r.err, /Block 1 of 3/);
  assert.equal(r.out, "", "a block is reported through stderr");
});

test("the merge brake stands down loudly after three blocks per PR per session", () => {
  const merge = (pr, session = "merge-brake") => fire({ session_id: session, tool_name: "Bash", tool_input: { command: `gh pr merge ${pr}` } });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = merge(999124);
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(`Block ${attempt} of 3`));
  }
  for (let attempt = 4; attempt <= 5; attempt += 1) {
    const r = merge(999124);
    assert.equal(r.code, 0);
    assert.match(r.notice, /STAND-DOWN.*3 blocks.*PR #999124/);
    assert.match(r.notice, /UNREVIEWED/);
  }
  assert.equal(merge(999125).code, 2, "another PR has its own budget");
  assert.equal(merge(999124, "another-session").code, 2, "another session has its own budget");
  const state = JSON.parse(readFileSync(join(LEDGER, "merge-state-merge-brake.json"), "utf8"));
  assert.equal(state["PR #999124"], 3, "state lives under the configured ledger home");
});

test("the consumer break-glass file allows an unreviewed merge loudly", () => {
  const glass = join(TEST_ROOT, ".claude", "tribunal-wall-breakglass");
  mkdirSync(dirname(glass), { recursive: true });
  writeFileSync(glass, "");
  try {
    const r = fire({ session_id: "merge-glass", tool_name: "Bash", tool_input: { command: "gh pr merge 999126" } });
    assert.equal(r.code, 0);
    assert.match(r.notice, /BREAK-GLASS.*tribunal-wall-breakglass/);
    assert.match(r.notice, /PR #999126.*UNREVIEWED/);
  } finally { rmSync(glass, { force: true }); }
  assert.equal(fire({ session_id: "merge-glass", tool_name: "Bash", tool_input: { command: "gh pr merge 999126" } }).code, 2);
});

test("the automation env override allows an unreviewed merge loudly only when exactly 1", () => {
  const payload = { session_id: "merge-env", tool_name: "Bash", tool_input: { command: "gh pr merge 999127" } };
  const withOverride = (value) => fire(payload, { env: { ...process.env, CLAUDE_PROJECT_DIR: "", TRIBUNAL_ALLOW_UNREVIEWED_MERGE: value } });
  const r = withOverride("1");
  assert.equal(r.code, 0);
  assert.match(r.notice, /TRIBUNAL_ALLOW_UNREVIEWED_MERGE=1/);
  assert.match(r.notice, /PR #999127.*UNREVIEWED/);
  assert.equal(withOverride("true").code, 2);
});

test("gates.mergeGate false restores the reminder-only behaviour", () => {
  const consumer = mkdtempSync(join(TEST_ROOT, "merge-optout-"));
  mkdirSync(join(consumer, ".git"));
  writeFileSync(join(consumer, "tribunal.config.json"), JSON.stringify({ ledgerHome: "ledger", gates: { mergeGate: false } }));
  const r = fire({ tool_name: "Bash", tool_input: { command: "gh pr merge 999128" } }, { cwd: consumer });
  assert.equal(r.code, 0);
  assert.match(r.notice, /PR #999128 has no recorded local panel/);
  assert.match(r.notice, /reminder only, not a block/);
  assert.match(r.notice, /\/tribunal-review:review 999128/);
});

test("unreadable or unwritable merge state stands down loudly without blocking", () => {
  const state = join(LEDGER, "merge-state-unreadable.json");
  mkdirSync(state, { recursive: true });
  const unreadable = fire({ session_id: "unreadable", tool_name: "Bash", tool_input: { command: "gh pr merge 999129" } });
  assert.equal(unreadable.code, 0);
  assert.match(unreadable.notice, /STAND-DOWN.*state.*cannot be read/);
  assert.match(unreadable.notice, /PR #999129.*UNREVIEWED/);

  const consumer = mkdtempSync(join(TEST_ROOT, "merge-unwritable-"));
  mkdirSync(join(consumer, ".git"));
  writeFileSync(join(consumer, "ledger"), "a file prevents creating the ledger directory");
  writeFileSync(join(consumer, "tribunal.config.json"), JSON.stringify({ ledgerHome: "ledger" }));
  const unwritable = fire({ tool_name: "Bash", tool_input: { command: "gh pr merge 999130" } }, { cwd: consumer });
  assert.equal(unwritable.code, 0);
  assert.match(unwritable.notice, /STAND-DOWN.*state.*cannot be written/);
  assert.match(unwritable.notice, /PR #999130.*UNREVIEWED/);
});

test("corrupt merge state resets and repairs the bounded budget", () => {
  mkdirSync(LEDGER, { recursive: true });
  const file = join(LEDGER, "merge-state-corrupt.json");
  for (const contents of ["{broken", "null", "[]"]) {
    writeFileSync(file, contents);
    const r = fire({ session_id: "corrupt", tool_name: "Bash", tool_input: { command: "gh pr merge 999131" } });
    assert.equal(r.code, 2);
    assert.match(r.err, /Block 1 of 3/);
    assert.equal(JSON.parse(readFileSync(file, "utf8"))["PR #999131"], 1);
  }
});

test("the PR number is found in every gh pr merge shape, including a URL and flag-first", () => {
  for (const cmd of [
    "gh pr merge 4242",
    "gh pr merge --squash 4242",
    "gh pr merge https://github.com/o/r/pull/4242 --merge",
    'gh pr merge 4242 -b "some body with 999 in it"',
  ]) {
    const r = fire({ session_id: `merge-shape-${cmd}`, tool_name: "Bash", tool_input: { command: cmd } });
    assert.equal(r.code, 2, `failed for: ${cmd}`);
    assert.match(r.err, /PR #4242/, `failed for: ${cmd}`);
  }
});

test("a CHAINED gh pr merge is caught, not just a bare one", () => {
  // Scan every shell segment so a merge following another command still meets the gate.
  for (const cmd of ["git push && gh pr merge 7 --squash", "npm test; gh pr merge 7", "true || gh pr merge 7"]) {
    const r = fire({ tool_name: "Bash", tool_input: { command: cmd } });
    assert.equal(r.code, 2, `missed the merge in: ${cmd}`);
    assert.match(r.err, /PR #7 /, `missed the merge in: ${cmd}`);
  }
});

test("every identified PR in a merge chain is gated even after a reviewed or bare merge", () => {
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-06.ndjson");
  writeFileSync(marker, `${JSON.stringify({ artifact: { source: "PR #777003" } })}\n`);
  try {
    for (const [index, command] of [
      "gh pr merge 777003 && gh pr merge 777004",
      "gh pr merge --squash; gh pr merge 777004",
      "gh pr merge 777003 || gh pr merge --squash 777004",
    ].entries()) {
      const r = fire({ session_id: `multiple-merges-${index}`, tool_name: "Bash", tool_input: { command } });
      assert.equal(r.code, 2, command);
      assert.match(r.err, /\/tribunal-review:review 777004/);
      assert.doesNotMatch(r.err, /PR #777003/);
    }
  } finally { rmSync(marker, { force: true }); }
});

test("a merge chain deduplicates PR budgets and emits one notice after all budgets expire", () => {
  const payload = { session_id: "deduplicated-merges", tool_name: "Bash", tool_input: {
    command: "gh pr merge --squash && gh pr merge 777005; gh pr merge 777005 && gh pr merge 777006",
  } };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = fire(payload);
    assert.equal(r.code, 2);
    assert.match(r.err, /\/tribunal-review:review 777005/);
    assert.match(r.err, /\/tribunal-review:review 777006/);
    const state = JSON.parse(readFileSync(join(LEDGER, "merge-state-deduplicated-merges.json"), "utf8"));
    assert.equal(state["PR #777005"], attempt);
    assert.equal(state["PR #777006"], attempt);
  }
  const r = fire(payload);
  assert.equal(r.code, 0);
  assert.doesNotThrow(() => JSON.parse(r.out), "allow notices must be one valid JSON object");
  assert.match(r.notice, /PR #777005.*UNREVIEWED/);
  assert.match(r.notice, /PR #777006.*UNREVIEWED/);
});

test("a chain that merely MENTIONS a merge in another command is still not a merge", () => {
  const r = fire({ tool_name: "Bash", tool_input: { command: "git commit -m 'prep for gh pr view' && git status" } });
  assert.equal(r.notice.trim(), "");
});

test("a BARE gh pr merge stays silent, because a reminder it can never satisfy is noise", () => {
  // The ledger cannot match a placeholder such as "current branch" to a recorded PR number.
  // Without a number, reminding would nag on every invocation, including after review.
  // Silence avoids a reminder that the user cannot satisfy.
  const { prFromMergeCommand } = require("./tribunal-reminder.js");
  assert.equal(prFromMergeCommand("gh pr merge --squash"), null);
  const r = fire({ tool_name: "Bash", tool_input: { command: "gh pr merge --squash" } });
  assert.equal(r.notice.trim(), "");
  assert.equal(r.code, 0);
});

test("repository flag values and branch names ending in digits do not identify a PR", () => {
  const { prFromMergeCommand } = require("./tribunal-reminder.js");
  for (const command of [
    "gh pr merge --body draft --repo owner/repo123",
    "gh pr merge -R owner/repo123",
    "gh pr merge feature-123",
  ]) {
    assert.equal(prFromMergeCommand(command), null, command);
    const r = fire({ tool_name: "Bash", tool_input: { command } });
    assert.equal(r.code, 0, command);
    assert.equal(r.out, "", command);
    assert.equal(r.err, "", command);
  }
  assert.equal(prFromMergeCommand("gh pr merge --repo owner/repo123 456"), "456");
  assert.equal(prFromMergeCommand("gh pr merge -R owner/repo123 https://github.com/owner/repo123/pull/456"), "456");
});

test("an unrelated Bash command says nothing at all", () => {
  for (const cmd of ["git status", "gh pr view 12", "gh pr create", "npm test"]) {
    const r = fire({ tool_name: "Bash", tool_input: { command: cmd } });
    assert.equal(r.notice.trim(), "", `should be silent for: ${cmd}`);
    assert.equal(r.code, 0);
  }
});

test("a write to a goal statement reminds; a write anywhere else does not", () => {
  const goal = fire({ tool_name: "Write", tool_input: { file_path: "docs/reference/goals/new-thing.md" } });
  assert.match(goal.notice, /this goal statement has no recorded panel/);
  assert.match(goal.notice, /new-thing\.md/);

  for (const p of ["docs/reference/other.md", "backend/src/index.ts", "docs/reference/goals/notes.txt"]) {
    const r = fire({ tool_name: "Write", tool_input: { file_path: p } });
    assert.equal(r.notice.trim(), "", `should be silent for: ${p}`);
  }
});

test("Windows backslash paths are recognised too", { skip: process.platform !== "win32" }, () => {
  const r = fire({ tool_name: "Edit", tool_input: { file_path: "docs\\reference\\goals\\x.md" } });
  assert.match(r.notice, /no recorded panel/);
});

test("a reviewed PR passes silently", () => {
  // The whole difference between a useful nudge and noise people learn to ignore.
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-01.ndjson");
  writeFileSync(marker, JSON.stringify({ artifact: { source: "PR #777001" } }) + "\n", "utf8");
  try {
    const r = fire({ tool_name: "Bash", tool_input: { command: "gh pr merge 777001" } });
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.equal(r.err, "");
    assert.equal(r.notice.trim(), "", "an already-reviewed PR must be silent");
  } finally {
    rmSync(marker, { force: true });
  }
});

test("a corrupt ledger line does not break a merge — it fails open", () => {
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-02.ndjson");
  writeFileSync(marker, "{not json at all\n" + JSON.stringify({ artifact: { source: "PR #777002" } }) + "\n", "utf8");
  try {
    const r = fire({ tool_name: "Bash", tool_input: { command: "gh pr merge 777002" } });
    assert.equal(r.code, 0);
    assert.equal(r.notice.trim(), "", "the good line after the corrupt one must still be read");
  } finally {
    rmSync(marker, { force: true });
  }
});

test("a goal file already reviewed by ABSOLUTE path is matched by the ledger's RELATIVE one", () => {
  // The hook receives an absolute tool path while the ledger may record a repo-relative one.
  // A reviewed file must stay silent regardless of how its path was written.
  const { canonicalPath } = require("./tribunal-reminder.js");
  const abs = join(TEST_ROOT, "docs", "reference", "goals", "already.md");
  assert.equal(canonicalPath(abs, TEST_ROOT), canonicalPath("docs/reference/goals/already.md", TEST_ROOT));
  mkdirSync(dirname(abs), { recursive: true });
  const contents = "A reviewed goal.\n";
  writeFileSync(abs, contents);
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-03.ndjson");
  writeFileSync(marker, `${JSON.stringify({
    artifact: { kind: "document", source: "docs/reference/goals/already.md" },
    contentHash: createHash("sha256").update(contents).digest("hex"),
    decision: { action: "APPROVE", reason: "APPROVED" },
  })}\n`, "utf8");
  try {
    const r = fire({ tool_name: "Write", tool_input: { file_path: abs } });
    assert.equal(r.notice.trim(), "", "an already-reviewed goal must be silent even via an absolute path");
  } finally {
    rmSync(marker, { force: true });
  }
});

// Mutation M4A_DOCS_TAIL_CASE_FOLD: keep slicing at docs/ or fold case on every filesystem.
test("goal matching uses the consumer root and configured directory, with a directory boundary", () => {
  const { isGoalWrite, canonicalPath } = require("./tribunal-reminder.js");
  const root = "/work/docs/consumer";
  const goals = "/work/docs/consumer/planning/goals";
  assert.equal(isGoalWrite("planning/goals/x.md", root, goals, "linux"), true);
  assert.equal(isGoalWrite(`${goals}/nested/x.md`, root, goals, "linux"), true);
  for (const path of ["/other/planning/goals/x.md", "planning/goals-extra/x.md", "planning/goals/../x.md", "docs/reference/goals/x.md"]) {
    assert.equal(isGoalWrite(path, root, goals, "linux"), false, path);
  }
  assert.equal(canonicalPath(`${goals}/x.md`, root, "linux"), canonicalPath("planning/goals/x.md", root, "linux"));
  assert.notEqual(canonicalPath("/other/docs/consumer/planning/goals/x.md", root, "linux"), canonicalPath(`${goals}/x.md`, root, "linux"));
});

test("goal matching preserves case and literal backslashes on Linux and folds case on Windows and macOS", () => {
  const { isGoalWrite, canonicalPath } = require("./tribunal-reminder.js");
  assert.equal(isGoalWrite("Goals/a.md", "/repo", "/repo/goals", "linux"), false);
  assert.equal(isGoalWrite("goals\\a.md", "/repo", "/repo/goals", "linux"), false);
  assert.notEqual(canonicalPath("goals/A.md", "/repo", "linux"), canonicalPath("goals/a.md", "/repo", "linux"));
  assert.equal(isGoalWrite("GOALS/A.MD", "/repo", "/repo/goals", "darwin"), true);
  assert.equal(canonicalPath("goals/A.md", "/repo", "darwin"), canonicalPath("goals/a.md", "/repo", "darwin"));
  assert.equal(isGoalWrite("GOALS\\A.MD", "C:\\repo", "C:\\repo\\goals", "win32"), true);
  assert.equal(canonicalPath("GOALS\\A.MD", "C:\\repo", "win32"), canonicalPath("c:/repo/goals/a.md", "C:\\repo", "win32"));
});

// Mutation M4A_PAYLOAD_ROOT: select policy from payload.cwd or ignore CLAUDE_PROJECT_DIR.
test("the reminder resolves shared policy from CLAUDE_PROJECT_DIR and ignores payload cwd", () => {
  const consumer = mkdtempSync(join(TEST_ROOT, "consumer-"));
  mkdirSync(join(consumer, ".git"));
  writeFileSync(join(consumer, "tribunal.config.json"), JSON.stringify({ goalsDir: "plans", ledgerHome: "ledger" }));
  const options = { env: { ...process.env, CLAUDE_PROJECT_DIR: consumer } };
  const notice = fire({ cwd: TEST_ROOT, tool_name: "Write", tool_input: { file_path: "plans/new.md" } }, options);
  assert.match(notice.notice, /no recorded panel/);
  assert.equal(fire({ tool_name: "Write", tool_input: { file_path: "docs/reference/goals/new.md" } }, options).notice, "");
});

test("the reminder finds the consumer root from nested cwd when CLAUDE_PROJECT_DIR is unset", () => {
  const consumer = mkdtempSync(join(TEST_ROOT, "nested-consumer-"));
  const nested = join(consumer, "nested");
  mkdirSync(join(consumer, ".git"));
  mkdirSync(nested);
  writeFileSync(join(consumer, "tribunal.config.json"), JSON.stringify({ goalsDir: "plans", ledgerHome: "ledger" }));
  const notice = fire({ cwd: TEST_ROOT, tool_name: "Write", tool_input: { file_path: "plans/new.md" } }, { cwd: nested });
  assert.match(notice.notice, /no recorded panel/);
});

test("a goal-shaped path outside the consumer tree never triggers the reminder", () => {
  const outside = resolve(TEST_ROOT, "..", "other-consumer", "docs", "reference", "goals", "x.md");
  assert.equal(fire({ tool_name: "Write", tool_input: { file_path: outside } }).notice, "");
  assert.equal(fire({ tool_name: "Write", tool_input: { file_path: "nested/docs/reference/goals/x.md" } }).notice, "");
});

// Mutation M4A_EVER_ATTEMPTED: accept any source row regardless of completeness/current bytes.
test("only a complete document round at the goal's current content suppresses the reminder", () => {
  const relative = "docs/reference/goals/current-content.md";
  const goal = join(TEST_ROOT, relative);
  mkdirSync(dirname(goal), { recursive: true });
  const contents = "The CURRENT goal, including its newline.\r\n";
  writeFileSync(goal, contents);
  const contentHash = createHash("sha256").update(contents).digest("hex");
  const complete = { artifact: { kind: "document", source: relative }, contentHash, decision: { action: "APPROVE", reason: "APPROVED" } };
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-04.ndjson");
  try {
    for (const row of [
      { ...complete, decision: undefined },
      { ...complete, decision: { reason: "APPROVED" } },
      { ...complete, decision: { action: "ESCALATE", reason: "PARTIAL" } },
      { ...complete, contentHash: createHash("sha256").update("old goal").digest("hex") },
      { ...complete, artifact: { kind: "pull-request", source: relative } },
    ]) {
      writeFileSync(marker, `${JSON.stringify(row)}\n`);
      assert.match(fire({ tool_name: "Edit", tool_input: { file_path: goal } }).notice, /no recorded panel/, JSON.stringify(row));
    }
    writeFileSync(marker, `${JSON.stringify(complete)}\n`);
    assert.equal(fire({ tool_name: "Edit", tool_input: { file_path: goal } }).notice, "");
    writeFileSync(goal, `${contents}Changed after review.\n`);
    assert.match(fire({ tool_name: "Edit", tool_input: { file_path: goal } }).notice, /no recorded panel/);
  } finally { rmSync(marker, { force: true }); }
});

test("a complete current-content review matches the wall even if its source path changed", () => {
  const relative = "docs/reference/goals/renamed.md";
  const goal = join(TEST_ROOT, relative);
  mkdirSync(dirname(goal), { recursive: true });
  writeFileSync(goal, "Unchanged reviewed contents\n");
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-05.ndjson");
  writeFileSync(marker, `${JSON.stringify({
    artifact: { kind: "document", source: "old/location.md" },
    contentHash: createHash("sha256").update("Unchanged reviewed contents\n").digest("hex"),
    decision: { action: "ESCALATE", reason: "NO_CONSENSUS" },
  })}\n`);
  try { assert.equal(fire({ tool_name: "Edit", tool_input: { file_path: goal } }).notice, ""); }
  finally { rmSync(marker, { force: true }); }
});

test("canonicalPath does not collapse two DIFFERENT goal files into one", () => {
  const { canonicalPath } = require("./tribunal-reminder.js");
  assert.notEqual(canonicalPath("docs/reference/goals/a.md"), canonicalPath("docs/reference/goals/b.md"));
});

test("garbage on stdin exits 0 and says nothing", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8", cwd: TEST_ROOT });
  assert.equal(r.status, 0);
  assert.equal((r.stderr || "").trim(), "");
});

test("empty stdin exits 0", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: "", encoding: "utf8", cwd: TEST_ROOT });
  assert.equal(r.status, 0);
});

test("NEGATIVE CONTROL: a do-nothing hook fails the assertions above", () => {
  // Every silence test would also pass against a hook that does nothing. Positive notice
  // assertions must distinguish the real reminder from this do-nothing hook.
  const dir = mkdtempSync(join(TEST_ROOT, "noop-hook-"));
  const noop = join(dir, "noop.js");
  writeFileSync(noop, "process.exit(0);\n", "utf8");
  try {
    const r = spawnSync(process.execPath, [noop], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 999123" } }),
      encoding: "utf8",
      cwd: TEST_ROOT,
    });
    assert.equal((r.stderr || "").trim(), "", "the no-op is silent, as expected");
    assert.doesNotMatch(r.stderr || "", /no recorded local panel/, "so the positive tests above are measuring the real hook");
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(TEST_ROOT) + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QUOTING the command is not RUNNING it", () => {
  // A commit message, echo, or search may quote a merge command without running it.
  // Such prose must not produce a spurious reminder.
  for (const cmd of [
    'git commit -m "see gh pr merge 137 for context"',
    'echo "gh pr merge 42"',
    "grep -n 'gh pr merge' README.md",
  ]) {
    const r = fire({ tool_name: "Bash", tool_input: { command: cmd } });
    assert.equal(r.notice.trim(), "", `should be silent for: ${cmd}`);
  }
});
