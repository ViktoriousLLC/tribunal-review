#!/usr/bin/env node
// Tribunal's merge gate and goal-write reminder. The panel runs through
// /tribunal-review:review; its multi-model work outlasts a hook's seconds-long timeout.
//
// PreToolUse(Bash) gates numbered `gh pr merge` commands by default. A PR with no recorded
// local panel row blocks with exit 2 and a review command on stderr. State under the consumer
// ledger home limits blocking to three attempts per PR per session, then stands down loudly.
// Reviewed PRs and merges without an identifiable PR number pass silently. The consumer's
// .claude/tribunal-wall-breakglass file or TRIBUNAL_ALLOW_UNREVIEWED_MERGE=1 allows an
// unreviewed merge with a visible notice. gates.mergeGate=false restores reminder-only mode.
//
// PostToolUse(Write|Edit) reminds after writing a goal under policy.goalsDir, unless a complete
// panel row already records its current bytes. This notice never blocks; the Stop goal wall
// enforces goal review at the end of the reply.
//
// Policy locates the reviewed repository and ledger, never the plugin installation directory.
// Invalid hook input is ignored. Unreadable or unwritable brake state stands down visibly
// because a gate that cannot persist a budget must not block indefinitely.

const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve, win32, posix } = require("node:path");
const { createHash } = require("node:crypto");
const MAX_BLOCKS = 3;
const BREAK_GLASS = ".claude/tribunal-wall-breakglass";

/**
 * Resolve relative paths against the consumer root, retaining every path component. Only
 * Windows and macOS comparisons fold case; a Linux filename's case and backslashes are data.
 * The platform argument keeps these filesystem rules testable on every host.
 */
function canonicalPath(p, root = process.cwd(), platform = process.platform) {
  const paths = platform === "win32" ? win32 : posix;
  let absolute = paths.resolve(root, String(p || ""));
  if (platform === "win32") absolute = absolute.replace(/\\/g, "/");
  return platform === "win32" || platform === "darwin" ? absolute.toLowerCase() : absolute;
}

