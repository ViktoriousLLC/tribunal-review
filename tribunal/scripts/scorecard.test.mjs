// Mutation targets: count incomplete rows, disable sameIssue matching, ignore marks,
// join by cluster id instead of judgeId, or include marks.ndjson in artifactHistory.
// Each changes a numerical assertion below, not just a snapshot of the implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildScorecard, renderScorecard, parseMark, validateMarks, readMarks, scorecardRunningLine } from "./scorecard.mjs";
import { artifactHistory, artifactKey, findingList } from "./run.mjs";
import { loneFindings, parseJudgement } from "./judge.mjs";
import { fromFile } from "./artifact.mjs";

const finding = (overrides = {}) => ({ id: "F1", title: "Ownership check permits record overwrite", severity: "SUGGESTION",
  category: "security", file: "record.js", line: 5, foundBy: ["opus"], ...overrides });
const row = (round, overrides = {}) => ({ ts: `2026-10-${String(round).padStart(2, "0")}T00:00:00Z`,
  artifact: { prNumber: 42 }, runnerRound: round, decision: { reason: "ACTIONABLE" },
  legs: [{ leg: "opus", model: "opus-one", findings: 2 }], findingList: [finding()], ...overrides });

test("scorecard counts findings only from complete rounds and reports incomplete and old rows", () => {
  const rows = [row(1), row(2, { decision: { reason: "PARTIAL" } }), row(3, { decision: { reason: "UNREADABLE" } }),
    row(4, { findingList: undefined }), row(5, { legs: [{ leg: "sol", model: "sol-one", findings: 3 }], findingList: [] })];
  const card = buildScorecard(rows);
  assert.equal(card.rounds, 5);
  assert.equal(card.complete, 3);
  assert.equal(card.skipped, 2);
  assert.equal(card.total, 7);
  assert.equal(card.models.opus.found, 4);
  assert.equal(card.models.sol.found, 3);
  assert.equal(card.unique, 1);
  assert.match(renderScorecard(card), /unique: not recorded for 1 round\(s\) banked before v0.13/);
});

test("scorecard matches across rounds in history order and keeps IDs when rows are appended", () => {
  const first = row(1), second = row(2, { legs: [{ leg: "sol", model: "sol-one", findings: 1 }],
    findingList: [finding({ foundBy: ["sol"], severity: "BLOCKER" })] });
  const third = row(3, { legs: [{ leg: "opus", model: "opus-two", findings: 1 }],
    findingList: [finding({ title: "Token expiry bypasses authentication", file: "auth.js" })] });
  const before = buildScorecard([second, first]);
  const after = buildScorecard([second, first, third]);
  assert.equal(before.unique, 1);
  assert.deepEqual(before.problems[0].foundBy, ["sol", "opus"]);
  assert.deepEqual(before.problems[0].rounds, [2, 1]);
  assert.deepEqual(before.problems[0].findings, [{ round: 2, id: "F1" }, { round: 1, id: "F1" }]);
  assert.equal(before.problems[0].severity, "BLOCKER");
  assert.equal(after.problems[0].id, before.problems[0].id);
  assert.equal(after.problems[1].id, "P2");
  assert.equal(after.models.opus.inProblems, 2);
  assert.equal(after.models.opus.sole, 1);
  assert.equal(after.models.sol.sole, 0);
  assert.deepEqual(after.models.opus.models, ["opus-one", "opus-two"]);
  assert.match(renderScorecard(after), /P1 \[BLOCKER\].*found by sol, opus/);
});

