#!/usr/bin/env node

'use strict';

// goal-wall.js — default Stop-hook wall for unreviewed goal statements.
// The bundled Stop hook checks goals at the end of each reply. An unreviewed goal
// statement cannot pass the enabled wall SILENTLY. tribunal.config.json may opt out
// with gates.goalWall: false; resolvePolicy supplies that setting and the wall exits
// silently before checking goals or consuming the session brake.
//
//   TRIGGER   Every file under policy.goalsDir (default docs/reference/goals) that DIFFERS FROM origin/main:
//             dirty or untracked in the working tree (git status --porcelain -uall -z, so files
//             inside new directories are listed one by one), changed in local commits not yet
//             on main (git diff --name-only -z origin/main...HEAD), or gitignored inside the
//             directory (git ls-files --others --ignored). Any write path counts; a shell write
//             is as dirty as a file-tool write. A flagged file whose current bytes equal its
//             origin/main blob is dropped (reverted IS main). Deleted files are exempt. A
//             missing goals directory is clean. Any OTHER git failure is DEGRADED.
//   CHECK     sha256 of the file's bytes (exactly what the tribunal runner banks as
//             contentHash) must appear on a ledger row of kind "document" whose decision is
//             not PARTIAL or UNREADABLE and on which at least two distinct models answered and parsed.
//             Ledger home mirrors the plugin's policy: tribunal.config.json's
//             ledgerHome if set, else ~/.tribunal/<folder>-<8 hex of sha256(root)>/. A MISSING
//             ledger directory is an empty ledger and BLOCKS; an IO error reading rows is
//             DEGRADED.
//   VERDICT   Every condition speaks AS THE BLOCK REASON (exit 2 + stderr): an unpaid debt
//             names the file and the command that clears it; a DEGRADED state blocks with an
//             UNVERIFIED banner. stop_hook_active is IGNORED on purpose: it is shared by every
//             stop hook, so a sibling's block would silently disarm this wall.
//   BRAKE     The wall's own state, one file per session in the ledger home
//             (wall-state-<sessionId>.json), counts blocks per (file, contentHash) plus one
//             DEGRADED key. Three blocks per key, then it STANDS DOWN for that key with a
//             best-effort banner on stderr (exit 0). New content = new key = fresh budget. If
//             the state can be neither read nor written, it stands down for that stop with the
//             banner rather than loop forever.
//   BREAK-GLASS  .claude/tribunal-wall-breakglass at the repo root (tracked-visible, NOT
//             gitignored). While it exists the wall allows and prints a BREAK-GLASS banner
//             saying whether the file is committed or loose. Deliberate, never invisible.
//   EXIT      0 allow, 2 block. Malformed hook input allows (a hook must never trap the
//             assistant on its own bug). A banner on an ALLOW (break-glass, stand-down) goes to
//             STDOUT as JSON {systemMessage}: Claude Code does not show stderr on exit 0.
//   TIME      Claude Code kills a hook past its hooks.json timeout and lets the reply end, a
//             silent pass. The wall keeps its own budget (40s of the 60s timeout): a git call or
//             ledger read past it is DEGRADED, which blocks through the brake. The budget is
//             checked between reads, so one read that hangs the whole minute is still a pass.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const GOALS_DIR = 'docs/reference/goals';
const BREAK_GLASS = '.claude/tribunal-wall-breakglass'; // repo-relative, forward slashes on every platform
const MAX_BLOCKS = 3;
const PREFIX = '[goal-wall]';
// An empty or malformed value keeps the default, so a typo cannot zero the budget.
const RAW_BUDGET = process.env.TRIBUNAL_HOOK_BUDGET_MS;
const HOOK_BUDGET_MS = Math.min(40000, typeof RAW_BUDGET === 'string' && /^\s*\d+\s*$/.test(RAW_BUDGET) ? Number(RAW_BUDGET) : 40000);
const DEADLINE = Date.now() + HOOK_BUDGET_MS;
const budgetError = () => new Error(`the check ran past the hook's ${HOOK_BUDGET_MS / 1000}s budget`);

