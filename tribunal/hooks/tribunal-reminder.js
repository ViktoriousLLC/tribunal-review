#!/usr/bin/env node
// Tribunal's merge gate and goal-write reminder. The panel runs through
// /tribunal-review:review; its multi-model work outlasts a hook's seconds-long timeout.
//
// PreToolUse(Bash|PowerShell) gates `gh pr merge` (and REST `pulls/<n>/merge`) by default. A PR
// with no recorded local panel row blocks with exit 2 and a review command on stderr. A merge
// that names no PR number cannot be checked, so it blocks as UNVERIFIED and asks for the number.
// State under the consumer ledger home limits blocking to three attempts per PR (and three for
// unnumbered merges) per session, then stands down loudly. Reviewed PRs pass silently. The consumer's
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
//
// Only a COMPLETE round counts as a review: a diff row whose decision is not PARTIAL or
// UNREADABLE and on which at least two distinct models answered and parsed. A round in which every leg
// failed records PARTIAL, and a one-leg panel is one model's opinion; neither unlocks the merge.
// A complete round that still found actionable findings unlocks it with a visible warning.
//
// TIME. Claude Code kills a hook that outlives its hooks.json timeout and then lets the tool call
// proceed, so a slow ledger read would be a silent pass. The hook keeps its own budget
// (HOOK_BUDGET_MS, well under the timeout) and, when it runs out, BLOCKS as UNVERIFIED through the
// same three-per-PR brake instead of being killed. The budget is checked between reads, so one
// read that hangs for the whole minute (a stalled network drive) is still a kill and a pass.
//
// LIMITS. This guards against forgetting the review, not against an adversary: the ledger is a
// local file any process can write, a PR is matched by number and not by head commit, and a merge
// hidden inside `bash -c "..."`, a script file or an alias is not seen.

const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve, win32, posix } = require("node:path");
const { createHash } = require("node:crypto");
const MAX_BLOCKS = 3;
const BREAK_GLASS = ".claude/tribunal-wall-breakglass";
/** The hook's own time budget. hooks.json allows 60 seconds; the hook stops reading at 40. */
/**
 * An empty or malformed value keeps the default, so a typo does not shrink the budget. An
 * explicit 0 is honoured (tests use it); like TRIBUNAL_ALLOW_UNREVIEWED_MERGE, whoever controls
 * the hook's environment controls the gate.
 */
function hookBudgetMs(raw = process.env.TRIBUNAL_HOOK_BUDGET_MS) {
  const n = typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : 40_000;
  return Math.min(40_000, n);
}
const HOOK_BUDGET_MS = hookBudgetMs();
const DEADLINE = Date.now() + HOOK_BUDGET_MS;

class HookDeadline extends Error {
  constructor() { super(`the ledger could not be read within the hook's ${HOOK_BUDGET_MS / 1000}s budget`); }
}
function checkDeadline(deadline) { if (Date.now() >= deadline) throw new HookDeadline(); }

/** One model is not a panel: a round needs this many distinct models that answered and parsed. */
const MIN_REVIEW_LEGS = 2;

/**
 * Distinct models among a ledger row's counted legs that answered and parsed. Allow-lists
 * (kind "answered", a named model), so a kind added later or a leg with no model fails closed.
 * Distinct by model, so two seats on one model, or a leg banked twice, are one opinion. The
 * runner names the model on every leg. Advisory seats are banked apart from `legs`.
 */
function readLegs(row) {
  if (!Array.isArray(row?.legs)) return 0;
  const read = row.legs.filter((l) => l && l.kind === "answered" && l.answered === true && !l.parseFailed
    && typeof l.model === "string" && l.model.trim());
  return new Set(read.map((l) => l.model.trim())).size;
}

/**
 * A complete round: it carries a decision that is neither PARTIAL nor UNREADABLE, and at least
 * MIN_REVIEW_LEGS legs answered and parsed. A registry shrunk to one leg completes its rounds by
 * construction, and that is one model's opinion, not a review. The goal wall uses the same rule.
 */
function completeRound(row) {
  return Boolean(row?.decision) && typeof row.decision.action === "string"
    && row.decision.reason !== "PARTIAL" && row.decision.reason !== "UNREADABLE"
    && readLegs(row) >= MIN_REVIEW_LEGS;
}

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