test("fix1 scorecard: backdated appended rows preserve problem IDs and marks", (t) => {
  const f = fixture(t), artifact = { prNumber: 42 };
  const before = buildScorecard(artifactHistory(artifact, f.ledger));
  const appended = row(3, { ts: "2020-01-01T00:00:00Z",
    findingList: [finding({ title: "Token expiry bypasses authentication", file: "auth.js" })] });
  // File names determine history order even when their timestamps disagree.
  writeFileSync(join(f.ledger, "2026-11.ndjson"), [appended,
    row(4, { ts: "2019-01-01", decision: { reason: "PARTIAL" } }),
    row(5, { ts: "2018-01-01", decision: { reason: "UNREADABLE" } }),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const after = buildScorecard(artifactHistory(artifact, f.ledger), [parseMark("P1:real")]);
  assert.deepEqual(after.problems.slice(0, 2).map(({ id, title }) => ({ id, title })),
    before.problems.map(({ id, title }) => ({ id, title })));
  assert.equal(after.problems[0].verdict, "real");
  assert.equal(after.problems[2].id, "P3");
  assert.equal(after.problems[2].title, appended.findingList[0].title);
  assert.equal(after.skipped, 2);
});

test("fix1 scorecard: stale mark titles warn but still apply, before the unmarked list", () => {
  const rows = [row(1), row(2, { findingList: [finding({ file: "other.js" })] })];
  const warning = `P1: marked "Old title" but P1 is now "${finding().title}"; re-mark it`;
  const card = buildScorecard(rows, [{ ...parseMark("P1:real"), title: "Old title" }]);
  assert.equal(card.real, 1);
  assert.deepEqual(card.warnings, [warning]);
  const rendered = renderScorecard(card);
  assert.ok(rendered.includes(warning));
  assert.ok(rendered.indexOf(warning) < rendered.indexOf("P2 [SUGGESTION]"));
  for (const mark of [parseMark("P1:real"), { ...parseMark("P1:real"), title: finding().title }]) {
    assert.deepEqual(buildScorecard(rows, [mark]).warnings, []);
  }
  assert.deepEqual(buildScorecard(rows, [{ ...parseMark("P1:real"), title: "Old title" },
    { ...parseMark("P1:real"), title: finding().title }]).warnings, []);
});

for (const [label, marks, warning] of [
  ["missing target", [parseMark("P1:duplicate=P9:Same"), parseMark("P2:duplicate=P1:Same")], /unknown duplicate target P9/],
  ["cycle", [parseMark("P1:duplicate=P2:Same"), parseMark("P2:duplicate=P1:Same")], /cycle/],
]) {
  test(`fix1 scorecard: stored duplicate ${label} stays unfolded and unmarked`, () => {
    const card = buildScorecard([row(1), row(2, { findingList: [finding({ file: "other.js", foundBy: ["sol"] })] })], marks);
    assert.equal(card.unique, 2);
    assert.equal(card.unmarked, 2);
    assert.equal(card.marked, 0);
    assert.deepEqual(card.problems.map((problem) => problem.duplicateOf), [null, null]);
    assert.deepEqual(card.problems.map((problem) => problem.verdict), [null, null]);
    assert.deepEqual(card.activeProblems.map((problem) => problem.foundBy), [["opus"], ["sol"]]);
    assert.equal(card.warnings.length, 2);
    for (const message of card.warnings) assert.match(message, warning);
  });
}

test("fix1 marks: validate only additions while checking cycles through stored marks", () => {
  const card = buildScorecard([row(1), row(2, { findingList: [finding({ file: "other.js" })] })]);
  const stored = [parseMark("P1:duplicate=P2:Same")];
  assert.throws(() => validateMarks(card, [parseMark("P2:duplicate=P1:Same")], stored), /cycle/);
  assert.doesNotThrow(() => validateMarks(card, [parseMark("P1:real")], [
    { id: "P9", verdict: "not-real", why: "" }, parseMark("P2:duplicate=P99:Stale"),
  ]));
  assert.throws(() => validateMarks(card, [{ id: "P1", verdict: "not-real", why: "" }]), /requires a why/);
});

test("latest marks win and duplicate chains fold evidence into the target's verdict", () => {
  const rows = [row(1), row(2, { legs: [{ leg: "sol", model: "sol", findings: 1 }], findingList: [finding({ file: "elsewhere.js", foundBy: ["sol"] })] }),
    row(3, { findingList: [finding({ file: "third.js" })] })];
  const marks = [parseMark("P1:not-real:Already handled"), parseMark("P1:real:Changed ownership check"),
    parseMark("P2:duplicate=P1:Same cause in another file"), parseMark("P3:duplicate=P2:Same cause")];
  const card = buildScorecard(rows, marks);
  assert.equal(card.unique, 1);
  assert.equal(card.real, 1);
  assert.equal(card.notReal, 0);
  assert.equal(card.marked, 1);
  assert.equal(card.unmarked, 0);
  assert.equal(card.models.sol.real, 1);
  assert.equal(card.models.opus.real, 1);
  assert.equal(card.models.opus.inProblems, 1);
  assert.equal(card.models.opus.sole, 0);
  assert.equal(card.problems[2].duplicateOf, "P1");
  assert.equal(card.problems.length, 3, "folded IDs remain addressable for corrections");
  const unsure = buildScorecard(rows, [...marks, parseMark("P1:unsure")]);
  assert.equal(unsure.unsure, 1);
  assert.equal(unsure.real, 0);
});

test("marks refuse missing reasons, unknown IDs, unknown targets and cycles", () => {
  const card = buildScorecard([row(1), row(2, { findingList: [finding({ file: "other.js" })] })]);
  assert.throws(() => parseMark("P1:not-real"), /requires a why/);
  assert.throws(() => parseMark("P1:duplicate=P2:  "), /requires a why/);
  assert.throws(() => validateMarks(card, [parseMark("P9:real")]), /valid ids: P1, P2/);
  assert.throws(() => validateMarks(card, [parseMark("P1:duplicate=P9:Same")]), /unknown duplicate target/);
  assert.throws(() => validateMarks(card, [parseMark("P1:duplicate=P2:Same"), parseMark("P2:duplicate=P1:Same")]), /cycle/);
  assert.equal(parseMark("P1:real:Fixed: the check").why, "Fixed: the check");
});

test("banked cluster IDs join the lone-only Judge IDs without attributing a verdict to consensus", () => {
  const clusters = [finding({ foundBy: ["opus", "sol"] }), finding({ file: "lone.js", severity: "BLOCKER" }),
    finding({ file: "nit.js", severity: "NIT" })];
  const list = findingList(clusters);
  const judge = parseJudgement([{ id: "F1", verdict: "demote" }], loneFindings(clusters));
  assert.deepEqual(list.map((entry) => entry.id), ["F1", "F2", "F3"]);
  assert.deepEqual(list.map((entry) => entry.judgeId), [null, "F1", null]);
  const card = buildScorecard([row(1, { findingList: list, judge })], [parseMark("P2:real:Fixed it")]);
  assert.equal(card.problems[0].judgeVerdicts.length, 0);
  assert.equal(card.problems[1].judgeVerdicts[0].verdict, "demote");
  assert.equal(card.judge.demotedButReal, 1);
  assert.match(renderScorecard(card), /1 demoted-but-real \(Judge wrong\)/);
});

test("judge checks count each problem once per verdict and retain both verdicts across rounds", () => {
  const rows = [row(1, { judge: { verdicts: [{ id: "F1", verdict: "keep" }] } }),
    row(2, { judge: { verdicts: [{ id: "F1", verdict: "demote" }] } }),
    row(3, { judge: { verdicts: [{ id: "F1", verdict: "demote" }] } })];
  assert.deepEqual(buildScorecard(rows, [parseMark("P1:not-real:Already safe")]).judge,
    { demotedButReal: 0, keptButNotReal: 1, demotedAndNotReal: 1, keptAndReal: 0, unmarked: 0 });
  assert.equal(buildScorecard(rows).judge.unmarked, 1);
  assert.equal(buildScorecard(rows, [parseMark("P1:real")]).judge.keptAndReal, 1);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tribunal-scorecard-test-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.ok(root.includes("tribunal-scorecard-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, ".git"));
  const ledger = join(root, "ledger");
  mkdirSync(ledger);
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify({ ledgerHome: ledger }));
  const rows = [row(1), row(2, { findingList: [finding({ file: "other.js" })] })];
  writeFileSync(join(ledger, "2026-10.ndjson"), rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const invoke = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL("./scorecard.mjs", import.meta.url)), ...args],
    { cwd: root, encoding: "utf8", timeout: 15000 });
  return { root, ledger, rows, invoke };
}

test("marks.ndjson never enters artifact history, even if it contains a ledger-shaped row", (t) => {
  const f = fixture(t), artifact = { prNumber: 42 };
  const before = artifactHistory(artifact, f.ledger);
  writeFileSync(join(f.ledger, "marks.ndjson"), JSON.stringify(row(3)) + "\n");
  assert.deepEqual(artifactHistory(artifact, f.ledger), before);
});

test("CLI resolves policy, appends scoped marks, prints the refreshed card and refuses bad arguments", (t) => {
  const f = fixture(t);
  const first = f.invoke("--pr", "42", "--mark", "P1:real:Fixed the check", "--mark", "P2:not-real:Already safe", "--json");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).real, 1);
  assert.equal(JSON.parse(first.stdout).notReal, 1);
  const stored = readMarks(f.ledger, "pr:42");
  assert.equal(stored.length, 2);
  assert.equal(stored[0].why, "Fixed the check");
  assert.ok(stored[0].ts);
  assert.equal(readMarks(f.ledger, "pr:43").length, 0);
  const second = f.invoke("--pr", "42", "--mark", "P2:duplicate=P1:Same issue", "--json");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).unique, 1);
  assert.equal(readMarks(f.ledger, "pr:42").at(-1).verdict, "duplicate:P1");
  const banked = readFileSync(join(f.ledger, "marks.ndjson"), "utf8");
  for (const args of [["--mark", "P1:not-real"], ["--mark", "P1:duplicate=P2"], ["--mark", "P9:real"],
    ["--mark", "P1:real", "--mark", "P9:real"], ["--mark", "P1:duplicate=P2:Cycle"], ["--unknown"], ["--file", "x"]]) {
    const result = f.invoke("--pr", "42", ...args);
    assert.equal(result.status, 4, result.stderr);
    if (args.includes("P9:real")) assert.match(result.stderr, /valid ids: P1, P2/);
    assert.equal(readFileSync(join(f.ledger, "marks.ndjson"), "utf8"), banked, "invalid batches append nothing");
  }
  for (const args of [[], ["--pr"], ["--pr", "bad"], ["--pr", "-1"]]) assert.equal(f.invoke(...args).status, 4);
});

