#!/usr/bin/env node
// Compare collected panel outputs without spending quota on new reviews.
//
// It does NOT dispatch anything. Collecting the runs is a deliberate, billed act; computing the
// verdict from them is not, and mixing the two would make it easy to re-roll a comparison until
// it passed. Feed it files, get a verdict.
//
// Usage:
//   node scripts/equivalence.mjs \
//     --ci-self <a.json> <b.json>      # two CI panels on ONE pull request: the noise floor
//     --pair <ci.json> <local.json>    # repeatable: CI versus local on the same pull request
//
// Each JSON file is either this tool's own --json output, or the base64 `eval-data:v1` blob out
// of a CI Tribunal comment, decoded. Both shapes are normalised below.
//
// Exit: 0 only on EQUIVALENT. UNMEASURABLE and DIVERGENT both exit 1, because "we could not
// measure it" must never read to a caller as "it passed".

import { readFileSync } from "node:fs";
import { siteAgreement, noiseFloor, equivalenceVerdict } from "./compare.mjs";

/**
 * Normalise either panel shape into a flat finding list.
 *
 * The CI blob calls them `agreed` plus `blindSpots` and carries `by` as a string or an array;
 * the local runner calls them `clusters` with `foundBy`. Neither carries a category on every
 * row, so a missing one is treated as `correctness` rather than dropped — dropping it would
 * quietly shrink both sides and inflate agreement.
 */
export function normalise(doc) {
  if (Array.isArray(doc?.clusters)) return doc.clusters.map((c) => ({ ...c, category: c.category || "correctness" }));
  const out = [];
  for (const f of [...(doc?.agreed || []), ...(doc?.blindSpots || [])]) {
    out.push({
      title: f.title,
      file: f.file || null,
      severity: String(f.severity || "BLOCKER").toUpperCase(),
      category: (f.category || "correctness").toLowerCase(),
      foundBy: Array.isArray(f.by) ? f.by : [f.by].filter(Boolean),
    });
  }
  return out;
}

const read = (p) => normalise(JSON.parse(readFileSync(p, "utf8")));

function collect(flag) {
  const groups = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== flag) continue;
    const a = process.argv[i + 1], b = process.argv[i + 2];
    if (!a || !b || a.startsWith("--") || b.startsWith("--")) throw new Error(`${flag} needs two file paths`);
    groups.push([a, b]);
  }
  return groups;
}

function main() {
  const selfPairs = collect("--ci-self").map(([a, b]) => [read(a), read(b)]);
  const crossPairs = collect("--pair").map(([a, b]) => [read(a), read(b)]);

  const nf = noiseFloor(selfPairs);
  const crossDetail = crossPairs.map(([ci, local]) => siteAgreement(ci, local));
  const verdict = equivalenceVerdict({ floor: nf.floor, crossScores: crossDetail.map((d) => d.score) });

  console.log("\nTribunal equivalence gate\n");
  console.log(`Noise floor (CI against itself): ${nf.floor == null ? "NOT MEASURED" : nf.floor.toFixed(2)} — ${nf.why}`);
  if (nf.scores) nf.scores.forEach((s, i) => console.log(`  self-pair ${i + 1}: ${s.toFixed(2)}`));
  console.log('\nCI versus local (agreement over defect SITES: same file, same category):');
  crossDetail.forEach((d, i) => console.log(`  pair ${i + 1}: ${d.score.toFixed(2)} (shared ${d.shared}, only CI ${d.onlyA}, only local ${d.onlyB})${d.note ? ` — ${d.note}` : ""}`));
  console.log(`\nVERDICT: ${verdict.verdict} — ${verdict.why}\n`);
  process.exitCode = verdict.ok ? 0 : 1;
}

main();
