// Synthetic Stop events execute the REAL hook binary to verify blocking behavior.
// Read-only Git responses are stubbed; no fixture creates commits or changes Git state.
// Every fixture, fake home, runner temporary directory, and ledger stays in OS temp.
// Run: node --test tribunal/hooks/goal-wall.test.cjs
//
// Negative control (proves the rig distinguishes blocking from allowing):
//   GUARD_UNDER_TEST=<path to a do-nothing script> EXPECT_NO_GUARD=1 node --test <this file>
// must PASS with every blocking fixture observed as ALLOWED. If it does not, the rig would be
// green against an empty guard and proves nothing.
//
// Mutation coverage: HARDCODED_GOALS_DIR checks configured directories in C1-C3;
// GLOB_PATHSPEC requires literal magic in C5; CASE_SENSITIVE_PATHSPEC requires
// platform icase magic in C6. The separate negative control checks NO_WALL and
// rejects EMPTY_CONTROL_RUN: inherited Node test-worker context can skip the child suite.
// AUTO_WALL_UNREGISTERED and STALE_OPT_IN_DOCS are caught by R1; IGNORE_GOAL_WALL_OPT_OUT
// is caught by C7; STALE_REVIEW_COMMAND is caught by B1's exact clearing command.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');

const REAL_GUARD = path.join(__dirname, 'goal-wall.js');
const guardPath = process.env.GUARD_UNDER_TEST || REAL_GUARD;
const CONTROL = process.env.EXPECT_NO_GUARD === '1';
const BLOCK = CONTROL ? 0 : 2;

const GOALS = 'docs/reference/goals';
const PLUGIN_RUNNER = path.resolve(__dirname, '../scripts/run.mjs');
const FIXTURES = fs.mkdtempSync(path.join(tmpdir(), 'tribunal-goal-wall-test-'));
test.after(() => removeFixture(FIXTURES));

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** What Claude Code SHOWS on an exit-0 allow: the systemMessage in stdout JSON. stderr is not shown. */
function shown(r) {
  try { return JSON.parse(r.stdout || '{}').systemMessage || ''; } catch { return ''; }
}