/** An allow that must still be SEEN: stdout JSON, the channel Claude Code shows on exit 0. */
function banner(text) {
  process.stdout.write(JSON.stringify({ systemMessage: text.trimEnd() }));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function findRepoRoot() {
  // Match resolvePolicy's walk and fallback, including a nested project directory and a
  // worktree's .git file. This fallback also locates break-glass when policy is malformed.
  const start = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function git(root, args) {
  const left = DEADLINE - Date.now();
  if (left <= 0) return { ok: false, error: budgetError().message, stdout: '' };
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: left });
  if (r.error) return { ok: false, error: r.error.code === 'ETIMEDOUT' ? budgetError().message : r.error.message, stdout: '' };
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() || `git exited ${r.status}`, stdout: r.stdout || '' };
  return { ok: true, stdout: r.stdout || '' };
}

/** `git status --porcelain -uall -z` entries; rename/copy records carry two NUL-separated paths. */
function parseStatusZ(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i += 1; // skip the old path
    if (xy[0] === 'D' || xy[1] === 'D') continue; // deleted: nothing left to review
    files.push(p);
  }
  return files;
}

function toRepoRel(p) {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p; // a POSIX name may contain a backslash
}

/** Files under the goals dir that differ from origin/main, or DEGRADED with a reason. */
function flaggedGoals(root, goalsDir = path.join(root, GOALS_DIR)) {
  const absoluteGoals = path.resolve(root, goalsDir);
  const relativeGoals = toRepoRel(path.relative(root, absoluteGoals)) || '.';
  // Directory names containing [] or * are valid configuration, not Git wildcards.
  const magic = ['win32', 'darwin'].includes(process.platform) ? 'icase,literal' : 'literal';
  const pathspec = `:(${magic})${relativeGoals}`;
  // MISSING is clean (nothing to review); anything else that stops us reading the directory
  // (permissions, a file where the directory should be) is DEGRADED, never a silent pass.
  try {
    if (!fs.statSync(absoluteGoals).isDirectory()) return { degraded: `${relativeGoals} is not a directory` };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { files: [] };
    return { degraded: `${relativeGoals} could not be read: ${e && e.message ? e.message : e}` };
  }
  const status = git(root, ['status', '--porcelain', '-uall', '-z', '--', pathspec]);
  if (!status.ok) return { degraded: `git status failed: ${status.error}` };
  const committed = git(root, ['diff', '--name-only', '-z', 'origin/main...HEAD', '--', pathspec]);
  if (!committed.ok) return { degraded: `git diff against origin/main failed (missing ref?): ${committed.error}` };
  const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', pathspec]);
  if (!ignored.ok) return { degraded: `git ls-files failed: ${ignored.error}` };

  const set = new Set();
  for (const p of parseStatusZ(status.stdout)) set.add(toRepoRel(p));
  for (const p of committed.stdout.split('\0')) if (p) set.add(toRepoRel(p));
  for (const p of ignored.stdout.split('\0')) if (p) set.add(toRepoRel(p));

  const files = [];
  for (const rel of set) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue; // deleted or renamed away
    // Reverted IS main: drop a file whose current blob equals origin/main's.
    const mainBlob = git(root, ['rev-parse', '-q', '--verify', `origin/main:${rel}`]);
    if (mainBlob.ok) {
      const mine = git(root, ['hash-object', '--', rel]);
      if (mine.ok && mine.stdout.trim() === mainBlob.stdout.trim()) continue;
    }
    files.push(rel);
  }
  return { files };
}

function repoSlug(root) {
  const resolved = path.resolve(root);
  return `${path.basename(resolved) || 'root'}-${sha256(resolved).slice(0, 8)}`;
}

/** One model is not a panel; mirrors tribunal-reminder.js. */
const MIN_REVIEW_LEGS = 2;

/** Distinct models among a row's legs that answered and parsed; mirrors tribunal-reminder.js. */
function readLegs(row) {
  if (!Array.isArray(row.legs)) return 0;
  const read = row.legs.filter((l) => l && l.kind === 'answered' && l.answered === true && !l.parseFailed
    && typeof l.model === 'string' && l.model.trim());
  return new Set(read.map((l) => l.model.trim())).size;
}

/**
 * A row is a review only when it carries a decision from a complete round: a row with no
 * decision is a half-written or crashed round, PARTIAL and UNREADABLE are not verdicts, and one
 * model is one opinion. The merge gate's completeRound is the same rule; a test compares them.
 */
function countsAsReview(row) {
  if (!row.decision || typeof row.decision.action !== 'string') return false;
  if (row.decision.reason === 'PARTIAL' || row.decision.reason === 'UNREADABLE') return false;
  return readLegs(row) >= MIN_REVIEW_LEGS;
}

