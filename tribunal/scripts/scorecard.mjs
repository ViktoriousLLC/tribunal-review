#!/usr/bin/env node
// Append-only review evidence and operator marks, joined without changing earlier problem IDs.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sameIssue } from "./panelLogic.mjs";
import { artifactHistory, artifactKey } from "./ledger.mjs";
import { resolvePolicy } from "./policy.mjs";

const SEVERITY_RANK = { BLOCKER: 3, SUGGESTION: 2, NIT: 1 };
const union = (a, b) => [...new Set([...a, ...b])];

function addEvidence(problem, finding, round, verdicts) {
  if ((SEVERITY_RANK[finding.severity] || 0) > (SEVERITY_RANK[problem.severity] || 0)) problem.severity = finding.severity;
  problem.foundBy = union(problem.foundBy, finding.foundBy || []);
  if (!problem.rounds.includes(round)) {
    problem.rounds.push(round);
    problem.findings.push({ round, id: finding.id });
  }
  problem.judgeVerdicts.push(...verdicts.map((verdict) => ({ ...verdict, round })));
}

function latestMarks(marks) {
  return new Map(marks.map((mark) => [mark.id, mark]));
}

function duplicateRoot(id, marks, valid) {
  const seen = new Set();
  while (typeof marks.get(id)?.verdict === "string" && marks.get(id).verdict.startsWith("duplicate:")) {
    if (seen.has(id)) throw new Error("duplicate marks must not form a cycle");
    seen.add(id);
    id = marks.get(id).verdict.slice("duplicate:".length);
    if (!valid.has(id)) throw new Error(`unknown duplicate target ${id}; valid ids: ${[...valid].join(", ")}`);
  }
  return id;
}

export function buildScorecard(rows, marks = []) {
  const complete = rows.filter((row) => !["PARTIAL", "UNREADABLE"].includes(row.decision?.reason));
  const models = new Map(), problems = [];
  let total = 0, legacyRounds = 0;
  for (const [index, row] of complete.entries()) {
    for (const leg of row.legs || []) {
      if (!models.has(leg.leg)) models.set(leg.leg, { models: [], found: 0, inProblems: 0, sole: 0, real: 0, notReal: 0 });
      const model = models.get(leg.leg);
      if (leg.model) model.models = union(model.models, [leg.model]);
      model.found += leg.findings || 0;
      total += leg.findings || 0;
    }
    if (!Array.isArray(row.findingList)) { legacyRounds += 1; continue; }
    const round = row.runnerRound ?? row.round ?? index + 1;
    for (const finding of row.findingList) {
      let problem = problems.find((entry) => sameIssue(entry, finding));
      if (!problem) {
        problem = { id: `P${problems.length + 1}`, title: finding.title, severity: finding.severity,
          file: finding.file, rounds: [], foundBy: [], findings: [], judgeVerdicts: [] };
        problems.push(problem);
      }
      const judgeId = Object.hasOwn(finding, "judgeId") ? finding.judgeId : finding.id;
      const verdicts = (row.judge?.verdicts || []).filter((verdict) => judgeId != null && verdict.id === judgeId);
      addEvidence(problem, finding, round, verdicts);
    }
  }
  const latest = latestMarks(marks), valid = new Set(problems.map((problem) => problem.id));
  const roots = new Map(), warnings = [];
  for (const problem of problems) {
    const mark = latest.get(problem.id);
    if (mark && Object.hasOwn(mark, "title") && mark.title !== problem.title) {
      warnings.push(`${problem.id}: marked "${mark.title}" but ${problem.id} is now "${problem.title}"; re-mark it`);
    }
    let root = problem.id, invalid = false;
    try { root = duplicateRoot(problem.id, latest, valid); }
    catch (error) {
      invalid = true;
      warnings.push(`${problem.id}: ${error.message}; left unmarked and unfolded; re-mark it`);
    }
    roots.set(problem.id, root);
    problem.verdict = invalid ? null : mark?.verdict ?? null;
    problem.why = invalid ? "" : mark?.why ?? "";
    problem.duplicateOf = root === problem.id ? null : root;
  }
  const folded = new Map();
  for (const problem of problems) {
    const root = roots.get(problem.id);
    if (!folded.has(root)) {
      const target = problems.find((entry) => entry.id === root);
      folded.set(root, { ...target, rounds: [], foundBy: [], findings: [], judgeVerdicts: [],
        duplicateOf: null });
    }
    const target = folded.get(root);
    if ((SEVERITY_RANK[problem.severity] || 0) > (SEVERITY_RANK[target.severity] || 0)) target.severity = problem.severity;
    target.rounds = union(target.rounds, problem.rounds);
    target.foundBy = union(target.foundBy, problem.foundBy);
    target.findings.push(...problem.findings);
    target.judgeVerdicts.push(...problem.judgeVerdicts);
  }
  const active = [...folded.values()];
  const count = (verdict) => active.filter((problem) => problem.verdict === verdict).length;
  const judge = { demotedButReal: 0, keptButNotReal: 0, demotedAndNotReal: 0, keptAndReal: 0, unmarked: 0 };
  for (const problem of active) {
    for (const leg of problem.foundBy) {
      const model = models.get(leg);
      if (!model) continue;
      model.inProblems += 1;
      if (problem.foundBy.length === 1) model.sole += 1;
      if (problem.verdict === "real") model.real += 1;
      if (problem.verdict === "not-real") model.notReal += 1;
    }
    const verdicts = new Set(problem.judgeVerdicts.map((entry) => entry.verdict));
    if (!verdicts.has("demote") && !verdicts.has("keep")) continue;
    if (problem.verdict === "real") {
      if (verdicts.has("demote")) judge.demotedButReal += 1;
      if (verdicts.has("keep")) judge.keptAndReal += 1;
    } else if (problem.verdict === "not-real") {
      if (verdicts.has("demote")) judge.demotedAndNotReal += 1;
      if (verdicts.has("keep")) judge.keptButNotReal += 1;
    } else judge.unmarked += 1;
  }
  return { rounds: rows.length, complete: complete.length, skipped: rows.length - complete.length,
    total, legacyRounds, uniqueNote: legacyRounds ? `unique: not recorded for ${legacyRounds} round(s) banked before v0.13` : null,
    unique: active.length, real: count("real"), notReal: count("not-real"), unsure: count("unsure"),
    unmarked: count(null), marked: active.length - count(null), models: Object.fromEntries(models),
    problems, activeProblems: active, judge, warnings };
}