// This preload intercepts ONLY read-only Git calls made by the spawned hook. Unknown Git
// operations fail rather than reaching a real executable, including all mutation commands.
const PRELOAD = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cp = require('node:child_process');
const original = cp.spawnSync;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function walk(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walk(path.join(dir, entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
}
cp.spawnSync = function (command, args, options) {
  if (command !== 'git') return original(command, args, options);
  const [flag, root, op, ...rest] = args;
  if (flag !== '-C') throw new Error('fixture requires Git -C');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, '.git-fixture.json'), 'utf8'));
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr) => ({ status: 1, stdout: '', stderr });
  const nul = (files) => files.length ? files.join('\0') + '\0' : '';
  const magic = /^:\(([^)]+)\)(.*)$/.exec(rest.at(-1));
  const literal = magic?.[1].split(',').includes('literal');
  const ignoreCase = magic?.[1].split(',').includes('icase');
  const pathspec = magic ? magic[2] : rest.at(-1);
  const requestedGoals = path.relative(root, path.resolve(root, pathspec)).replace(/\\/g, '/');
  const caseVariant = fixture.goals !== requestedGoals && fixture.goals.toLowerCase() === requestedGoals.toLowerCase();
  if (['status', 'diff', 'ls-files'].includes(op) && caseVariant && !ignoreCase) return ok();
  const goals = caseVariant && ignoreCase ? fixture.goals : requestedGoals;
  if (['status', 'diff', 'ls-files'].includes(op) && /[\[\]*?]/.test(pathspec) && !literal) return ok();
  const ignored = (rel) => fixture.ignored.some((entry) => rel === entry || rel.startsWith(entry + '/'));
  if (op === 'status') {
    if (fixture.status !== undefined) return ok(fixture.status);
    const entries = walk(path.join(root, goals)).map((rel) => goals + '/' + rel).filter((rel) =>
      !ignored(rel) && !fixture.committed.includes(rel)
      && (fixture.base[rel] === undefined || fs.readFileSync(path.join(root, rel), 'utf8') !== fixture.base[rel]));
    return ok(nul(entries.map((rel) => {
      if (fixture.base[rel] !== undefined) return ' M ' + rel;
      const below = rel.slice(goals.length + 1);
      return '?? ' + (!rest.includes('-uall') && below.includes('/') ? goals + '/' + below.split('/')[0] + '/' : rel);
    })));
  }
  if (op === 'diff') return fixture.withOrigin ? ok(nul(fixture.committed)) : fail('missing origin/main');
  if (op === 'ls-files' && rest.includes('--error-unmatch')) return fixture.glassTracked ? ok(rest.at(-1)) : fail('untracked');
  if (op === 'ls-files' && rest.includes('--ignored')) return ok(nul(walk(path.join(root, goals)).map((rel) => goals + '/' + rel).filter(ignored)));
  if (op === 'rev-parse' && rest.at(-1).startsWith('origin/main:')) {
    const rel = rest.at(-1).slice('origin/main:'.length);
    return fixture.base[rel] === undefined ? fail('not on main') : ok(hash(fixture.base[rel]));
  }
  if (op === 'hash-object') return ok(hash(fs.readFileSync(path.join(root, rest.at(-1)))));
  throw new Error('unstubbed Git call: ' + JSON.stringify(args));
};
`;

function gitFixture(root, patch) {
  const file = path.join(root, '.git-fixture.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...state, ...patch }));
}

/** A root marker, baseline Git responses, and isolated homes; no Git state is mutated. */
function mkRepo({ withOrigin = true, goals = GOALS } = {}) {
  const base = fs.mkdtempSync(path.join(FIXTURES, 'rig-'));
  const root = path.join(base, 'repo');
  const ledgerHome = path.join(base, 'ledger');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, goals), { recursive: true });
  const original = '# existing goal\n\nreviewed long ago\n';
  fs.writeFileSync(path.join(root, goals, 'existing.md'), original);
  fs.writeFileSync(path.join(root, 'tribunal.config.json'), JSON.stringify({ ledgerHome, ...(goals !== GOALS ? { goalsDir: goals } : {}) }));
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored-note.txt\n');
  fs.writeFileSync(path.join(root, '.git-fixture.json'), JSON.stringify({ withOrigin, goals,
    base: { [`${goals}/existing.md`]: original }, committed: [], ignored: [], glassTracked: false }));
  fs.writeFileSync(path.join(root, 'preload.cjs'), PRELOAD);
  fs.mkdirSync(path.join(base, 'home'));
  fs.mkdirSync(path.join(base, 'tmp'));
  return { base, root, ledgerHome, goals };
}

function fixtureEnv(root, extra = {}) {
  const base = path.dirname(root);
  return { ...process.env, CLAUDE_PROJECT_DIR: root, HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'),
    TMP: path.join(base, 'tmp'), TEMP: path.join(base, 'tmp'), TMPDIR: path.join(base, 'tmp'), ...extra };
}

function runHook(root, { sessionId = 'sess-1', stopHookActive = false, env = {}, guard = guardPath, cwd = root, input } = {}) {
  return spawnSync(process.execPath, ['--require', path.join(root, 'preload.cjs'), guard], {
    input: input ?? JSON.stringify({ session_id: sessionId, transcript_path: path.join(root, 't.jsonl'), stop_hook_active: stopHookActive, hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd,
    env: fixtureEnv(root, env),
  });
}

// Two counted legs that answered and parsed: the floor a row needs to count as a review.
const TWO_LEGS = [{ leg: 'a', model: 'm-a', answered: true, kind: 'answered', parseFailed: false }, { leg: 'b', model: 'm-b', answered: true, kind: 'answered', parseFailed: false }];

function bankRow(ledgerHome, contentHash, decision = { action: 'CONTINUE', reason: 'ACTIONABLE' }, legs = TWO_LEGS) {
  fs.mkdirSync(ledgerHome, { recursive: true });
  const row = { ts: new Date().toISOString(), artifact: { kind: 'document', source: `${GOALS}/x.md` }, contentHash, decision, runnerRound: 1, legs };
  fs.appendFileSync(path.join(ledgerHome, '2026-09.ndjson'), `${JSON.stringify(row)}\n`);
}

function dirtyGoal(root, name = 'existing.md', text = '# changed\n\nnew unreviewed content\n') {
  fs.writeFileSync(path.join(root, GOALS, name), text);
  return sha256(fs.readFileSync(path.join(root, GOALS, name)));
}

function removeFixture(target) {
  const root = path.resolve(FIXTURES);
  const resolved = path.resolve(target);
  assert.ok(root.startsWith(path.resolve(tmpdir()) + path.sep), 'fixture root stays under OS temp');
  assert.ok(resolved === root || resolved.startsWith(root + path.sep), 'delete only this run\'s fixtures');
  fs.rmSync(target, { recursive: true, force: true });
}
function cleanup(repo) { removeFixture(repo.base); }

// ---------------------------------------------------------------- blocking fixtures

test('B1 a dirty goal with no banked row blocks, naming the file and the clearing command', () => {
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) {
      assert.match(r.stderr, /BLOCKED/);
      assert.match(r.stderr, /existing\.md/);
      assert.match(r.stderr, /\/tribunal-review:review <file>/);
    }
  } finally { cleanup(repo); }
});

test('B2 a goal with only PARTIAL rows blocks exactly like one with none', () => {
  const repo = mkRepo();
  try {
    const hash = dirtyGoal(repo.root);
    bankRow(repo.ledgerHome, hash, { action: 'STOP', reason: 'PARTIAL' });
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
  } finally { cleanup(repo); }
});

test('B3 a goal written by an external command blocks (any write path is dirty)', () => {
  const repo = mkRepo();
  try {
    const written = spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "shell-written goal\\n")', path.join(repo.root, GOALS, 'shell.md')]);
    assert.equal(written.status, 0);
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
  } finally { cleanup(repo); }
});

test('B4 a goal hidden by a LOCAL COMMIT still blocks (differs from origin/main)', () => {
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    gitFixture(repo.root, { status: '', committed: [`${GOALS}/existing.md`] });
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
  } finally { cleanup(repo); }
});

test('B5 a goal inside a brand-new untracked DIRECTORY blocks (no directory collapse)', () => {
  const repo = mkRepo();
  try {
    fs.mkdirSync(path.join(repo.root, GOALS, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, GOALS, 'sub', 'new.md'), '# new\n');
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) assert.match(r.stderr, /sub\/new\.md/);
  } finally { cleanup(repo); }
});

test('B6 a gitignored goal file blocks (ignoring is not a hiding place)', () => {
  const repo = mkRepo();
  try {
    fs.appendFileSync(path.join(repo.root, '.gitignore'), `${GOALS}/secret.md\n`);
    gitFixture(repo.root, { ignored: [`${GOALS}/secret.md`] });
    fs.writeFileSync(path.join(repo.root, GOALS, 'secret.md'), '# hidden\n');
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
  } finally { cleanup(repo); }
});

test('B13 a goal inside a gitignored DIRECTORY blocks (ignored directories are swept file by file)', () => {
  const repo = mkRepo();
  try {
    fs.appendFileSync(path.join(repo.root, '.gitignore'), `${GOALS}/hidden/\n`);
    gitFixture(repo.root, { ignored: [`${GOALS}/hidden`] });
    fs.mkdirSync(path.join(repo.root, GOALS, 'hidden'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, GOALS, 'hidden', 'deep.md'), '# hidden in an ignored directory\n');
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) assert.match(r.stderr, /hidden\/deep\.md/);
  } finally { cleanup(repo); }
});

test('B14 a goals path that cannot be read as a directory is DEGRADED and blocks, never a silent pass', () => {
  const repo = mkRepo();
  try {
    fs.rmSync(path.join(repo.root, GOALS), { recursive: true, force: true });
    fs.writeFileSync(path.join(repo.root, GOALS), 'a file where the goals directory should be');
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) assert.match(r.stderr, /UNVERIFIED/);
  } finally { cleanup(repo); }
});

test('B15 a CORRUPT wall-state file resets the count and still blocks (it does not disarm the session)', () => {
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    fs.mkdirSync(repo.ledgerHome, { recursive: true });
    fs.writeFileSync(path.join(repo.ledgerHome, 'wall-state-sess-1.json'), '{ this is not json');
    const r = runHook(repo.root, { sessionId: 'sess-1' });
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) {
      const repaired = JSON.parse(fs.readFileSync(path.join(repo.ledgerHome, 'wall-state-sess-1.json'), 'utf8'));
      assert.equal(Object.values(repaired)[0], 1, 'the next write repairs the file with a real count');
    }
  } finally { cleanup(repo); }
});

test('B7 a MISSING ledger directory is an empty ledger and blocks (fresh machine gets the wall)', () => {
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    assert.ok(!fs.existsSync(repo.ledgerHome));
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) assert.match(r.stderr, /ledger directory missing/);
  } finally { cleanup(repo); }
});

test('B8 an IO error reading ledger rows is DEGRADED and blocks with the UNVERIFIED banner', () => {
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    fs.mkdirSync(path.join(repo.ledgerHome, '2026-09.ndjson'), { recursive: true }); // a directory where a row file should be
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) assert.match(r.stderr, /UNVERIFIED/);
  } finally { cleanup(repo); }
});

test('B9 stop_hook_active set by a SIBLING hook does not disarm the wall', () => {
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    const r = runHook(repo.root, { stopHookActive: true });
    assert.equal(r.status, BLOCK, r.stderr);
  } finally { cleanup(repo); }
});

test('B10 a RENAMED goal with a QUOTED path (spaces) is parsed and blocks', () => {
  const repo = mkRepo();
  try {
    fs.renameSync(path.join(repo.root, GOALS, 'existing.md'), path.join(repo.root, GOALS, 'goal with spaces.md'));
    // A small edit keeps git's similarity high enough to report a RENAME record, not D + A.
    fs.appendFileSync(path.join(repo.root, GOALS, 'goal with spaces.md'), 'one more unreviewed line\n');
    gitFixture(repo.root, { status: `R  ${GOALS}/goal with spaces.md\0${GOALS}/existing.md\0` });
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) assert.match(r.stderr, /goal with spaces\.md/);
  } finally { cleanup(repo); }
});

test('B11 a git failure (no origin/main ref) is DEGRADED and blocks with UNVERIFIED', () => {
  const repo = mkRepo({ withOrigin: false });
  try {
    dirtyGoal(repo.root);
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) assert.match(r.stderr, /UNVERIFIED/);
  } finally { cleanup(repo); }
});

// ---------------------------------------------------------------- passing fixtures

test('P1 a goals directory matching origin/main allows silently', () => {
  const repo = mkRepo();
  try {
    const r = runHook(repo.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.trim(), '');
  } finally { cleanup(repo); }
});

test('P2 a dirty goal with a complete banked row for its exact bytes allows', () => {
  const repo = mkRepo();
  try {
    const hash = dirtyGoal(repo.root);
    bankRow(repo.ledgerHome, hash);
    const r = runHook(repo.root);
    assert.equal(r.status, 0, r.stderr);
  } finally { cleanup(repo); }
});

test('P3 a DELETED goal is exempt (nothing left to review)', () => {
  const repo = mkRepo();
  try {
    fs.unlinkSync(path.join(repo.root, GOALS, 'existing.md'));
    const r = runHook(repo.root);
    assert.equal(r.status, 0, r.stderr);
  } finally { cleanup(repo); }
});

test('P4 a goal changed in a local commit but REVERTED in the tree equals main and allows', () => {
  const repo = mkRepo();
  try {
    const original = fs.readFileSync(path.join(repo.root, GOALS, 'existing.md'));
    dirtyGoal(repo.root);
    gitFixture(repo.root, { committed: [`${GOALS}/existing.md`] });
    fs.writeFileSync(path.join(repo.root, GOALS, 'existing.md'), original);
    const r = runHook(repo.root);
    assert.equal(r.status, 0, r.stderr);
  } finally { cleanup(repo); }
});

test('P5 a missing goals directory is clean, not an error', () => {
  const repo = mkRepo();
  try {
    fs.rmSync(path.join(repo.root, GOALS), { recursive: true, force: true });
    const r = runHook(repo.root);
    assert.equal(r.status, 0, r.stderr);
  } finally { cleanup(repo); }
});

test('P6 the brake: three blocks for the same content, then a loud stand-down; a new session blocks again; new content gets a fresh budget', () => {
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    for (let i = 1; i <= 3; i += 1) {
      const r = runHook(repo.root, { sessionId: 'sess-A' });
      assert.equal(r.status, BLOCK, `block ${i}: ${r.stderr}`);
    }
    const fourth = runHook(repo.root, { sessionId: 'sess-A' });
    assert.equal(fourth.status, 0, fourth.stderr);
    if (!CONTROL) assert.match(shown(fourth), /STAND-DOWN/);
    const fresh = runHook(repo.root, { sessionId: 'sess-B' });
    assert.equal(fresh.status, BLOCK, fresh.stderr);
    // Same session, CHANGED content: fresh budget for the new bytes.
    dirtyGoal(repo.root, 'existing.md', '# changed again\n');
    const again = runHook(repo.root, { sessionId: 'sess-A' });
    assert.equal(again.status, BLOCK, again.stderr);
  } finally { cleanup(repo); }
});

test('P7 break-glass present allows and says so, naming committed vs loose', () => {
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    fs.mkdirSync(path.join(repo.root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, '.claude', 'tribunal-wall-breakglass'), 'fixture maintainer: temporary override\n');
    const loose = runHook(repo.root);
    assert.equal(loose.status, 0, loose.stderr);
    if (!CONTROL) assert.match(shown(loose), /BREAK-GLASS.*loose/);
    gitFixture(repo.root, { glassTracked: true });
    const committed = runHook(repo.root);
    assert.equal(committed.status, 0, committed.stderr);
    if (!CONTROL) assert.match(shown(committed), /BREAK-GLASS.*committed/);
  } finally { cleanup(repo); }
});

test('P8 unwritable state stands down loudly instead of looping', () => {
  const repo = mkRepo();
  try {
    const hash = dirtyGoal(repo.root);
    bankRow(repo.ledgerHome, hash, { action: 'STOP', reason: 'PARTIAL' }); // debt exists, ledger readable
    fs.mkdirSync(path.join(repo.ledgerHome, 'wall-state-sess-1.json'), { recursive: true }); // a directory where the state file goes
    const r = runHook(repo.root, { sessionId: 'sess-1' });
    assert.equal(r.status, 0, r.stderr);
    if (!CONTROL) assert.match(shown(r), /STAND-DOWN/);
  } finally { cleanup(repo); }
});

test('B12 a ledger row with NO decision (half-written round) is not a review and blocks', () => {
  const repo = mkRepo();
  try {
    const hash = dirtyGoal(repo.root);
    fs.mkdirSync(repo.ledgerHome, { recursive: true });
    fs.appendFileSync(path.join(repo.ledgerHome, '2026-09.ndjson'), `${JSON.stringify({ artifact: { kind: 'document', source: 'x' }, contentHash: hash })}\n`);
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
  } finally { cleanup(repo); }
});

test('U1 hashGoal turns an unreadable goal into a DEGRADED result instead of throwing', () => {
  if (CONTROL) return;
  const { hashGoal } = require(REAL_GUARD);
  const repo = mkRepo();
  try {
    assert.equal(typeof hashGoal(repo.root, `${GOALS}/existing.md`).hash, 'string');
    const dir = hashGoal(repo.root, GOALS); // a directory: EISDIR on read
    assert.match(dir.degraded, /could not be read/);
    const missing = hashGoal(repo.root, `${GOALS}/vanished.md`);
    assert.match(missing.degraded, /could not be read/);
  } finally { cleanup(repo); }
});

test('R1 the bundled Stop hook blocks by default and README documents the config opt-out', () => {
  if (CONTROL) return;
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'hooks.json'), 'utf8'));
  const registered = bundled.hooks.Stop?.flatMap((entry) => entry.hooks || []).find((hook) => /goal-wall\.js/.test(hook.command));
  assert.ok(registered, 'the shipped goal wall must be registered as a Stop hook');
  assert.equal(registered.type, 'command');
  assert.equal(registered.timeout, 60); // room for the 40s own budget: a killed hook is a silent pass
  const resolved = registered.command.replace('${CLAUDE_PLUGIN_ROOT}', path.resolve(__dirname, '..').replace(/\\/g, '/'));
  const scriptPath = resolved.match(/"([^"]+goal-wall\.js)"/)[1];
  assert.equal(path.resolve(scriptPath), path.resolve(REAL_GUARD));
  const readme = fs.readFileSync(path.resolve(__dirname, '../../README.md'), 'utf8');
  assert.ok(/^## What runs automatically\r?$/m.test(readme), 'README must explain what runs automatically');
  const blocks = [...readme.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
  assert.ok(blocks.some((block) => block.gates?.goalWall === false), 'README must document gates.goalWall: false in tribunal.config.json');
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    const nodeOptions = `--require "${path.join(repo.root, 'preload.cjs').replace(/\\/g, '/')}"`;
    const r = spawnSync(resolved, { shell: true, input: JSON.stringify({ session_id: 'reg', transcript_path: 'x' }),
      encoding: 'utf8', cwd: repo.root, env: fixtureEnv(repo.root, { NODE_OPTIONS: nodeOptions }) });
    assert.equal(r.status, 2, `the registered command must block: ${r.stderr}`);
  } finally { cleanup(repo); }
});

test('W1 a linked worktree .git FILE identifies the root from the environment or a nested cwd', () => {
  const repo = mkRepo();
  try {
    removeFixture(path.join(repo.root, '.git'));
    fs.writeFileSync(path.join(repo.root, '.git'), 'gitdir: ../worktree-metadata\n');
    dirtyGoal(repo.root);
    for (const env of [{}, { CLAUDE_PROJECT_DIR: '' }]) {
      const r = runHook(repo.root, { cwd: path.join(repo.root, GOALS), env });
      assert.equal(r.status, BLOCK, r.stderr);
      if (!CONTROL) assert.match(r.stderr, /existing\.md/);
    }
  } finally { cleanup(repo); }
});

test('U2 a DEGRADED state goes through the BRAKE too: three UNVERIFIED blocks, then a stand-down, never unbounded', () => {
  if (CONTROL) return;
  const repo = mkRepo();
  try {
    // A readable home whose row file is a directory: the ledger read throws, the state file
    // beside it is still writable, so the brake can count.
    dirtyGoal(repo.root);
    fs.mkdirSync(path.join(repo.ledgerHome, '2026-09.ndjson'), { recursive: true });
    for (let i = 1; i <= 3; i += 1) {
      const r = runHook(repo.root, { sessionId: 'sess-U2' });
      assert.equal(r.status, 2, `block ${i}: ${r.stderr}`);
      assert.match(r.stderr, /UNVERIFIED/);
    }
    const fourth = runHook(repo.root, { sessionId: 'sess-U2' });
    assert.equal(fourth.status, 0, fourth.stderr);
    assert.match(shown(fourth), /STAND-DOWN/);
  } finally { cleanup(repo); }
});

test('U3 a home that can hold neither ledger nor state stands down on the FIRST stop, loudly (bounded counting is impossible)', () => {
  if (CONTROL) return;
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'bad-ledger-home'), 'not a directory');
    fs.writeFileSync(path.join(repo.root, 'tribunal.config.json'), JSON.stringify({ ledgerHome: 'bad-ledger-home' }));
    dirtyGoal(repo.root);
    const r = runHook(repo.root, { sessionId: 'sess-U3' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(shown(r), /STAND-DOWN/);
    assert.match(shown(r), /UNVERIFIED/);
    assert.match(shown(r), /existing\.md/); // the unreviewed goal is still NAMED
  } finally { cleanup(repo); }
});

test('C1 HARDCODED_GOALS_DIR: configured goalsDir blocks and banks its session state in policy ledgerHome', () => {
  const repo = mkRepo({ goals: 'planning/Goals With Spaces' });
  try {
    fs.writeFileSync(path.join(repo.root, repo.goals, 'existing.md'), '# configured goal changed\n');
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) {
      assert.match(r.stderr, /planning\/Goals With Spaces\/existing\.md/);
      assert.ok(fs.existsSync(path.join(repo.ledgerHome, 'wall-state-sess-1.json')));
    }
  } finally { cleanup(repo); }
});

test('C2 HARDCODED_GOALS_DIR: the former default directory is unrelated when goalsDir changes', () => {
  const repo = mkRepo({ goals: 'planning/goals' });
  try {
    fs.mkdirSync(path.join(repo.root, GOALS), { recursive: true });
    dirtyGoal(repo.root);
    const r = runHook(repo.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  } finally { cleanup(repo); }
});

test('C3 configured absolute goalsDir and nested CLAUDE_PROJECT_DIR resolve like the runner', () => {
  const repo = mkRepo({ goals: 'planning/goals' });
  try {
    fs.writeFileSync(path.join(repo.root, 'tribunal.config.json'), JSON.stringify({ ledgerHome: repo.ledgerHome,
      goalsDir: path.join(repo.root, repo.goals) }));
    fs.writeFileSync(path.join(repo.root, repo.goals, 'existing.md'), '# changed\n');
    const nested = path.join(repo.root, repo.goals);
    const r = runHook(repo.root, { cwd: repo.base, env: { CLAUDE_PROJECT_DIR: nested } });
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) assert.match(r.stderr, /planning\/goals\/existing\.md/);
  } finally { cleanup(repo); }
});

test('C4 malformed input allows silently', () => {
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    for (const input of ['', 'not JSON', 'null']) {
      const r = runHook(repo.root, { input });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
    }
  } finally { cleanup(repo); }
});

test('C5 GLOB_PATHSPEC: metacharacters in goalsDir are literal directory names', () => {
  const repo = mkRepo({ goals: 'planning/[drafts]' });
  try {
    fs.writeFileSync(path.join(repo.root, repo.goals, 'existing.md'), '# literal directory changed\n');
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) assert.match(r.stderr, /planning\/\[drafts\]\/existing\.md/);
  } finally { cleanup(repo); }
});

test('C6 CASE_SENSITIVE_PATHSPEC: configured casing follows case-insensitive platforms', {
  skip: !['win32', 'darwin'].includes(process.platform),
}, () => {
  const repo = mkRepo({ goals: 'planning/Goals' });
  try {
    fs.writeFileSync(path.join(repo.root, 'tribunal.config.json'), JSON.stringify({ ledgerHome: repo.ledgerHome,
      goalsDir: 'PLANNING/goals' }));
    fs.writeFileSync(path.join(repo.root, repo.goals, 'existing.md'), '# case variant goal\n');
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) assert.match(r.stderr, /planning\/Goals\/existing\.md/);
  } finally { cleanup(repo); }
});

test('C7 IGNORE_GOAL_WALL_OPT_OUT: gates.goalWall false allows unreviewed goals silently', () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo.root, 'tribunal.config.json'), JSON.stringify({ ledgerHome: repo.ledgerHome,
      gates: { goalWall: false } }));
    dirtyGoal(repo.root);
    const r = runHook(repo.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.ok(!fs.existsSync(path.join(repo.ledgerHome, 'wall-state-sess-1.json')), 'disabled wall must not consume the session brake');
  } finally { cleanup(repo); }
});

// Real runner integration: a fake CLI reports its version and deterministic review replies.
// The recorded probe is bound to that CLI path/version/argv with the current probe writer;
// an old unbound text-only PASS cannot accidentally bypass the runner's gate.
function runnerFixture(repo, { defaultHome = false } = {}) {
  const fakeBin = path.join(repo.base, 'fakebin');
  const fakeJs = path.join(fakeBin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.js');
  const replyFile = path.join(repo.base, 'reply.txt');
  fs.mkdirSync(path.dirname(fakeJs), { recursive: true });
  const source = `#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('goal-wall-fixture 1.0\\n');