test("CLI addresses file and source artifacts with the runner's exact source semantics", (t) => {
  const f = fixture(t), artifact = { kind: "document", source: "goals/test.md" };
  writeFileSync(join(f.ledger, "2026-10.ndjson"), JSON.stringify(row(1, { artifact })) + "\n");
  for (const args of [["--file", artifact.source], ["--source", artifact.source], ["--source", artifactKey(artifact)]]) {
    const result = f.invoke(...args, "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).total, 2);
  }
});

test("fix1 CLI: new marks store the current problem title", (t) => {
  const f = fixture(t);
  const result = f.invoke("--pr", "42", "--mark", "P1:real", "--mark", "P2:duplicate=P1:Same", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readMarks(f.ledger, "pr:42").map((mark) => mark.title), [finding().title, finding().title]);
});

test("fix1 CLI: bad stored marks can be corrected despite unrelated invalid marks", (t) => {
  const f = fixture(t);
  const stored = [
    { ...parseMark("P1:duplicate=P2:Same"), title: "Old title" },
    parseMark("P2:duplicate=P1:Same"), { id: "P99", verdict: "not-real", why: "" },
  ].map((mark) => ({ key: "pr:42", ...mark }));
  const previous = stored.map((mark) => JSON.stringify(mark)).join("\n") + "\n";
  writeFileSync(join(f.ledger, "marks.ndjson"), previous);
  const result = f.invoke("--pr", "42", "--mark", "P1:real:Corrected", "--json");
  assert.equal(result.status, 0, result.stderr);
  const card = JSON.parse(result.stdout);
  assert.equal(card.unique, 1);
  assert.equal(card.real, 1);
  assert.deepEqual(card.warnings, []);
  assert.ok(readFileSync(join(f.ledger, "marks.ndjson"), "utf8").startsWith(previous));
  assert.equal(readMarks(f.ledger, "pr:42").length, 4);
});

test("fix2 selector: a bare lowercase drive path is a document, not kind 'c'", (t) => {
  const f = fixture(t);
  const artifact = { kind: "document", source: "c:\\notes\\a.md" };
  writeFileSync(join(f.ledger, "2026-10.ndjson"), JSON.stringify(row(1, { artifact })) + "\n");
  const result = f.invoke("--source", "c:\\notes\\a.md", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).total, 2);
});

