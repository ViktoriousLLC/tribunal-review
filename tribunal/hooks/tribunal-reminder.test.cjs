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
// Two counted legs that answered and parsed: the floor a ledger row needs to count as a review.
const TWO_LEGS = [{ leg: "a", model: "m-a", answered: true, kind: "answered", parseFailed: false }, { leg: "b", model: "m-b", answered: true, kind: "answered", parseFailed: false }];
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
  writeFileSync(marker, `${JSON.stringify({ artifact: { kind: "diff", source: "PR #777003" }, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS })}\n`);
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

test("a merge that names no PR number blocks as UNVERIFIED and asks for the number (v0.10.2)", () => {
  // It used to pass silently, on the theory that a reminder it cannot satisfy is noise. The
  // break-it pass showed that is the most common merge an agent types, so it was the widest
  // silent hole. Naming the number satisfies it, so the block is never unsatisfiable.
  const { prFromMergeCommand, mergesInCommand } = require("./tribunal-reminder.js");
  assert.equal(prFromMergeCommand("gh pr merge --squash"), null);
  for (const [command, tool] of [
    ["gh pr merge --squash --delete-branch", "Bash"],
    ["PR=7; gh pr merge $PR --squash", "Bash"],
    ["for pr in 7 8; do gh pr merge $pr; done", "Bash"],
    ["$pr = 7; gh pr merge $pr --squash", "PowerShell"],
    ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'", "Bash"],
  ]) {
    assert.equal(mergesInCommand(command, tool === "PowerShell" ? "powershell" : "bash").unnumbered, 1, command);
    const r = fire({ session_id: `unnumbered-${command}`, tool_name: tool, tool_input: { command } });
    assert.equal(r.code, 2, command);
    assert.match(r.err, /names no PR number/, command);
    assert.match(r.err, /Block 1 of 3 for unnumbered merges/, command);
  }
  const brake = (n) => fire({ session_id: "unnumbered-brake", tool_name: "Bash", tool_input: { command: "gh pr merge --squash" } });
  for (let i = 1; i <= 3; i += 1) assert.equal(brake(i).code, 2);
  const fourth = brake(4);
  assert.equal(fourth.code, 0);
  assert.match(fourth.notice, /STAND-DOWN.*A merge with no PR number proceeds UNREVIEWED/s);
});