export function renderScorecard(card) {
  if (!card.rounds) return "PR scorecard: no review rounds are recorded under this key. Use the selector the runner printed after the round, or the exact --pr / --file you reviewed.";
  const lines = [`PR scorecard: ${card.rounds} rounds, ${card.complete} complete; ${card.skipped} incomplete skipped`,
    "model | found | unique | sole | real | not real"];
  for (const [leg, model] of Object.entries(card.models)) {
    lines.push(`${leg}${model.models.length ? ` (${model.models.join(", ")})` : ""} | ${model.found} | ${model.inProblems} | ${model.sole} | ${model.real} | ${model.notReal}`);
  }
  lines.push(`Totals: ${card.total} findings, ${card.unique} unique problems, ${card.real} real, ${card.notReal} not real, ${card.unsure} unsure, ${card.unmarked} unmarked`);
  if (card.uniqueNote) lines.push(card.uniqueNote);
  const j = card.judge;
  lines.push(`Judge: ${j.demotedButReal} demoted-but-real (Judge wrong), ${j.keptButNotReal} kept-but-not-real, ${j.demotedAndNotReal} demoted-and-not-real, ${j.keptAndReal} kept-and-real, ${j.unmarked} unmarked/unsure`);
  for (const warning of card.warnings) lines.push(`Warning: ${warning}`);
  for (const problem of card.activeProblems.filter((entry) => entry.verdict === null)) {
    lines.push(`${problem.id} [${problem.severity}] ${problem.title} (${problem.file || "no file"}) - found by ${problem.foundBy.join(", ")}`);
  }
  return lines.join("\n");
}