function* ledgerRows(readDirSync, readFile, ledgerDir, matches = (f) => f.endsWith(".ndjson")) {
  let files = [];
  try { files = readDirSync(ledgerDir).filter(matches); } catch { return; }
  for (const f of files) {
    let text = "";
    try { text = readFile(join(ledgerDir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch { /* a half-written line is not a reason to break a merge */ }
    }
  }
}

/** PR review matches the recorded source identity; it does not fetch the current PR head. */
function reviewedSources(readDirSync, readFile, ledgerDir) {
  const seen = new Set();
  for (const row of ledgerRows(readDirSync, readFile, ledgerDir)) {
    if (row?.artifact?.source) seen.add(canonicalPath(row.artifact.source));
  }
  return seen;
}

/** Reviewed at this content: complete document rounds, with the goal wall's exact semantics. */
function reviewedHashes(readDirSync, readFile, ledgerDir) {
  const hashes = new Set();
  for (const row of ledgerRows(readDirSync, readFile, ledgerDir, (f) => /^\d{4}-\d{2}\.ndjson$/.test(f))) {
    if (row?.artifact?.kind !== "document") continue;
    if (!row.decision || typeof row.decision.action !== "string" || row.decision.reason === "PARTIAL") continue;
    if (typeof row.contentHash === "string") hashes.add(row.contentHash);
  }
  return hashes;
}

/**
 * All identifiable PR numbers in `gh pr merge ...` commands, once per invocation.
 *
 * EVERY segment is scanned so a chained command such as `git push && gh pr merge 7`
 * triggers the same gate as a standalone merge command.
 */
function prsFromMergeCommand(cmd) {
  if (typeof cmd !== "string") return [];
  // The command must BEGIN a segment, not merely appear inside one.
  //
  // Matching the phrase anywhere would mistake `git commit -m "...gh pr merge..."` or an
  // `echo` of a fixture for a merge. Quoted prose must not produce spurious reminders.
  const segments = cmd.split(/&&|\|\||;|\|/).filter((x) => /^\s*(?:sudo\s+)?gh\s+pr\s+merge\b/.test(x));
  const prs = new Set();
  const VALUE_FLAGS = new Set(["-b", "--body", "-t", "--subject", "--match-head-commit", "--author-email", "-R", "--repo"]);
  for (const seg of segments) {
    const m = seg.match(/\bgh\s+pr\s+merge\b([^]*)$/);
    const rest = (m?.[1] || "").trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < rest.length; i += 1) {
      const t = rest[i];
      if (VALUE_FLAGS.has(t)) { i += 1; continue; }
      if (t.startsWith("-")) continue;
      const n = t.match(/^(\d+)$|^https?:\/\/[^\s]+\/pull\/(\d+)$/);
      if (n) { prs.add(n[1] || n[2]); break; }
    }
  }
  // A bare merge or branch name cannot be matched to a recorded PR. Keep scanning subsequent
  // commands, since an unidentified or reviewed merge must not hide another numbered merge.
  return [...prs];
}

/** The first identifiable PR, retained for callers of the single-PR parser. */
function prFromMergeCommand(cmd) {
  // A BARE `gh pr merge` (no number, branch inferred) returns null, NOT a placeholder.
  //
  // The ledger cannot match a placeholder such as "current branch" to a recorded PR number.
  // Returning one would remind on every branch-inferred merge, even immediately after review.
  // Stay silent when the command does not identify a PR to avoid an unsatisfiable reminder.
  return prsFromMergeCommand(cmd)[0] || null;
}

function isGoalWrite(path, root = process.cwd(), goalsDir = "docs/reference/goals", platform = process.platform) {
  if (typeof path !== "string") return false;
  const file = canonicalPath(path, root, platform);
  const directory = canonicalPath(goalsDir, root, platform).replace(/\/+$/, "");
  return file.startsWith(`${directory}/`) && file.endsWith(".md");
}

/**
 * Emit a NON-BLOCKING notice on the channel Claude Code actually surfaces.
 *
 * A non-blocking notice is JSON on STDOUT carrying `systemMessage`, then exit 0.
 * stderr plus exit 0 does not surface the reminder. Tests must assert on stdout to verify
 * that the notice reaches the user rather than merely being written to an unused channel.
 */
function emitNotice(hookEventName, notice) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: notice },
    systemMessage: notice.trimEnd(),
  }));
}