for (const artifact of [
  { kind: "document", source: "C:\\notes\\a:file.md" },
  { kind: "diff", source: "base:head" }, { kind: "stdin", source: null },
  { kind: "diff", source: null },
]) {
  test(`fix1 selector: ${artifactKey(artifact)} round-trips through the CLI`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.ledger, "2026-10.ndjson"), JSON.stringify(row(1, { artifact })) + "\n");
    const line = scorecardRunningLine(buildScorecard([row(1, { artifact })]), artifact);
    // Read it back the way a shell would: the text between the quotes, backslashes kept.
    const match = /--source '([^']*)'\)/.exec(line);
    assert.ok(match, line);
    const selector = match[1];
    assert.equal(selector, artifactKey(artifact));
    const result = f.invoke("--source", selector, "--mark", "P1:real", "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).total, 2);
    assert.equal(readMarks(f.ledger, artifactKey(artifact))[0].key, artifactKey(artifact));
  });
}

test("fix3 marks: a broken stored chain or a malformed stored mark never blocks a new mark", (t) => {
  const f = fixture(t);
  const ids = JSON.parse(f.invoke("--pr", "42", "--json").stdout).problems.map((p) => p.id);
  assert.ok(ids.length >= 2, `need two problems, got ${ids}`);
  const [a, b] = ids;
  writeFileSync(join(f.ledger, "marks.ndjson"), [
    { ts: "2026-10-28T00:00:00Z", key: "pr:42", id: a, verdict: `duplicate:${b}`, why: "x" },
    { ts: "2026-10-28T00:00:01Z", key: "pr:42", id: b, verdict: `duplicate:${a}`, why: "x" },
    { ts: "2026-10-28T00:00:02Z", key: "pr:42", id: a, verdict: 42 },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n");
  const fixed = f.invoke("--pr", "42", "--mark", `${a}:real:changed code`, "--json");
  assert.equal(fixed.status, 0, fixed.stderr);
  const card = JSON.parse(fixed.stdout);
  assert.equal(card.problems.find((p) => p.id === a).verdict, "real");
});

test("fix3 CLI: an empty history says so instead of an empty table", (t) => {
  const f = fixture(t);
  const result = f.invoke("--pr", "999999");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no review rounds are recorded/);
});

// Restoring double quotes fails the literal selector assertion: both shells expand $().
test("fix4 selector: source keys use literal single quotes", () => {
  const artifact = { kind: "document", source: 'C:\\notes\\$(echo expanded) $HOME `echo x` "draft".md' };
  const line = scorecardRunningLine(buildScorecard([row(1, { artifact })]), artifact);
  assert.ok(line.endsWith(`(node "${fileURLToPath(new URL("./scorecard.mjs", import.meta.url))}" --source '${artifactKey(artifact)}')`), line);
});

// The old formatter emits a pasteable command even when quotes or newlines break it.
test("fix4 selector: keys with a quote or newline print the non-pasteable hint", () => {
  for (const source of ["owner's.md", "owner’s.md", "first\nsecond.md", "first\r\nsecond.md", "first\rsecond.md"]) {
    const artifact = { kind: "document", source };
    const line = scorecardRunningLine(buildScorecard([row(1, { artifact })]), artifact);
    assert.ok(line.endsWith("(the key contains a quote, so type its selector by hand)"), line);
    assert.doesNotMatch(line, /--source/);
  }
});

// Without the leading newline, the next CLI read loses the new mark to the partial row.
test("fix4 marks: appending after an unterminated line preserves the new mark on reread", (t) => {
  const f = fixture(t), path = join(f.ledger, "marks.ndjson");
  for (const tail of ['{"key":"pr:42","id":', JSON.stringify({ key: "pr:42", id: "P2", verdict: "unsure" }), ""]) {
    const prefix = JSON.stringify({ key: "pr:42", id: "P1", verdict: "not-real" }) + "\n" + tail;
    writeFileSync(path, prefix);
    const result = f.invoke("--pr", "42", "--mark", "P1:real", "--json");
    assert.equal(result.status, 0, result.stderr);
    const stored = readFileSync(path, "utf8");
    assert.ok(stored.startsWith(prefix + (prefix.endsWith("\n") ? "" : "\n")));
    assert.equal(readMarks(f.ledger, "pr:42").at(-1).verdict, "real");
    const reread = f.invoke("--pr", "42", "--json");
    assert.equal(reread.status, 0, reread.stderr);
    assert.equal(JSON.parse(reread.stdout).real, 1);
  }
});

// Restoring the string-only check lets malformed verdicts override valid earlier marks.
test("fix4 marks: readMarks keeps only supported verdicts", (t) => {
  const f = fixture(t);
  const verdicts = ["real", "not-real", "unsure", "duplicate:P1", "duplicate:P123"];
  const invalid = ["", "REAL", "real\n", "real ", "bogus", "duplicate:", "duplicate:P0", "duplicate:P01", "duplicate:P-1", "duplicate:P1x", 42, null];
  writeFileSync(join(f.ledger, "marks.ndjson"), [...verdicts, ...invalid]
    .map((verdict) => JSON.stringify({ key: "pr:42", id: "P1", verdict })).join("\n") + "\n");
  assert.deepEqual(readMarks(f.ledger, "pr:42").map((mark) => mark.verdict), verdicts);
});

// Integration coverage for the existing identity rule: resolving --file to an absolute
// path breaks the banked relative source and makes the rounds assertion fail.
test("fix4 CLI: a relative fromFile artifact is found by the same relative --file path", (t) => {
  const f = fixture(t), path = join(f.root, "review.md");
  writeFileSync(path, "Review this local document.\n");
  const relativePath = "./review.md", originalCwd = process.cwd();
  let artifact;
  try {
    process.chdir(f.root);
    artifact = fromFile(relativePath);
  } finally { process.chdir(originalCwd); }
  assert.equal(artifact.source, relativePath);
  writeFileSync(join(f.ledger, "2026-10.ndjson"), JSON.stringify(row(1, { artifact })) + "\n");
  const result = f.invoke("--file", relativePath, "--json");
  assert.equal(result.status, 0, result.stderr);
  const card = JSON.parse(result.stdout);
  assert.equal(card.rounds, 1);
  assert.equal(card.total, 2);
});