/** The set of contentHashes with a complete document row (see countsAsReview); ENOENT home = empty. */
function reviewedHashes(ledgerHome, wanted = null) {
  let names;
  try {
    names = fs.readdirSync(ledgerHome).filter((f) => /^\d{4}-\d{2}\.ndjson$/.test(f));
  } catch (e) {
    if (e && e.code === 'ENOENT') return { hashes: new Set(), missing: true };
    throw e;
  }
  const hashes = new Set();
  for (const name of names) {
    if (Date.now() >= DEADLINE) throw budgetError();
    const text = fs.readFileSync(path.join(ledgerHome, name), 'utf8'); // an IO error here is DEGRADED
    for (const line of text.split('\n')) {
      if (Date.now() >= DEADLINE) throw budgetError();
      if (!line.trim()) continue;
      // Parse only lines naming a hash we need; a long ledger is mostly other rounds.
      if (wanted && !wanted.some((h) => line.includes(h))) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || !row.artifact || row.artifact.kind !== 'document') continue;
      if (!countsAsReview(row)) continue;
      if (typeof row.contentHash === 'string') hashes.add(row.contentHash);
    }
  }
  return { hashes, missing: false };
}

/** sha256 of a flagged goal's bytes, or DEGRADED when the file cannot be read (never a crash). */
function hashGoal(root, rel) {
  try {
    return { hash: sha256(fs.readFileSync(path.join(root, rel))) };
  } catch (e) {
    return { degraded: `goal file ${rel} could not be read: ${e && e.message ? e.message : e}` };
  }
}

function statePath(ledgerHome, sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  return path.join(ledgerHome, `wall-state-${safe}.json`);
}