/** Match the goal wall's bounded brake: corrupt state resets; unreadable state stands down. */
function readMergeState(file) {
  let text;
  try {
    if (!existsSync(file)) return {};
    text = readFileSync(file, "utf8");
  } catch { return null; }
  try {
    const state = JSON.parse(text);
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch { return {}; }
}

function gateMerge(pr, payload, repoRoot, ledgerHome) {
  const allow = (reason) => ({ notice: `[merge-gate] ${reason} PR #${pr} proceeds UNREVIEWED.` });
  if (existsSync(join(repoRoot, BREAK_GLASS))) {
    return allow(`BREAK-GLASS: ${BREAK_GLASS} is present; the merge gate stands aside. Delete it to restore the gate.`);
  }
  if (process.env.TRIBUNAL_ALLOW_UNREVIEWED_MERGE === "1") {
    return allow("OVERRIDE: TRIBUNAL_ALLOW_UNREVIEWED_MERGE=1; the merge gate stands aside.");
  }

  const sessionId = payload.session_id || (typeof payload.transcript_path === "string"
    ? createHash("sha256").update(payload.transcript_path).digest("hex").slice(0, 12) : "unknown");
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const file = join(ledgerHome, `merge-state-${safe}.json`);
  const state = readMergeState(file);
  if (state === null) {
    return allow(`STAND-DOWN (UNVERIFIED): the merge gate's state file ${file} cannot be read, so bounded blocking is impossible. Fix the ledger home and retry.`);
  }
  const key = `PR #${pr}`;
  const count = Number.isSafeInteger(state[key]) && state[key] >= 0 ? state[key] : 0;
  if (count >= MAX_BLOCKS) {
    return allow(`STAND-DOWN after ${MAX_BLOCKS} blocks this session for ${key}.`);
  }
  state[key] = count + 1;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state), "utf8");
  } catch {
    return allow(`STAND-DOWN (UNVERIFIED): the merge gate's state file ${file} cannot be written, so bounded blocking is impossible. Fix the ledger home and retry.`);
  }
  return { block: `[merge-gate] BLOCKED: PR #${pr} has no recorded local panel.\n` +
    `Run /tribunal-review:review ${pr}, then retry the merge.\n` +
    `Block ${state[key]} of ${MAX_BLOCKS} for this PR this session; after ${MAX_BLOCKS} the merge gate stands down loudly. ` +
    `Break-glass: ${BREAK_GLASS}. Automation override: TRIBUNAL_ALLOW_UNREVIEWED_MERGE=1.` };
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return; }
  if (!payload || typeof payload !== "object") return;
  const tool = payload.tool_name || payload.toolName;
  const input = payload.tool_input || payload.toolInput || {};
  const prs = tool === "Bash" ? prsFromMergeCommand(input.command) : [];
  if (tool === "Bash" && !prs.length) return;
  let policy;
  try {
    const { resolvePolicy } = await import("../scripts/policy.mjs");
    policy = resolvePolicy(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  } catch (e) {
    if (prs.length) emitNotice("PreToolUse", `[merge-gate] STAND-DOWN (UNVERIFIED): policy could not be resolved: ${e.message}. ${prs.map((pr) => `PR #${pr}`).join(", ")} proceed UNREVIEWED.`);
    return;
  }
  const { repoRoot, ledgerHome, goalsDir, gates } = policy;
  const runner = join(__dirname, "..", "scripts", "run.mjs").replace(/\\/g, "/");

  if (tool === "Bash") {
    const reviewed = reviewedSources(readdirSync, readFileSync, ledgerHome);
    const notices = [];
    const blocks = [];
    for (const pr of prs) {
      if (reviewed.has(canonicalPath(`PR #${pr}`))) continue;
      if (gates.mergeGate) {
        const result = gateMerge(pr, payload, repoRoot, ledgerHome);
        if (result.block) blocks.push(result.block);
        else notices.push(result.notice);
      } else {
        notices.push(`Tribunal: PR #${pr} has no recorded local panel.\n` +
          `  node "${runner}" --pr ${pr}\n` +
          `  (reminder only, not a block — run /tribunal-review:review ${pr} to review)`);
      }
    }
    if (blocks.length) {
      process.stderr.write(`${[...blocks, ...notices].join("\n")}\n`);
      process.exitCode = 2;
    } else if (notices.length) emitNotice("PreToolUse", notices.join("\n"));
    return;
  }

  const path = input.file_path || input.path;
  if ((tool === "Write" || tool === "Edit") && isGoalWrite(path, repoRoot, goalsDir)) {
    const reviewed = reviewedHashes(readdirSync, readFileSync, ledgerHome);
    let hash;
    try { hash = createHash("sha256").update(readFileSync(resolve(repoRoot, path))).digest("hex"); }
    catch { /* unreadable content cannot establish a review; the notice still never blocks */ }
    if (reviewed.has(hash)) return;
    emitNotice("PostToolUse",
      `Tribunal: this goal statement has no recorded panel for this content.\n` +
      `  node "${runner}" --file "${path}"\n` +
      `  (review goal statements before execution; reminder only)`,
    );
  }
}

if (require.main === module) {
  main().catch((e) => {
    emitNotice("PreToolUse", `[merge-gate] STAND-DOWN (UNVERIFIED): the hook could not finish: ${e.message}`);
    process.exitCode = 0;
  });
}

module.exports = { prFromMergeCommand, isGoalWrite, reviewedSources, canonicalPath };