else { process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(replyFile)}, 'utf8'))); }\n`;
  fs.writeFileSync(fakeJs, source);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\bin\\claude.js" %*\r\n');
  } else {
    fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexec node "$(dirname "$0")/node_modules/@anthropic-ai/claude-code/bin/claude.js" "$@"\n', { mode: 0o755 });
  }
  fs.writeFileSync(replyFile, JSON.stringify({ findings: [] }));
  const models = { legs: ['a', 'b', 'c'].map((leg) => ({ leg, id: `fake-${leg}`, vendor: 'anthropic',
    runner: 'claude-cli', billing: 'plan', envKeys: [], enabled: true })) };
  fs.writeFileSync(path.join(repo.root, 'rig-models.json'), JSON.stringify(models));
  fs.writeFileSync(path.join(repo.root, 'tribunal.config.json'), JSON.stringify({ modelsFile: 'rig-models.json',
    goalsDir: repo.goals, ...(defaultHome ? {} : { ledgerHome: repo.ledgerHome }) }));
  const inheritedPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const env = fixtureEnv(repo.root);
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${fakeBin}${path.delimiter}${inheritedPath}`;
  const url = (file) => JSON.stringify(pathToFileURL(path.resolve(__dirname, '../scripts', file)).href);
  const setup = path.join(repo.root, 'setup-probe.mjs');
  fs.writeFileSync(setup, `import { resolvePolicy } from ${url('policy.mjs')};
import { measureCliBinding } from ${url('isolationBinding.mjs')};
import { writeProbeRecord } from ${url('isolationProbe.mjs')};
const policy = resolvePolicy();
const bindings = { 'claude-cli': measureCliBinding(policy.registry[0]) };
await writeProbeRecord(policy, { claude: { verdict: 'PASS', why: 'deterministic fixture CLI' } }, { bindings });
process.stdout.write(JSON.stringify({ ledgerHome: policy.ledgerHome }));\n`);
  const setupResult = spawnSync(process.execPath, [setup], { cwd: repo.root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(setupResult.status, 0, `bound fixture probe must be written: ${setupResult.stderr}`);
  const { ledgerHome } = JSON.parse(setupResult.stdout);
  assert.ok(path.resolve(ledgerHome).startsWith(path.resolve(repo.base) + path.sep), 'runner ledger must remain in this fixture');
  return { env, replyFile, ledgerHome, run: () => spawnSync(process.execPath,
    [PLUGIN_RUNNER, '--file', `${repo.goals}/existing.md`], { cwd: repo.root, env, encoding: 'utf8', timeout: 20000 }) };
}

test('E2E real runner banks PARTIAL then complete rows; configured wall blocks then passes (hash agreement)', () => {
  if (CONTROL) return;
  const repo = mkRepo({ goals: 'planning/goals' });
  try {
    const fixture = runnerFixture(repo);
    fs.writeFileSync(path.join(repo.root, repo.goals, 'existing.md'), '# e2e goal\n\ncurrent bytes\n');
    fs.writeFileSync(fixture.replyFile, 'prose without findings JSON');
    const partial = fixture.run();
    assert.equal(partial.status, 1, `${partial.stdout}\n${partial.stderr}`);
    assert.match(`${partial.stdout}\n${partial.stderr}`, /PARTIAL/);
    assert.equal(runHook(repo.root, { env: fixture.env }).status, 2);
    fs.writeFileSync(fixture.replyFile, JSON.stringify({ findings: [] }));
    const complete = fixture.run();
    assert.equal(complete.status, 0, `${complete.stdout}\n${complete.stderr}`);
    const after = runHook(repo.root, { sessionId: 'after', env: fixture.env });
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stderr, '');
  } finally { cleanup(repo); }
});