function readState(file) {
  let text;
  try {
    if (!fs.existsSync(file)) return {};
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // UNREADABLE state (an IO error): the caller stands down
  }
  // CORRUPT state (unparseable or not an object) is not a reason to disarm the wall for the
  // session: it resets to an empty count and bounded blocking resumes; the
  // next successful write repairs the file.
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function breakGlass(root) {
  const abs = path.join(root, BREAK_GLASS);
  if (!fs.existsSync(abs)) return null;
  const tracked = git(root, ['ls-files', '--error-unmatch', '--', BREAK_GLASS]);
  return { path: BREAK_GLASS, committed: tracked.ok };
}

async function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return; // malformed input never traps the assistant
  }
  if (!input || typeof input !== 'object') return;

  const root = findRepoRoot();

  // Collect the wall's conditions: unpaid debts (per file) and/or a degraded state. EVERY
  // failure inside this phase, expected or not, becomes a degraded state that goes through
  // the brake below: nothing here may block without a budget, and nothing may crash into a
  // silent exit-1 pass.
  let degraded = null;
  let unpaid = [];
  let flaggedFiles = []; // goals differing from main, named in every degraded message too
  let ledgerHome = path.join(os.homedir(), '.tribunal', repoSlug(root));
  let goalsDir = path.join(root, GOALS_DIR);
  try {
    try {
      const { resolvePolicy } = await import('../scripts/policy.mjs');
      const policy = resolvePolicy(process.env.CLAUDE_PROJECT_DIR || process.cwd());
      if (policy.gates.goalWall === false) return;
      ledgerHome = policy.ledgerHome;
      goalsDir = policy.goalsDir;
    } catch (e) {
      degraded = `tribunal policy could not be resolved: ${e.message}`;
    }
    const glass = breakGlass(root);
    if (glass) {
      banner(`${PREFIX} BREAK-GLASS: ${glass.path} is present (${glass.committed ? 'committed' : 'loose, untracked'}); the goal wall stands aside. Delete it to restore the wall.\n`);
      return;
    }
    const flagged = degraded ? flaggedGoals(root, goalsDir) : null;
    if (flagged && !flagged.degraded) flaggedFiles = flagged.files;
    if (!degraded) {
      const flagged = flaggedGoals(root, goalsDir);
      if (flagged.degraded) {
        degraded = flagged.degraded;
      } else if (flagged.files.length) {
        flaggedFiles = flagged.files;
        const hashed = [];
        for (const rel of flagged.files) {
          const h = hashGoal(root, rel);
          if (h.degraded) { degraded = h.degraded; break; }
          hashed.push({ rel, hash: h.hash });
        }
        let reviewed;
        if (!degraded) {
          try {
            reviewed = reviewedHashes(ledgerHome, hashed.map((h) => h.hash));
          } catch (e) {
            degraded = `ledger at ${ledgerHome} could not be read: ${e.message}`;
          }
        }
        if (!degraded) {
          for (const { rel, hash } of hashed) {
            if (!reviewed.hashes.has(hash)) unpaid.push({ rel, hash, ledgerMissing: reviewed.missing });
          }
        }
      }
    }
  } catch (e) {
    degraded = `unexpected error while checking goals: ${e && e.message ? e.message : e}`;
  }
  if (!degraded && unpaid.length === 0) return; // nothing to say

  // Every degraded message still names what differs from main, so the reader knows which
  // goals went unverified even when the ledger could not answer.
  const goalsNote = () => (unpaid.length ? ` Unreviewed goals: ${unpaid.map((u) => u.rel).join(', ')}.` : flaggedFiles.length ? ` Goals differing from main, unverified: ${flaggedFiles.join(', ')}.` : '');

  // The brake: the wall's own per-session, per-(file,hash) counter.
  const sessionId = input.session_id || (typeof input.transcript_path === 'string' ? sha256(input.transcript_path).slice(0, 12) : 'unknown');
  const file = statePath(ledgerHome, sessionId);
  const state = readState(file);
  if (state === null) {
    banner(`${PREFIX} STAND-DOWN (UNVERIFIED): the wall's state file ${file} cannot be read, so bounded blocking is impossible this stop.${degraded ? ` Degraded: ${degraded}.` : ''}${goalsNote()} Fix the ledger home and re-run.\n`);
    return;
  }

  const keys = degraded ? ['DEGRADED'] : unpaid.map((u) => `${u.rel}|${u.hash}`);
  const blockable = keys.filter((k) => (state[k] || 0) < MAX_BLOCKS);
  if (!blockable.length) {
    banner(`${PREFIX} STAND-DOWN after ${MAX_BLOCKS} blocks this session for: ${keys.join(', ')}.${degraded ? ` Still degraded: ${degraded}.` : ''}${goalsNote()}${unpaid.length ? ' These goals reach the reply UNREVIEWED.' : ''}\n`);
    return;
  }
  for (const k of blockable) state[k] = (state[k] || 0) + 1;
  if (!writeState(file, state)) {
    banner(`${PREFIX} STAND-DOWN (UNVERIFIED): the wall's state file ${file} cannot be written, so bounded blocking is impossible this stop.${degraded ? ` Degraded: ${degraded}.` : ''}${goalsNote()}\n`);
    return;
  }

  const lines = [];
  if (degraded) {
    lines.push(`${PREFIX} BLOCKED, UNVERIFIED: the wall could not verify goal review because ${degraded}.${goalsNote()}`);
    lines.push('Fix the git state or the ledger and end the reply again.');
  } else {
    lines.push(`${PREFIX} BLOCKED: ${unpaid.length} goal file(s) differ from origin/main and have no complete panel row for their current content:`);
    for (const u of unpaid) lines.push(`  - ${u.rel}${u.ledgerMissing ? ' (ledger directory missing: run the isolation probe first)' : ''}`);
    lines.push('Clear it by running the panel on each file: /tribunal-review:review <file>  (CLI: the plugin runner with --file <file>), then end the reply again.');
  }
  lines.push(`Block ${Math.max(...blockable.map((k) => state[k]))} of ${MAX_BLOCKS} for this content this session; after ${MAX_BLOCKS} the wall stands down loudly. Break-glass: ${BREAK_GLASS}.`);
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch((e) => {
    // Only the BRAKE itself can throw here (the check phase converts its own errors into a
    // degraded state above). A brake that cannot run cannot bound anything, so this stands
    // down loudly rather than block without a budget or exit 1 as a silent pass.
    banner(`${PREFIX} STAND-DOWN (UNVERIFIED): the wall's own brake failed: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 0;
  });
}

module.exports = { parseStatusZ, flaggedGoals, reviewedHashes, readLegs, countsAsReview, MIN_REVIEW_LEGS, hashGoal, repoSlug, MAX_BLOCKS, GOALS_DIR, BREAK_GLASS };