function* ledgerRows(readDirSync, readFile, ledgerDir, matches = (f) => f.endsWith(".ndjson"), mentions = null, deadline = DEADLINE) {
  let files = [];
  try { files = readDirSync(ledgerDir).filter(matches); } catch { return; }
  for (const f of files) {
    checkDeadline(deadline);
    let text = "";
    try { text = readFile(join(ledgerDir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      checkDeadline(deadline);
      if (!line.trim()) continue;
      // Parse only lines that can matter; a long ledger is mostly other artifacts.
      if (mentions && !mentions.some((m) => line.includes(m))) continue;
      try {
        yield JSON.parse(line);
      } catch { /* a half-written line is not a reason to break a merge */ }
    }
  }
}

/**
 * PR sources with a COMPLETE diff round, each mapped to its latest complete round
 * ({ ts, round, actionable, decision }). PR review matches the recorded source identity; it does
 * not fetch the current PR head. A PARTIAL row, or a row with no decision, is not a review: a
 * round in which every leg failed must not unlock the merge. A round that still found actionable
 * findings DOES unlock it: the gate proves a review happened, and the caller warns.
 */
function reviewedSources(readDirSync, readFile, ledgerDir, prs = null, deadline = DEADLINE) {
  const seen = new Map();
  const flagged = new Map(); // the newest diff round of ANY completeness that found findings
  const mentions = prs ? prs.map((pr) => `PR #${pr}`) : null;
  const summary = (row, ts) => ({ ts, round: row.runnerRound ?? row.round ?? null, actionable: Number.isFinite(row.actionable) ? row.actionable : null, decision: row.decision });
  for (const row of ledgerRows(readDirSync, readFile, ledgerDir, undefined, mentions, deadline)) {
    if (row?.artifact?.kind !== "diff" || !row.artifact.source || typeof row?.decision?.action !== "string") continue;
    const key = canonicalPath(row.artifact.source);
    const ts = typeof row.ts === "string" ? row.ts : "";
    // Later rows win; an untimed row never displaces a timed one.
    if (Number.isFinite(row.actionable) && row.actionable > 0 && !(flagged.get(key)?.ts > ts)) flagged.set(key, summary(row, ts));
    if (!completeRound(row) || seen.get(key)?.ts > ts) continue;
    seen.set(key, summary(row, ts));
  }
  // A newer INCOMPLETE round (a leg hit its plan limit after a fix) that still found findings
  // must not hide behind an older complete one. It cannot unlock the merge; it is shown.
  for (const [key, latest] of seen) {
    const last = flagged.get(key);
    if (last && last.ts > latest.ts) latest.newer = last;
  }
  return seen;
}

/** Reviewed at this content: complete document rounds, with the goal wall's exact semantics. */
function reviewedHashes(readDirSync, readFile, ledgerDir, hash = null) {
  const hashes = new Set();
  for (const row of ledgerRows(readDirSync, readFile, ledgerDir, (f) => /^\d{4}-\d{2}\.ndjson$/.test(f), hash ? [hash] : null)) {
    if (row?.artifact?.kind !== "document" || !completeRound(row)) continue;
    if (typeof row.contentHash === "string") hashes.add(row.contentHash);
  }
  return hashes;
}

/**
 * Split a command line into the pieces a shell runs as separate commands.
 *
 * Separators are newlines, `;`, `&`, `&&`, `|`, `||`, parentheses and braces. A separator
 * INSIDE quotes is data (`git commit -m "a; gh pr merge 7"` is one commit). Command substitution
 * (`$(...)`, and backticks in Bash) runs even inside double quotes, so its contents are split as
 * commands of their own, and the quote resumes after it closes. A line continuation (backslash-
 * newline in Bash, backtick-newline in PowerShell) joins lines. A comment (`#` starting a word)
 * runs to the end of its line. A Bash here-document body is data fed to a command, so it is
 * prose, except the command substitutions inside an UNQUOTED one (`<<EOF`), which Bash runs.
 * PowerShell's escape character is the backtick, not the backslash.
 *
 * When a substitution closes, the piece it interrupted resumes with a placeholder where the
 * substitution stood, so `echo $(date) gh pr merge 7` stays one echo while
 * `SHA=$(git rev-parse HEAD) gh pr merge 7` is still a merge. A heredoc body starts behind a NUL
 * placeholder so its prose can never begin a command piece.
 */
function shellSegments(cmd, dialect = "bash", { heredocBody = false } = {}) {
  const ps = dialect === "powershell";
  const escape = ps ? "`" : "\\";
  const s = ps ? cmd.replace(/`\r?\n/g, " ") : cmd.replace(/\\\r?\n/g, "");
  const out = [];
  let cur = heredocBody ? "\0" : "";
  // null, "'", '"', or "H": a heredoc body, which behaves like a double quote no `"` can close.
  let quote = heredocBody ? "H" : null;
  const frames = []; // one per open substitution: the piece and quote it interrupted, its closer, paren depth
  const heredocs = [];
  const cut = () => { out.push(cur); cur = ""; };
  const enter = (closer) => { frames.push({ outer: cur, quote, closer, depth: 0 }); quote = null; cur = ""; };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = null; cur += c; continue; }
    if (c === escape && i + 1 < s.length) { cur += c + s[i + 1]; i += 1; continue; }
    const top = frames[frames.length - 1];
    if (top && quote === null) {
      if (c === "(") { top.depth += 1; cut(); continue; }
      if (c === top.closer && (c !== ")" || top.depth === 0)) {
        frames.pop();
        quote = top.quote;
        cut();
        cur = `${top.outer}X`; // the interrupted piece resumes; X stands for the substitution's output
        continue;
      }
      if (c === ")") { top.depth -= 1; cut(); continue; }
    }
    if (c === "$" && s[i + 1] === "(") { enter(")"); i += 1; continue; }
    if (!ps && c === "`") { enter("`"); continue; }
    if (quote === '"' || quote === "H") { if (c === '"' && quote === '"') quote = null; cur += c; continue; }
    if (ps && c === "@" && (s[i + 1] === "'" || s[i + 1] === '"') && /^[ \t]*\r?\n/.test(s.slice(i + 2))) {
      // A PowerShell here-string runs to a line that starts with its closer ('@ or "@). Quotes
      // inside it are text, so an apostrophe in "it's" cannot open a quote that swallows the
      // next command. A double-quoted one still runs its $(...) substitutions.
      const closer = `\n${s[i + 1]}@`;
      const start = s.indexOf("\n", i) + 1;
      const end = s.indexOf(closer, start - 1);
      const stop = end === -1 ? s.length : end;
      if (s[i + 1] === '"') out.push(...shellSegments(s.slice(start, stop), dialect, { heredocBody: true }));
      cur += "X";
      i = end === -1 ? s.length : end + closer.length - 1;
      continue;
    }
    if (ps && c === "<" && s[i + 1] === "#") { // a PowerShell block comment
      const end = s.indexOf("#>", i + 2);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    // A comment starts only where a word can start; `${#ARRAY[@]}` is an expansion, not a comment.
    if (c === "#" && (i === 0 || /[\s;&|]/.test(s[i - 1]))) {
      // A comment: skip to the end of the line, leaving the newline to end the piece.
      const end = s.indexOf("\n", i);
      i = (end === -1 ? s.length : end) - 1;
      continue;
    }
    if (!ps && c === "<" && s[i + 1] === "<" && s[i + 2] === "<") { cur += "<<<"; i += 2; continue; } // a here-string, one word
    if (!ps && c === "<" && s[i + 1] === "<") {
      const m = /^<<(-?)\s*(\\?)(["']?)([A-Za-z0-9_.-]+)\3/.exec(s.slice(i));
      if (m) {
        heredocs.push({ word: m[4], tabs: m[1] === "-", runs: !m[2] && !m[3] });
        cur += m[0]; i += m[0].length - 1; continue;
      }
    }
    if (c === "\n" && heredocs.length) {
      // Each pending body runs through its terminating line, in order.
      cut();
      let at = i + 1;
      for (const { word, tabs, runs } of heredocs.splice(0)) {
        const body = [];
        for (;;) {
          const end = s.indexOf("\n", at);
          const line = (end === -1 ? s.slice(at) : s.slice(at, end)).replace(/\r$/, "");
          at = end === -1 ? s.length : end + 1;
          if ((tabs ? line.replace(/^\t+/, "") : line) === word) break;
          body.push(line);
          if (end === -1) break;
        }
        if (runs) out.push(...shellSegments(body.join("\n"), dialect, { heredocBody: true }));
      }
      i = at - 1;
      continue;
    }
    if ("\n\r;&|(){}".includes(c)) { cut(); continue; }
    cur += c;
  }
  cut();
  return out;
}

/**
 * What may come before `gh` in a piece that runs it: shell keywords (`if`, `then`, `!`, ...),
 * wrappers (`sudo`, `env`, `exec`, `timeout 60`, `xargs`, `nice`, `winpty`, `npx`, `cmd /c`, ...),
 * a leading redirection (`2>/dev/null`), Bash `VAR=value` and PowerShell `$out =`, then a bare,
 * full or quoted path. Case-insensitive, because Windows runs `GH` and `gh.exe` alike.
 */
const BEFORE_GH = String.raw`^\s*(?:(?:if|then|else|elif|do|while|until|!)\s+|(?:sudo|env|command|builtin|exec|time|nohup|xargs|winpty|npx)(?:\s+-\S+)*\s+|nice(?:\s+-n\s*-?\d+|\s+-(?!n\b)\S+)*\s+|timeout(?:\s+-\S+)*\s+\S+\s+|cmd(?:\.exe)?\s+\/[ck]\s+["']?|\d*[<>]+\s*\S+\s+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+|\$[\w:]+\s*=\s*)*` +
  String.raw`(?:"[^"]*[\\/]|'[^']*[\\/]|\S*[\\/]|["'])?gh(?:\.exe)?["']?`;
/** gh's own flags may come before the subcommand: `gh -R owner/repo pr merge 7`, `--repo=x`, `-Rx`. */
const GH_FLAGS = String.raw`(?:\s+(?:-R|--repo|--hostname)(?:=|\s+)?\S+)*`;
const MERGE_SEGMENT = new RegExp(`${BEFORE_GH}${GH_FLAGS}\\s+pr\\s+merge\\b`, "i");
/**
 * The same merge through the REST API: `gh api -X PUT repos/o/r/pulls/7/merge`. Only a PUT
 * merges; a plain `gh api .../pulls/7/merge` is the read-only "is it merged?" check.
 */
/** Shell words: runs of unquoted text and quoted parts, so `k='a b'` and `"x y"` are each ONE word. */
const SHELL_WORDS = /(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g;
const API_SEGMENT = new RegExp(`${BEFORE_GH}${GH_FLAGS}\\s+api\\b`, "i");
const API_REST_MERGE = /\bpulls\/([^/\s"']+)\/merge\b/i;
/** Or through GraphQL, which names the PR by node id, never by number (anywhere in the call). */
const API_GRAPHQL_MERGE = /\bmergePullRequest\b/;

/**
 * Every merge a command runs, as PR numbers plus a count of merges that name NO number (the
 * current branch, a branch name, a variable, a GraphQL node id). The gate cannot check an
 * unnumbered merge against the ledger, so the caller blocks it as UNVERIFIED and asks for the
 * number instead of letting it pass silently.
 */
function mergesInCommand(cmd, dialect = "bash") {
  const prs = new Set();
  let unnumbered = 0;
  if (typeof cmd !== "string") return { prs: [], unnumbered };
  const VALUE_FLAGS = new Set(["-b", "--body", "-F", "--body-file", "-t", "--subject", "--match-head-commit", "--author-email", "-R", "--repo", "--hostname"]);
  for (const seg of shellSegments(cmd, dialect)) {
    if (API_SEGMENT.test(seg)) {
      // Any `gh api` call: a PUT to pulls/<x>/merge, or a mergePullRequest mutation, wherever
      // the endpoint, flags or newlines sit. A literal number is that PR; anything else
      // (`$PR`, a node id) is a merge the gate cannot check. A query read from a file is not seen.
      // The endpoint is the positional argument (quoted or not); a `-f key=value` field that
      // mentions pulls/7/merge is a value, so words carrying `=` or starting with `-` are skipped.
      const words = (seg.match(SHELL_WORDS) || []).slice(1);
      const endpoint = words
        .map((t) => t.replace(/["']/g, "").replace(/\?.*$/, ""))
        .find((t) => !t.startsWith("-") && !t.includes("=") && API_REST_MERGE.test(t));
      const rest = endpoint && endpoint.match(API_REST_MERGE);
      // gh sends a GET unless a method is given or fields are added (then POST). Only a literal
      // GET, or no method and no fields, is a read; a `$METHOD` might be PUT, so it counts.
      const method = seg.match(/(?:^|\s)(?:-X|--method)(?:=|\s+)?["']?([^\s"']+)/i);
      const fields = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:=|\s)/.test(seg);
      const mayWrite = method ? !/^GET$/i.test(method[1]) : fields;
      if (API_GRAPHQL_MERGE.test(seg)) unnumbered += 1;
      else if (mayWrite && rest && /^\d+$/.test(rest[1])) prs.add(String(Number(rest[1])));
      // A write to a merge endpoint the parser cannot pin: `pulls/$PR/merge`, or an endpoint held
      // in a variable (`"$URL"`, not a flag's value such as `--method "$METHOD"`).
      else if (mayWrite && (rest || words.some((w, i) => /^\$\{?\w+\}?$/.test(w.replace(/["']/g, ""))
        && !(words[i - 1] || "").startsWith("-")))) unnumbered += 1;
      continue;
    }
    const m = seg.match(MERGE_SEGMENT);
    if (!m) continue;
    // Arguments after THIS gh's `pr merge` (never an earlier phrase in a prefix), with a quoted
    // value kept whole so `--body "fixes 123 issues"` is one value.
    const rest = seg.slice(m[0].length).match(SHELL_WORDS) || [];
    let found = null;
    let help = false;
    for (let i = 0; i < rest.length; i += 1) {
      // A wholly quoted number is still the PR ("7"); so is the end of a quoted command
      // (`cmd /c "gh pr merge 7"` leaves `7"`). Values were already kept whole above.
      const t = rest[i].replace(/^(["'])(.*)\1$/, "$2").replace(/^(\d+)["']$/, "$1");
      if (VALUE_FLAGS.has(t)) { i += 1; continue; } // its value, even `--help`, is text
      if (t === "-h" || t === "--help") { help = true; continue; }
      if (t.startsWith("-")) continue;
      if (found !== null) continue; // the first positional argument is the PR selector, whatever it is
      const n = t.match(/^#?(\d+)$|^https?:\/\/\S+?\/pull\/(\d+)(?:[/?#]\S*)?$/);
      found = n ? String(Number(n[1] || n[2])) : "";
    }
    if (help) continue; // reading the help merges nothing
    if (found) prs.add(found);
    else unnumbered += 1;
  }
  return { prs: [...prs], unnumbered };
}

/**
 * All identifiable PR numbers in `gh pr merge ...` commands, once per invocation.
 *
 * EVERY piece is scanned so a chained or multi-line command such as `git push` then
 * `gh pr merge 7` on the next line triggers the same gate as a standalone merge command.
 */
function prsFromMergeCommand(cmd, dialect = "bash") {
  // The command must BEGIN a piece, not merely appear inside one: matching the phrase anywhere
  // would mistake `git commit -m "...gh pr merge..."` or an `echo` of a fixture for a merge.
  return mergesInCommand(cmd, dialect).prs;
}

/** The first identifiable PR, retained for callers of the single-PR parser (null when none). */
function prFromMergeCommand(cmd) {
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

/** `pr` is a PR number, or null for a merge that names none (it has its own brake key). */
function gateMerge(pr, payload, repoRoot, ledgerHome, unverified = null) {
  const allow = (reason) => ({ notice: `[merge-gate] ${reason} ${pr === null ? "A merge with no PR number" : `PR #${pr}`} proceeds UNREVIEWED.` });
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
  const key = pr === null ? "PR (no number)" : `PR #${pr}`;
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
  let why;
  if (pr === null) {
    why = "[merge-gate] BLOCKED, UNVERIFIED: this merge names no PR number (the current branch, a branch name or a variable), so the gate cannot check it against the ledger.\n" +
      "Retype it with the number (gh pr merge <number>); if that PR has no panel yet, run /tribunal-review:review <number> first.\n";
  } else {
    why = (unverified
      ? `[merge-gate] BLOCKED, UNVERIFIED: ${unverified}, so PR #${pr} could not be checked.\n`
      : `[merge-gate] BLOCKED: PR #${pr} has no recorded local panel.\n`) +
      `Run /tribunal-review:review ${pr}, then retry the merge.\n`;
  }
  return { block: why +
    `Block ${state[key]} of ${MAX_BLOCKS} for ${pr === null ? "unnumbered merges" : "this PR"} this session; after ${MAX_BLOCKS} the merge gate stands down loudly. ` +
    `Break-glass: ${BREAK_GLASS}. Automation override: TRIBUNAL_ALLOW_UNREVIEWED_MERGE=1.` };
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return; }
  if (!payload || typeof payload !== "object") return;
  const tool = payload.tool_name || payload.toolName;
  const input = payload.tool_input || payload.toolInput || {};
  // The PowerShell tool runs shell commands too; a merge typed there is the same merge.
  const shell = tool === "Bash" || tool === "PowerShell";
  const { prs, unnumbered } = shell ? mergesInCommand(input.command, tool === "PowerShell" ? "powershell" : "bash") : { prs: [], unnumbered: 0 };
  if (shell && !prs.length && !unnumbered) return;
  let policy;
  try {
    const { resolvePolicy } = await import("../scripts/policy.mjs");
    policy = resolvePolicy(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  } catch (e) {
    if (shell) emitNotice("PreToolUse", `[merge-gate] STAND-DOWN (UNVERIFIED): policy could not be resolved: ${e.message}. ${[...prs.map((pr) => `PR #${pr}`), ...(unnumbered ? ["a merge with no PR number"] : [])].join(", ")} proceed UNREVIEWED.`);
    return;
  }
  const { repoRoot, ledgerHome, goalsDir, gates } = policy;
  const runner = join(__dirname, "..", "scripts", "run.mjs").replace(/\\/g, "/");

  if (shell) {
    let reviewed = new Map();
    let unverified = null;
    try { reviewed = reviewedSources(readdirSync, readFileSync, ledgerHome, prs); }
    catch (e) { if (e instanceof HookDeadline) unverified = e.message; else throw e; }
    const notices = [];
    const blocks = [];
    for (const pr of prs) {
      const latest = reviewed.get(canonicalPath(`PR #${pr}`));
      if (latest) {
        // Silent only on a QUIET round. Anything else warns: a count above zero, an ACTIONABLE or
        // CEILING verdict, a REDO (the previous round's findings are still present though this
        // round found none), or a reason added later.
        const reason = latest.decision.reason;
        if (latest.actionable > 0 || reason !== "QUIET") {
          notices.push(`Tribunal: PR #${pr}: the latest review round${latest.round != null ? ` (round ${latest.round})` : ""} ` +
            (latest.actionable > 0
              ? `still had ${latest.actionable} actionable finding(s) (${latest.decision.action}/${reason}). `
              : `ended ${latest.decision.action}/${reason}, not QUIET. `) +
            "The merge proceeds; read the round before merging.");
        }
        if (latest.newer) {
          notices.push(`Tribunal: PR #${pr}: a NEWER round${latest.newer.round != null ? ` (round ${latest.newer.round})` : ""} ` +
            `was incomplete (${latest.newer.decision.action}/${latest.newer.decision.reason}) and found ${latest.newer.actionable} actionable finding(s). ` +
            "The merge proceeds on the older complete round; read the newer findings before merging.");
        }
        continue;
      }
      if (gates.mergeGate) {
        const result = gateMerge(pr, payload, repoRoot, ledgerHome, unverified);
        if (result.block) blocks.push(result.block);
        else notices.push(result.notice);
      } else {
        notices.push(`Tribunal: PR #${pr} has no recorded local panel.\n` +
          `  node "${runner}" --pr ${pr}\n` +
          `  (reminder only, not a block — run /tribunal-review:review ${pr} to review)`);
      }
    }
    // Reminder-only mode stays silent on an unnumbered merge: with no brake there, a notice it
    // can never check would repeat on every merge, even right after a review.
    if (unnumbered && gates.mergeGate) {
      const result = gateMerge(null, payload, repoRoot, ledgerHome);
      if (result.block) blocks.push(result.block);
      else notices.push(result.notice);
    }
    if (blocks.length) {
      process.stderr.write(`${[...blocks, ...notices].join("\n")}\n`);
      process.exitCode = 2;
    } else if (notices.length) emitNotice("PreToolUse", notices.join("\n"));
    return;
  }

  const path = input.file_path || input.path;
  if ((tool === "Write" || tool === "Edit") && isGoalWrite(path, repoRoot, goalsDir)) {
    let hash;
    try { hash = createHash("sha256").update(readFileSync(resolve(repoRoot, path))).digest("hex"); }
    catch { /* unreadable content cannot establish a review; the notice still never blocks */ }
    let unverified = "";
    if (hash) {
      try { if (reviewedHashes(readdirSync, readFileSync, ledgerHome, hash).has(hash)) return; }
      catch (e) { if (e instanceof HookDeadline) unverified = ` (UNVERIFIED: ${e.message})`; else throw e; }
    }
    emitNotice("PostToolUse",
      `Tribunal: this goal statement has no recorded panel for this content${unverified}.\n` +
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

module.exports = { prFromMergeCommand, prsFromMergeCommand, mergesInCommand, shellSegments, isGoalWrite, reviewedSources, canonicalPath, completeRound, readLegs, hookBudgetMs, MIN_REVIEW_LEGS };