test('E2E-DEFAULT runner and wall use the same default ledger home (slug parity)', () => {
  if (CONTROL) return;
  const repo = mkRepo();
  try {
    const fixture = runnerFixture(repo, { defaultHome: true });
    const expected = path.join(repo.base, 'home', '.tribunal', `${path.basename(repo.root)}-${sha256(path.resolve(repo.root)).slice(0, 8)}`);
    assert.equal(fixture.ledgerHome, expected);
    dirtyGoal(repo.root);
    const before = runHook(repo.root, { env: fixture.env });
    assert.equal(before.status, 2, before.stderr);
    assert.ok(fs.existsSync(path.join(expected, 'wall-state-sess-1.json')));
    const reviewed = fixture.run();
    assert.equal(reviewed.status, 0, `${reviewed.stdout}\n${reviewed.stderr}`);
    assert.ok(fs.readdirSync(expected).some((name) => name.endsWith('.ndjson')));
    const after = runHook(repo.root, { sessionId: 'after', env: fixture.env });
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stderr, '');
  } finally { cleanup(repo); }
});

test('V1 an allow banner reaches the user: stdout JSON systemMessage, nothing on stderr', () => {
  if (CONTROL) return;
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    fs.mkdirSync(path.join(repo.root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, '.claude', 'tribunal-wall-breakglass'), 'fixture\n');
    const glass = runHook(repo.root, { sessionId: 'sess-V1' });
    assert.equal(glass.status, 0);
    assert.equal(glass.stderr, '', 'stderr on exit 0 is not shown, so nothing may depend on it');
    assert.match(shown(glass), /BREAK-GLASS/);
    fs.rmSync(path.join(repo.root, '.claude', 'tribunal-wall-breakglass'));
    for (let i = 1; i <= 3; i += 1) assert.equal(runHook(repo.root, { sessionId: 'sess-V1' }).status, 2);
    const down = runHook(repo.root, { sessionId: 'sess-V1' });
    assert.equal(down.status, 0);
    assert.equal(down.stderr, '');
    assert.match(shown(down), /STAND-DOWN after 3 blocks/);
  } finally { cleanup(repo); }
});