export function readMarks(ledgerHome, key) {
  let text;
  try { text = readFileSync(join(ledgerHome, "marks.ndjson"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return text.split("\n").filter((line) => line.trim()).flatMap((line) => {
    // A row without a string id and verdict is not a mark; skipping it keeps one bad line from
    // breaking the scorecard or blocking the correction that would replace it.
    try {
      const mark = JSON.parse(line);
      return mark?.key === key && typeof mark.id === "string" && typeof mark.verdict === "string"
        && /^(?:real|not-real|unsure|duplicate:P[1-9]\d*)$/.test(mark.verdict) ? [mark] : [];
    }
    catch { return []; } // A partial final append does not hide earlier marks.
  });
}

export function parseMark(text) {
  const match = /^(P[1-9]\d*):(real|not-real|unsure|duplicate=P[1-9]\d*)(?::([\s\S]*))?$/.exec(text);
  if (!match) throw new Error("mark must be P<n>:real|not-real|duplicate=P<n>|unsure[:why]");
  const verdict = match[2].replace("duplicate=", "duplicate:"), why = (match[3] || "").trim();
  if ((verdict === "not-real" || verdict.startsWith("duplicate:")) && !why) throw new Error(`${verdict} requires a why reason`);
  return { id: match[1], verdict, why };
}

export function validateMarks(card, additions, stored = []) {
  const valid = new Set(card.problems.map((problem) => problem.id));
  for (const mark of additions) {
    if (!valid.has(mark.id)) throw new Error(`unknown id ${mark.id}; valid ids: ${[...valid].join(", ") || "none"}`);
    parseMark(`${mark.id}:${mark.verdict.replace("duplicate:", "duplicate=")}:${mark.why || ""}`);
    if (mark.verdict.startsWith("duplicate:") && !valid.has(mark.verdict.slice("duplicate:".length))) {
      throw new Error(`unknown duplicate target ${mark.verdict.slice("duplicate:".length)}; valid ids: ${[...valid].join(", ")}`);
    }
  }
  // Refuse only a cycle THIS addition closes. A broken stored chain (a cycle or a missing target
  // that an older mark left) just ends the walk, so it can never block a correction.
  const latest = latestMarks([...stored, ...additions]);
  for (const mark of additions) {
    const seen = new Set([mark.id]);
    let id = mark.id;
    while (typeof latest.get(id)?.verdict === "string" && latest.get(id).verdict.startsWith("duplicate:")) {
      id = latest.get(id).verdict.slice("duplicate:".length);
      if (id === mark.id) throw new Error(`${mark.id}: duplicate marks must not form a cycle`);
      if (seen.has(id) || !valid.has(id)) break;
      seen.add(id);
    }
  }
}

export function scorecardRunningLine(card, artifact) {
  const label = artifact.prNumber != null ? `PR #${artifact.prNumber}` : artifact.title || artifact.source || "artifact";
  const key = artifactKey(artifact);
  const selector = artifact.prNumber != null ? `--pr ${artifact.prNumber}`
    // PowerShell also closes a single-quoted string on the typographic quotes U+2018 to U+201B.
    : /['‘-‛\r\n]/.test(key) ? null : `--source '${key}'`;
  const command = selector === null ? "(the key contains a quote, so type its selector by hand)"
    // The full path: reviews run from the reviewed repository, not from this plugin's folder.
    : `(node "${fileURLToPath(import.meta.url)}" ${selector})`;
  return `[scorecard] ${label} so far: ${card.total} findings, ${card.unique} unique problems, ${card.marked} of ${card.unique} marked ${command}${card.uniqueNote ? `; ${card.uniqueNote}` : ""}`;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = {}, markTexts = [];
    for (let i = 0; i < argv.length; i += 1) {
      const name = argv[i];
      if (name === "--json") { options.json = true; continue; }
      if (!["--pr", "--file", "--source", "--mark"].includes(name)) throw new Error(`unknown argument: ${name}`);
      const value = argv[++i];
      if (!value?.trim() || value.startsWith("--")) throw new Error(`${name} requires a value`);
      if (name === "--mark") markTexts.push(value);
      else {
        if (options[name]) throw new Error(`${name} may only be given once`);
        options[name] = value;
      }
    }
    if (["--pr", "--file", "--source"].filter((key) => options[key]).length !== 1) throw new Error("give exactly one of --pr <n>, --file <path>, or --source <kind:source>");
    let artifact;
    if (options["--pr"]) {
      if (!/^[1-9]\d*$/.test(options["--pr"]) || !Number.isSafeInteger(Number(options["--pr"]))) throw new Error("--pr requires a positive integer");
      artifact = { prNumber: Number(options["--pr"]) };
    } else if (options["--file"]) artifact = { kind: "document", source: options["--file"] };
    else {
      const source = options["--source"];
      // Two letters or more: a bare `c:\notes\a.md` is a drive letter, not an artifact kind.
      const match = /^([a-z]{2,}):([\s\S]*)$/.exec(source);
      artifact = match ? { kind: match[1], source: match[2] } : { kind: "document", source };
    }
    const policy = resolvePolicy(process.cwd()), key = artifactKey(artifact);
    const rows = artifactHistory(artifact, policy.ledgerHome), marks = readMarks(policy.ledgerHome, key);
    let card = buildScorecard(rows, marks);
    const additions = markTexts.map((text) => {
      const mark = parseMark(text);
      return { ts: new Date().toISOString(), key, ...mark,
        title: card.problems.find((problem) => problem.id === mark.id)?.title };
    });
    if (additions.length) {
      validateMarks(card, additions, marks);
      card = buildScorecard(rows, [...marks, ...additions]);
      mkdirSync(policy.ledgerHome, { recursive: true });
      const marksPath = join(policy.ledgerHome, "marks.ndjson");
      let leading = "";
      try { if (!readFileSync(marksPath, "utf8").endsWith("\n")) leading = "\n"; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      appendFileSync(marksPath, leading + additions.map((mark) => JSON.stringify(mark)).join("\n") + "\n", "utf8");
    }
    console.log(options.json ? JSON.stringify(card, null, 2) : renderScorecard(card));
  } catch (error) { console.error(`scorecard: ${error.message}`); process.exitCode = 4; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