test("repository flag values and branch names ending in digits do not identify a PR", () => {
  const { prFromMergeCommand, mergesInCommand } = require("./tribunal-reminder.js");
  for (const command of [
    "gh pr merge --body draft --repo owner/repo123",
    "gh pr merge -R owner/repo123",
    "gh pr merge feature-123",
  ]) {
    assert.equal(prFromMergeCommand(command), null, command);
    assert.equal(mergesInCommand(command).unnumbered, 1, `${command} is a merge, just not a numbered one`);
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
  writeFileSync(marker, JSON.stringify({ artifact: { kind: "diff", source: "PR #777001" }, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS }) + "\n", "utf8");
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
  writeFileSync(marker, "{not json at all\n" + JSON.stringify({ artifact: { kind: "diff", source: "PR #777002" }, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS }) + "\n", "utf8");
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
    legs: TWO_LEGS,
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
  const complete = { artifact: { kind: "document", source: relative }, contentHash, decision: { action: "APPROVE", reason: "APPROVED" }, legs: TWO_LEGS };
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
    legs: TWO_LEGS,
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

test("a PARTIAL round, or a row with no decision, does not unlock the merge", () => {
  // Every leg failed: the runner banks a PARTIAL row. That records an attempt, not a review.
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-07.ndjson");
  writeFileSync(marker, [
    { artifact: { kind: "diff", source: "PR #777010" }, decision: { action: "STOP", reason: "PARTIAL" } },
    { artifact: { kind: "diff", source: "PR #777011" } },
    { artifact: { kind: "document", source: "PR #777012" }, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS },
    { artifact: { kind: "diff", source: "PR #777013" }, decision: { action: "CONTINUE", reason: "ACTIONABLE" }, legs: TWO_LEGS },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    for (const pr of ["777010", "777011", "777012"]) {
      const r = fire({ session_id: `partial-${pr}`, tool_name: "Bash", tool_input: { command: `gh pr merge ${pr}` } });
      assert.equal(r.code, 2, `PR #${pr} must still block`);
      assert.match(r.err, new RegExp(`PR #${pr} has no recorded local panel`));
    }
    const complete = fire({ session_id: "partial-complete", tool_name: "Bash", tool_input: { command: "gh pr merge 777013" } });
    assert.equal(complete.code, 0, "a complete round with findings is a recorded panel");
  } finally { rmSync(marker, { force: true }); }
});

test("a merge on its own LINE, after a line continuation, or inside a subshell is caught", () => {
  for (const cmd of [
    "git push\ngh pr merge 7 --squash",
    "git push\r\ngh pr merge 7",
    "gh pr merge \\\n  7 --squash",
    "(gh pr merge 7)",
    "{ gh pr merge 7; }",
    "git push & gh pr merge 7",
    'out="$(gh pr merge 7)"',
    "out=`gh pr merge 7`",
    "GH_TOKEN=x gh pr merge 7",
    "env GH_TOKEN=x gh pr merge 7",
    "/usr/bin/gh pr merge 7",
    "gh.exe pr merge 7",
    'gh pr merge "7"',
    "cat <<'EOF' > notes.txt\nbody\nEOF\ngh pr merge 7",
  ]) {
    const r = fire({ session_id: `multiline-${cmd}`, tool_name: "Bash", tool_input: { command: cmd } });
    assert.equal(r.code, 2, `missed the merge in: ${JSON.stringify(cmd)}`);
    assert.match(r.err, /PR #7 /, `missed the merge in: ${JSON.stringify(cmd)}`);
  }
});

test("a separator inside quotes, or a heredoc body, is still prose", () => {
  for (const cmd of [
    'git commit -m "first; gh pr merge 137"',
    "git commit -m 'subject\ngh pr merge 137'",
    'git commit -m "subject\ngh pr merge 137"',
    "git commit -F - <<'EOF'\nsubject\ngh pr merge 137\nEOF",
    "cat <<-EOF >> notes.txt\n\tgh pr merge 137\n\tEOF\necho done",
  ]) {
    const r = fire({ tool_name: "Bash", tool_input: { command: cmd } });
    assert.equal(r.code, 0, `should not block: ${JSON.stringify(cmd)}`);
    assert.equal(r.notice.trim(), "", `should be silent for: ${JSON.stringify(cmd)}`);
  }
});

test("a merge typed in the PowerShell tool meets the same gate", () => {
  const r = fire({ session_id: "powershell", tool_name: "PowerShell", tool_input: { command: "git push; gh pr merge 7 --squash" } });
  assert.equal(r.code, 2);
  assert.match(r.err, /PR #7 has no recorded local panel/);
  const hooks = JSON.parse(readFileSync(join(__dirname, "hooks.json"), "utf8")).hooks;
  assert.ok(hooks.PreToolUse.some((h) => h.matcher.split("|").includes("PowerShell")), "hooks.json must route the PowerShell tool to the gate");
});

test("a ledger read that runs out of the hook's own budget BLOCKS as UNVERIFIED, through the brake", () => {
  const merge = () => fire({ session_id: "budget", tool_name: "Bash", tool_input: { command: "gh pr merge 777020" } },
    { env: { ...process.env, CLAUDE_PROJECT_DIR: "", TRIBUNAL_ALLOW_UNREVIEWED_MERGE: "", TRIBUNAL_HOOK_BUDGET_MS: "0" } });
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-08.ndjson");
  writeFileSync(marker, `${JSON.stringify({ artifact: { kind: "diff", source: "PR #777020" }, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS })}\n`);
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const r = merge();
      assert.equal(r.code, 2, "a killed hook would let the merge through; an out-of-time hook must block");
      assert.match(r.err, /BLOCKED, UNVERIFIED: the ledger could not be read within/);
    }
    const fourth = merge();
    assert.equal(fourth.code, 0, "the brake still bounds it");
    assert.match(fourth.notice, /STAND-DOWN/);
  } finally { rmSync(marker, { force: true }); }
});

test("every hook's timeout leaves room for its own 40 second budget", () => {
  const hooks = JSON.parse(readFileSync(join(__dirname, "hooks.json"), "utf8")).hooks;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) for (const h of group.hooks) assert.ok(h.timeout >= 60, `${event} timeout ${h.timeout}s is under 60s`);
  }
});

test("panel round 1: substitutions inside double quotes and unquoted heredocs are commands", () => {
  const { prsFromMergeCommand } = require("./tribunal-reminder.js");
  assert.deepEqual(prsFromMergeCommand('out="$(gh pr merge 7; echo done)"'), ["7"]);
  assert.deepEqual(prsFromMergeCommand('out="$( (true) ; gh pr merge 7 )" && echo "$out"'), ["7"]);
  assert.deepEqual(prsFromMergeCommand("cat <<EOF\n$(gh pr merge 7)\nEOF"), ["7"]);
  assert.deepEqual(prsFromMergeCommand("cat <<EOF\nx `gh pr merge 7` y\nEOF"), ["7"]);
  // A quoted delimiter turns substitution off: the body is prose.
  assert.deepEqual(prsFromMergeCommand("cat <<'EOF'\n$(gh pr merge 7)\nEOF"), []);
  assert.deepEqual(prsFromMergeCommand('cat <<"EOF"\n$(gh pr merge 7)\nEOF'), []);
  // The quote resumes after the substitution closes.
  assert.deepEqual(prsFromMergeCommand('echo "$(date); gh pr merge 7"'), []);
});

test("panel round 1: PowerShell's escape is the backtick, not the backslash", () => {
  const { prsFromMergeCommand } = require("./tribunal-reminder.js");
  const tick = String.fromCharCode(96);
  assert.deepEqual(prsFromMergeCommand(`gh pr merge ${tick}\n7 --squash`, "powershell"), ["7"]);
  assert.deepEqual(prsFromMergeCommand("Write-Output x \\; gh pr merge 7", "powershell"), ["7"]);
  assert.deepEqual(prsFromMergeCommand(`git commit -m "note: ${tick}gh pr merge 7${tick} needs review"`, "powershell"), []);
  const r = fire({ session_id: "ps-continuation", tool_name: "PowerShell", tool_input: { command: `gh pr merge ${tick}\n7` } });
  assert.equal(r.code, 2);
  assert.match(r.err, /PR #7 has no recorded local panel/);
});

test("panel round 1: an empty or malformed budget keeps the default", () => {
  const { hookBudgetMs } = require("./tribunal-reminder.js");
  for (const raw of [undefined, "", "40s", "-5", "abc"]) assert.equal(hookBudgetMs(raw), 40_000, String(raw));
  assert.equal(hookBudgetMs("0"), 0);
  assert.equal(hookBudgetMs("999999"), 40_000, "never longer than the timeout allows");
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-09.ndjson");
  writeFileSync(marker, `${JSON.stringify({ artifact: { kind: "diff", source: "PR #777030" }, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS })}\n`);
  try {
    const r = fire({ tool_name: "Bash", tool_input: { command: "gh pr merge 777030" } },
      { env: { ...process.env, CLAUDE_PROJECT_DIR: "", TRIBUNAL_ALLOW_UNREVIEWED_MERGE: "", TRIBUNAL_HOOK_BUDGET_MS: "" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, "");
  } finally { rmSync(marker, { force: true }); }
});

test("panel round 1: a goal-write reminder that runs out of budget says UNVERIFIED and never crashes", () => {
  const goal = join(TEST_ROOT, "docs", "reference", "goals", "budget.md");
  mkdirSync(dirname(goal), { recursive: true });
  writeFileSync(goal, "# a goal\n");
  mkdirSync(LEDGER, { recursive: true });
  writeFileSync(join(LEDGER, "2026-01.ndjson"), "\n");
  try {
    const r = fire({ tool_name: "Write", tool_input: { file_path: goal } },
      { env: { ...process.env, CLAUDE_PROJECT_DIR: "", TRIBUNAL_ALLOW_UNREVIEWED_MERGE: "", TRIBUNAL_HOOK_BUDGET_MS: "0" } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.notice, /no recorded panel for this content \(UNVERIFIED: /);
  } finally { rmSync(goal, { force: true }); rmSync(join(LEDGER, "2026-01.ndjson"), { force: true }); }
});

test("panel round 2: prose after a substitution, heredoc prose and comments never start a merge", () => {
  const { prsFromMergeCommand } = require("./tribunal-reminder.js");
  for (const cmd of [
    'echo "$(date) gh pr merge 7"',
    'git commit -m "$(cat notes.txt) gh pr merge 7"',
    "cat <<EOF > notes.md\n$(date)\ngh pr merge 7 is next\nEOF",
    "cat <<EOF\nx `date` gh pr merge 7\nEOF",
    "echo ok # note; gh pr merge 7",
  ]) assert.deepEqual(prsFromMergeCommand(cmd), [], JSON.stringify(cmd));
  assert.deepEqual(prsFromMergeCommand("Write-Output ok # note; gh pr merge 7", "powershell"), []);
});

test("panel round 2: a comment, a split word, a keyword or a quoted path cannot hide a merge", () => {
  const { prsFromMergeCommand } = require("./tribunal-reminder.js");
  const backslashNewline = String.fromCharCode(92, 10);
  for (const cmd of [
    "# don't forget review\ngh pr merge 7",
    `gh pr mer${backslashNewline}ge 7`,
    "if gh pr merge 7; then :; fi",
    "! gh pr merge 7",
    "exec gh pr merge 7",
    "timeout 60 gh pr merge 7",
    '"/usr/local/bin/gh" pr merge 7',
    "cat <<EOF\n$(date) and $(gh pr merge 7)\nEOF",
  ]) assert.deepEqual(prsFromMergeCommand(cmd), ["7"], JSON.stringify(cmd));
  assert.deepEqual(prsFromMergeCommand('& "C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 7', "powershell"), ["7"]);
});

test("panel round 3: substitution output, here-strings, quoted values and wrapper options", () => {
  const { prsFromMergeCommand } = require("./tribunal-reminder.js");
  for (const cmd of [
    "echo $(date) gh pr merge 7",
    'echo "$(date) see /usr/bin/gh pr merge 7"',
    "cat <<EOF\n$(date)\n/usr/bin/gh pr merge 7\nEOF",
  ]) assert.deepEqual(prsFromMergeCommand(cmd), [], JSON.stringify(cmd));
  for (const cmd of [
    "cat <<<hello\ngh pr merge 7",
    "SHA=$(git rev-parse HEAD) gh pr merge 7",
    'NOTE="value with spaces" gh pr merge 7',
    '"gh" pr merge 7',
    "env -i gh pr merge 7",
    "sudo -n gh pr merge 7",
    "timeout --preserve-status 60 gh pr merge 7",
  ]) assert.deepEqual(prsFromMergeCommand(cmd), ["7"], JSON.stringify(cmd));
  assert.deepEqual(prsFromMergeCommand('& "gh" pr merge 7', "powershell"), ["7"]);
  // A number inside a quoted flag value is not a PR.
  assert.deepEqual(prsFromMergeCommand('gh pr merge 7 --body "fixes 123"'), ["7"]);
  assert.deepEqual(prsFromMergeCommand('gh pr merge --squash --body "fixes 123" 7'), ["7"]);
});

test("panel round 4: every word of a quoted flag value stays in the value", () => {
  const { prsFromMergeCommand } = require("./tribunal-reminder.js");
  assert.deepEqual(prsFromMergeCommand('gh pr merge --body "fixes 123 issues" 7'), ["7"]);
  assert.deepEqual(prsFromMergeCommand("gh pr merge -t 'closes 55 and 66' 7 --squash"), ["7"]);
});

test("source pin: the runner banks a PR round as kind diff with source PR #<n>, the shape the gate reads", () => {
  // The gate's fixtures are hand-written, so pin them to the producer: if artifact.mjs ever
  // banks PR rounds differently, every reviewed PR would block and this test must fail first.
  const producer = readFileSync(join(__dirname, "..", "scripts", "artifact.mjs"), "utf8");
  assert.match(producer, /kind: "diff",\s*\n\s*source: `PR #\$\{prNumber\}`/);
  const runner = readFileSync(join(__dirname, "..", "scripts", "run.mjs"), "utf8");
  assert.match(runner, /decision: \{ action: decision\.action, reason: decision\.reason \}/);
  assert.match(runner, /action: "STOP", reason: "PARTIAL"/);
});

test("break-it pass (v0.10.2): realistic shapes that slipped through are now merges", () => {
  const { prsFromMergeCommand } = require("./tribunal-reminder.js");
  const bash = [
    "gh -R owner/repo pr merge 7 --squash",
    "gh --repo owner/repo pr merge 7",
    "GH pr merge 7",
    "2>/dev/null gh pr merge 7 --squash",
    "nice gh pr merge 7",
    "winpty gh pr merge 7",
    "npx gh pr merge 7",
    "gh pr merge https://github.com/o/r/pull/7/files",
    "gh pr merge https://github.com/o/r/pull/7/",
    "gh pr merge https://github.com/o/r/pull/7#issuecomment-1",
    "gh pr merge '#7'",
    "gh api -X PUT repos/o/r/pulls/7/merge -f merge_method=squash",
    "n=${#PRS[@]}; gh pr merge 7",
  ];
  for (const cmd of bash) assert.deepEqual(prsFromMergeCommand(cmd), ["7"], JSON.stringify(cmd));
  const tick = String.fromCharCode(96);
  const powershell = [
    "$out = gh pr merge 7 --squash",
    "$r = gh pr merge 7 --squash --delete-branch 2>&1; $r",
    "cmd /c gh pr merge 7",
    "gh pr review 7 --comment --body @'\nLooks good, it's ready.\n'@\ngh pr merge 7 --squash --delete-branch",
    'gh pr review 7 --body @"\nOne stray " quote.\n"@\ngh pr merge 7',
    "<# merge now #> gh pr merge 7",
    `gh pr merge ${tick}\n7`,
  ];
  for (const cmd of powershell) assert.deepEqual(prsFromMergeCommand(cmd, "powershell"), ["7"], JSON.stringify(cmd));
  // A here-string is still prose: a merge quoted inside one is not run.
  assert.deepEqual(prsFromMergeCommand("git commit -m @'\ngh pr merge 9\n'@", "powershell"), []);
  // And a double-quoted one still runs its substitutions.
  assert.deepEqual(prsFromMergeCommand('Write-Output @"\n$(gh pr merge 9)\n"@', "powershell"), ["9"]);
});

test("v0.10.2 panel: flag forms, spaced redirection, nice -n, quoted cmd /c, and reads that are not merges", () => {
  const { prsFromMergeCommand, mergesInCommand } = require("./tribunal-reminder.js");
  for (const cmd of [
    "gh --repo=owner/repo pr merge 7 --squash",
    "gh -Rowner/repo pr merge 7",
    "2> /dev/null gh pr merge 7",
    "nice -n 10 gh pr merge 7",
    "gh pr merge --body-file msg.txt 7",
    "gh pr merge -F msg.txt 7",
    "gh api --method PUT repos/o/r/pulls/7/merge",
  ]) assert.deepEqual(prsFromMergeCommand(cmd), ["7"], JSON.stringify(cmd));
  assert.deepEqual(prsFromMergeCommand('cmd /c "gh pr merge 7"', "powershell"), ["7"]);
  assert.equal(mergesInCommand("gh api -X POST graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'").unnumbered, 1);
  // The REST "is it merged?" check is a GET: not a merge, no block, no brake spent.
  for (const cmd of ["gh api repos/o/r/pulls/7/merge", "gh api -X GET repos/o/r/pulls/7/merge"]) {
    assert.deepEqual(mergesInCommand(cmd), { prs: [], unnumbered: 0 }, cmd);
  }
});

test("v0.10.2 panel round 7: API merges in any arrangement; help merges nothing", () => {
  const { mergesInCommand } = require("./tribunal-reminder.js");
  assert.deepEqual(mergesInCommand("PR=7; gh api -X PUT repos/o/r/pulls/$PR/merge"), { prs: [], unnumbered: 1 });
  assert.deepEqual(mergesInCommand("gh api -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }' graphql"), { prs: [], unnumbered: 1 });
  assert.deepEqual(mergesInCommand("gh api -X PUT -f commit_message='first line\nsecond line' repos/o/r/pulls/7/merge"), { prs: ["7"], unnumbered: 0 });
  for (const cmd of ["gh pr merge --help", "gh pr merge -h"]) assert.deepEqual(mergesInCommand(cmd), { prs: [], unnumbered: 0 }, cmd);
});

test("v0.10.2 panel round 8: quoted text never decides the PR or hides the merge", () => {
  const { mergesInCommand } = require("./tribunal-reminder.js");
  assert.deepEqual(mergesInCommand('gh pr merge 7 --squash --body "Document --help usage"'), { prs: ["7"], unnumbered: 0 });
  assert.deepEqual(mergesInCommand("gh api -X PUT -f commit_message='Follow up pulls/7/merge' repos/o/r/pulls/8/merge"), { prs: ["8"], unnumbered: 0 });
  assert.deepEqual(mergesInCommand('NOTE="see gh pr merge 9" gh pr merge 7'), { prs: ["7"], unnumbered: 0 });
  // A pathological prefix must not make the parser slow (the hook has a budget, and a kill is a pass).
  const started = Date.now();
  mergesInCommand(`${">".repeat(5000)} ${"timeout -x ".repeat(2000)}x`);
  // This 25,000-character input takes about 1.5s on a dev laptop, so a 2s bound was flaky under
  // a loaded test run. Catastrophic backtracking takes minutes; 10s still catches it, well
  // inside the 40s hook budget.
  assert.ok(Date.now() - started < 10000, `parse took ${Date.now() - started}ms`);
});

test("v0.10.2 panel round 9: quoted REST endpoints, field values, help as a value, and no regex blow-up", () => {
  const { mergesInCommand } = require("./tribunal-reminder.js");
  assert.deepEqual(mergesInCommand('gh api -X PUT "repos/o/r/pulls/7/merge"'), { prs: ["7"], unnumbered: 0 });
  assert.deepEqual(mergesInCommand("gh api -X PUT 'repos/$OWNER/$REPO/pulls/7/merge'"), { prs: ["7"], unnumbered: 0 });
  assert.deepEqual(mergesInCommand("gh api -X PUT -f note=pulls/8/merge repos/o/r/pulls/7/merge"), { prs: ["7"], unnumbered: 0 });
  assert.deepEqual(mergesInCommand("gh pr merge 7 --squash --body --help"), { prs: ["7"], unnumbered: 0 });
  assert.deepEqual(mergesInCommand("gh pr merge 7 -t --help"), { prs: ["7"], unnumbered: 0 });
  assert.deepEqual(mergesInCommand("gh pr merge --help"), { prs: [], unnumbered: 0 });
  const started = Date.now();
  mergesInCommand(`nice${" -n -1".repeat(40)} x`);
  assert.ok(Date.now() - started < 2000, `parse took ${Date.now() - started}ms`);
});

test("v0.10.2 panel round 10: REST methods and endpoints the parser cannot pin are unnumbered, reads stay reads", () => {
  const { mergesInCommand } = require("./tribunal-reminder.js");
  assert.deepEqual(mergesInCommand("gh api -X PUT 'repos/o/r/pulls/7/merge?merge_method=squash'"), { prs: ["7"], unnumbered: 0 });
  assert.deepEqual(mergesInCommand('METHOD=PUT; gh api --method "$METHOD" repos/o/r/pulls/7/merge'), { prs: ["7"], unnumbered: 0 });
  assert.deepEqual(mergesInCommand('URL=repos/o/r/pulls/7/merge; gh api -X PUT "$URL"'), { prs: [], unnumbered: 1 });
  assert.deepEqual(mergesInCommand("gh api -X PUT repos/o/r/pulls/$PR/merge"), { prs: [], unnumbered: 1 });
  assert.deepEqual(mergesInCommand("gh api repos/o/r/pulls/7/merge -f merge_method=squash"), { prs: ["7"], unnumbered: 0 }, "fields make it a write");
  for (const cmd of ["gh api repos/o/r/pulls/7/merge", "gh api -X GET repos/o/r/pulls/7/merge", 'gh api -X PATCH repos/o/r/issues/1 -f body="merge later"']) {
    assert.deepEqual(mergesInCommand(cmd), { prs: [], unnumbered: 0 }, cmd);
  }
});

test("v0.10.3: one model, an UNREADABLE round, or legs that did not parse does not unlock the merge", () => {
  const one = [{ leg: "a", model: "m-a", answered: true, kind: "answered", parseFailed: false }];
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-10.ndjson");
  writeFileSync(marker, [
    { artifact: { kind: "diff", source: "PR #777040" }, decision: { action: "STOP", reason: "QUIET" }, legs: one },
    { artifact: { kind: "diff", source: "PR #777041" }, decision: { action: "STOP", reason: "UNREADABLE" }, legs: TWO_LEGS },
    { artifact: { kind: "diff", source: "PR #777042" }, decision: { action: "STOP", reason: "QUIET" }, legs: [...one, { leg: "b", model: "m-b", answered: true, kind: "answered", parseFailed: true }] },
    { artifact: { kind: "diff", source: "PR #777043" }, decision: { action: "STOP", reason: "QUIET" }, legs: [...one, { leg: "b", answered: false, kind: "failed" }] },
    { artifact: { kind: "diff", source: "PR #777044" }, decision: { action: "STOP", reason: "QUIET" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    for (const pr of ["777040", "777041", "777042", "777043", "777044"]) {
      const r = fire({ session_id: `floor-${pr}`, tool_name: "Bash", tool_input: { command: `gh pr merge ${pr}` } });
      assert.equal(r.code, 2, `PR #${pr} must still block`);
    }
  } finally { rmSync(marker, { force: true }); }
});

test("v0.10.3: a merge whose latest complete round still had findings proceeds with a visible warning", () => {
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-11.ndjson");
  const row = (pr, ts, action, reason, actionable, round) =>
    ({ ts, round, artifact: { kind: "diff", source: `PR #${pr}` }, decision: { action, reason }, actionable, legs: TWO_LEGS });
  writeFileSync(marker, [
    row("777050", "2026-10-18T01:00:00Z", "CONTINUE", "ACTIONABLE", 3, 4),
    row("777051", "2026-10-18T01:00:00Z", "CONTINUE", "ACTIONABLE", 2, 1),
    row("777051", "2026-10-18T02:00:00Z", "STOP", "QUIET", 0, 2),
    row("777052", "2026-10-18T02:00:00Z", "CONTINUE", "ACTIONABLE", 1, 3),
    row("777052", "2026-10-18T01:00:00Z", "STOP", "QUIET", 0, 2),
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  try {
    const warned = fire({ session_id: "warn-1", tool_name: "Bash", tool_input: { command: "gh pr merge 777050" } });
    assert.equal(warned.code, 0);
    assert.match(warned.notice, /PR #777050: the latest review round \(round 4\) still had 3 actionable finding\(s\)/);
    const quiet = fire({ session_id: "warn-2", tool_name: "Bash", tool_input: { command: "gh pr merge 777051" } });
    assert.equal(quiet.code, 0);
    assert.equal(quiet.notice, "", "a later quiet round clears the warning");
    const order = fire({ session_id: "warn-3", tool_name: "Bash", tool_input: { command: "gh pr merge 777052" } });
    assert.equal(order.code, 0);
    assert.match(order.notice, /round 3\) still had 1 actionable/, "the LATEST round decides, not the file order");
  } finally { rmSync(marker, { force: true }); }
});

test("v0.10.3 panel round 11: two seats on one model, an unknown leg kind, and a count-less ACTIONABLE verdict", () => {
  const leg = (name, model, kind = "answered") => ({ leg: name, model, answered: true, kind, parseFailed: false });
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-12.ndjson");
  writeFileSync(marker, [
    { artifact: { kind: "diff", source: "PR #777060" }, decision: { action: "STOP", reason: "QUIET" }, legs: [leg("opus", "m1"), leg("fable", "m1")] },
    { artifact: { kind: "diff", source: "PR #777061" }, decision: { action: "STOP", reason: "QUIET" }, legs: [leg("opus", "m1"), leg("x", "m2", "cached")] },
    { artifact: { kind: "diff", source: "PR #777062" }, decision: { action: "STOP", reason: "QUIET" }, legs: [leg("opus", "m1"), leg("opus", "m1")] },
    { artifact: { kind: "diff", source: "PR #777063" }, runnerRound: 5, decision: { action: "CONTINUE", reason: "ACTIONABLE" }, legs: [leg("opus", "m1"), leg("sol", "m2")] },
    { artifact: { kind: "diff", source: "PR #777064" }, runnerRound: 2, actionable: 0, decision: { action: "REDO", reason: "FIX_DID_NOT_LAND" }, legs: [leg("opus", "m1"), leg("sol", "m2")] },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    for (const pr of ["777060", "777061", "777062"]) {
      const r = fire({ session_id: `distinct-${pr}`, tool_name: "Bash", tool_input: { command: `gh pr merge ${pr}` } });
      assert.equal(r.code, 2, `PR #${pr} must still block`);
    }
    const r = fire({ session_id: "distinct-777063", tool_name: "Bash", tool_input: { command: "gh pr merge 777063" } });
    assert.equal(r.code, 0);
    assert.match(r.notice, /PR #777063: the latest review round \(round 5\) ended CONTINUE\/ACTIONABLE, not QUIET/);
    const redo = fire({ session_id: "distinct-777064", tool_name: "Bash", tool_input: { command: "gh pr merge 777064" } });
    assert.equal(redo.code, 0);
    assert.match(redo.notice, /PR #777064: .*ended REDO\/FIX_DID_NOT_LAND, not QUIET/, "a fix that did not land is not a quiet round");
  } finally { rmSync(marker, { force: true }); }
});

test("v0.10.3 break-it: a NEWER incomplete round with findings is shown, not hidden behind an older quiet one", () => {
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-13.ndjson");
  const one = [{ leg: "a", model: "m1", answered: true, kind: "answered", parseFailed: false }];
  writeFileSync(marker, [
    { ts: "2026-10-18T01:00:00Z", runnerRound: 1, artifact: { kind: "diff", source: "PR #777070" }, actionable: 0, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS },
    { ts: "2026-10-18T02:00:00Z", runnerRound: 2, artifact: { kind: "diff", source: "PR #777070" }, actionable: 4, decision: { action: "STOP", reason: "PARTIAL" }, legs: one },
    { ts: "2026-10-18T01:00:00Z", runnerRound: 1, artifact: { kind: "diff", source: "PR #777071" }, actionable: 0, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS },
    { ts: "2026-10-18T02:00:00Z", runnerRound: 2, artifact: { kind: "diff", source: "PR #777071" }, actionable: 0, decision: { action: "STOP", reason: "PARTIAL" }, legs: one },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    const shown = fire({ session_id: "newer-1", tool_name: "Bash", tool_input: { command: "gh pr merge 777070" } });
    assert.equal(shown.code, 0, "an incomplete round never blocks a PR that has a complete one");
    assert.match(shown.notice, /PR #777070: a NEWER round \(round 2\) was incomplete \(STOP\/PARTIAL\) and found 4 actionable/);
    const clean = fire({ session_id: "newer-2", tool_name: "Bash", tool_input: { command: "gh pr merge 777071" } });
    assert.equal(clean.notice, "", "a newer incomplete round with nothing actionable adds no notice");
  } finally { rmSync(marker, { force: true }); }
});

test("v0.10.3 panel round 12: no model named, a half-written newer row, any non-QUIET verdict warns, and both hooks count alike", () => {
  const gw = require("./goal-wall.js");
  const { readLegs, MIN_REVIEW_LEGS } = require("./tribunal-reminder.js");
  const leg = (o) => ({ leg: "x", model: "m1", answered: true, kind: "answered", parseFailed: false, ...o });
  const shapes = [
    [leg({ leg: "a", model: undefined }), leg({ leg: "b", model: undefined })],
    [leg({ model: " m1 " }), leg({ model: "m1" })],
    [leg({ model: "m1" }), leg({ model: "m2" })],
    [leg({ model: "m1" }), leg({ model: "m2", kind: "cached" })],
    [leg({ model: "m1" }), leg({ model: "m2", answered: false })],
    [leg({ model: "m1" }), leg({ model: "m2", parseFailed: true })],
    [leg({ model: "m1" }), leg({ model: "" })],
  ];
  assert.deepEqual(shapes.map((legs) => readLegs({ legs })), [0, 1, 2, 1, 1, 1, 1]);
  assert.deepEqual(shapes.map((legs) => gw.readLegs({ legs })), shapes.map((legs) => readLegs({ legs })), "the goal wall counts legs exactly as the merge gate");
  assert.equal(gw.MIN_REVIEW_LEGS, MIN_REVIEW_LEGS);
  // The runner banks the fields the floor and the warning read.
  const runner = readFileSync(join(__dirname, "..", "scripts", "run.mjs"), "utf8");
  assert.match(runner, /actionable: summary\.actionableCount,/);
  assert.match(runner, /legs: results\.map\(\(r\) => \(\{ leg: r\.leg, model: r\.model, answered: r\.answered, error: r\.error,\s+kind: r\.kind, reason: r\.reason, parseFailed: r\.parseFailed,/);
  const { completeRound } = require("./tribunal-reminder.js");
  const rows = [];
  for (const decision of [undefined, {}, { action: "STOP", reason: "QUIET" }, { action: "STOP", reason: "PARTIAL" }, { action: "STOP", reason: "UNREADABLE" }, { action: "CONTINUE", reason: "ACTIONABLE" }, { action: "REDO", reason: "FIX_DID_NOT_LAND" }]) {
    for (const legs of [...shapes, undefined, []]) rows.push({ decision, legs });
  }
  assert.deepEqual(rows.map((row) => gw.countsAsReview(row)), rows.map((row) => completeRound(row)), "the goal wall and the merge gate agree on every row");

  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-14.ndjson");
  writeFileSync(marker, [
    { ts: "2026-10-18T01:00:00Z", artifact: { kind: "diff", source: "PR #777080" }, actionable: 0, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS },
    { ts: "2026-10-18T02:00:00Z", artifact: { kind: "diff", source: "PR #777080" }, actionable: 4, decision: {} },
    { ts: "2026-10-18T01:00:00Z", artifact: { kind: "diff", source: "PR #777081" }, decision: { action: "ESCALATE", reason: "NO_CONSENSUS" }, legs: TWO_LEGS },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    assert.equal(fire({ session_id: "r12-1", tool_name: "Bash", tool_input: { command: "gh pr merge 777080" } }).notice, "", "a row with no recorded verdict is not shown");
    assert.match(fire({ session_id: "r12-2", tool_name: "Bash", tool_input: { command: "gh pr merge 777081" } }).notice, /PR #777081: the latest review round ended ESCALATE\/NO_CONSENSUS, not QUIET/);
  } finally { rmSync(marker, { force: true }); }
});

test("v0.10.3 panel round 13: the newest round WITH findings is named even when a later incomplete one found none", () => {
  mkdirSync(LEDGER, { recursive: true });
  const marker = join(LEDGER, "9999-15.ndjson");
  const one = [{ leg: "a", model: "m-a", answered: true, kind: "answered", parseFailed: false }];
  writeFileSync(marker, [
    { ts: "2026-10-18T01:00:00Z", runnerRound: 1, artifact: { kind: "diff", source: "PR #777090" }, actionable: 0, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS },
    { ts: "2026-10-18T02:00:00Z", runnerRound: 2, artifact: { kind: "diff", source: "PR #777090" }, actionable: 4, decision: { action: "STOP", reason: "PARTIAL" }, legs: one },
    { ts: "2026-10-18T03:00:00Z", runnerRound: 3, artifact: { kind: "diff", source: "PR #777090" }, actionable: 0, decision: { action: "STOP", reason: "PARTIAL" }, legs: one },
    { ts: "2026-10-18T02:00:00Z", runnerRound: 1, artifact: { kind: "diff", source: "PR #777091" }, actionable: 2, decision: { action: "STOP", reason: "PARTIAL" }, legs: one },
    { ts: "2026-10-18T03:00:00Z", runnerRound: 2, artifact: { kind: "diff", source: "PR #777091" }, actionable: 0, decision: { action: "STOP", reason: "QUIET" }, legs: TWO_LEGS },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    assert.match(fire({ session_id: "r13-1", tool_name: "Bash", tool_input: { command: "gh pr merge 777090" } }).notice, /a NEWER round \(round 2\) was incomplete \(STOP\/PARTIAL\) and found 4 actionable/);
    assert.equal(fire({ session_id: "r13-2", tool_name: "Bash", tool_input: { command: "gh pr merge 777091" } }).notice, "", "a later complete quiet round supersedes older findings");
  } finally { rmSync(marker, { force: true }); }
});

test("v0.10.3 panel round 14: the findings notice also shows in reminder-only mode", () => {
  const consumer = mkdtempSync(join(TEST_ROOT, "merge-optout-warn-"));
  mkdirSync(join(consumer, ".git"));
  mkdirSync(join(consumer, "ledger"));
  writeFileSync(join(consumer, "tribunal.config.json"), JSON.stringify({ ledgerHome: "ledger", gates: { mergeGate: false } }));
  writeFileSync(join(consumer, "ledger", "2026-10.ndjson"), JSON.stringify({ ts: "2026-10-18T01:00:00Z", runnerRound: 3, artifact: { kind: "diff", source: "PR #777100" }, actionable: 2, decision: { action: "CONTINUE", reason: "ACTIONABLE" }, legs: TWO_LEGS }) + "\n");
  const r = fire({ tool_name: "Bash", tool_input: { command: "gh pr merge 777100" } }, { cwd: consumer });
  assert.equal(r.code, 0);
  assert.match(r.notice, /PR #777100: the latest review round \(round 3\) still had 2 actionable finding\(s\)/);
});