test('T1 a check that runs out of its own time budget BLOCKS as UNVERIFIED instead of being killed into a pass', () => {
  const repo = mkRepo();
  try {
    dirtyGoal(repo.root);
    const r = runHook(repo.root, { sessionId: 'sess-T1', env: { TRIBUNAL_HOOK_BUDGET_MS: '0' } });
    assert.equal(r.status, BLOCK, r.stderr);
    if (!CONTROL) {
      assert.match(r.stderr, /UNVERIFIED/);
      assert.match(r.stderr, /budget/);
    }
  } finally { cleanup(repo); }
});

test('B13 one leg, an UNREADABLE round, or legs that failed to parse is not a review and blocks', () => {
  const one = [{ leg: 'a', model: 'm-a', answered: true, kind: 'answered', parseFailed: false }];
  const unparsed = [...one, { leg: 'b', model: 'm-b', answered: true, kind: 'answered', parseFailed: true }];
  for (const [decision, legs] of [
    [{ action: 'STOP', reason: 'QUIET' }, one],
    [{ action: 'STOP', reason: 'QUIET' }, unparsed],
    [{ action: 'STOP', reason: 'UNREADABLE' }, TWO_LEGS],
  ]) {
    const repo = mkRepo();
    try {
      const hash = dirtyGoal(repo.root);
      bankRow(repo.ledgerHome, hash, decision, legs);
      const r = runHook(repo.root);
      assert.equal(r.status, BLOCK, `${decision.reason} with ${legs.length} leg(s): ${r.stderr}`);
    } finally { cleanup(repo); }
  }
});

test('B14 two seats on one model are one opinion and block', () => {
  const repo = mkRepo();
  try {
    const hash = dirtyGoal(repo.root);
    bankRow(repo.ledgerHome, hash, { action: 'STOP', reason: 'QUIET' },
      [{ leg: 'opus', model: 'm1', answered: true, kind: 'answered', parseFailed: false }, { leg: 'fable', model: 'm1', answered: true, kind: 'answered', parseFailed: false }]);
    const r = runHook(repo.root);
    assert.equal(r.status, BLOCK, r.stderr);
  } finally { cleanup(repo); }
});
