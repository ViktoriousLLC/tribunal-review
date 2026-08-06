// Generate this repository's own Tribunal workflow from the shipped template.
//
// WHY THIS EXISTS. `templates/tribunal.yml` is what `tribunal init` copies into a
// consumer's repository. `.github/workflows/tribunal.yml` is the Tribunal reviewing its
// own pull requests. They must be the same file, and for a while they were two files
// maintained by hand — which went wrong twice in a single day: a figure was stripped from
// one copy and reported as removed while it stayed public in the other, and the
// pay-per-call route was added to the template while this repository's own workflow could
// not use it.
//
// So: one source, one generator, and a test that fails the build on drift. A copy is a
// weak form of generation, but it is the RIGHT strength here — `tribunal init` also just
// copies the template (bin/tribunal.mjs), so any transform applied here and not there
// would reintroduce the divergence this file exists to close.
//
// Usage:
//   node scripts/sync-workflow.mjs           write the workflow from the template
//   node scripts/sync-workflow.mjs --check   exit 1 if they differ, write nothing
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectInvocation, reportMisidentifiedEntrypoint } from "../entrypoint.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const TEMPLATE_PATH = join(ROOT, "templates", "tribunal.yml");
export const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "tribunal.yml");

/**
 * Read both copies as BYTES, not as parsed YAML.
 *
 * Comparing parsed YAML would call two files identical when only their comments differ,
 * and in this file the comments are half the product: they are where the credential rules
 * are explained to whoever installs it. The divergence that leaked a figure was a comment
 * divergence. So: bytes.
 *
 * Line endings are normalised first, and only for the comparison. A Windows checkout can
 * hand you CRLF on one file and LF on the other through .gitattributes alone, and a drift
 * test that fires on that is a test people learn to ignore.
 */
export function readPair() {
  const norm = (s) => s.replace(/\r\n/g, "\n");
  return {
    template: norm(readFileSync(TEMPLATE_PATH, "utf8")),
    workflow: norm(readFileSync(WORKFLOW_PATH, "utf8")),
  };
}

/** @returns {{ inSync: boolean, firstDifferingLine: number|null }} */
export function compare({ template, workflow }) {
  if (template === workflow) return { inSync: true, firstDifferingLine: null };
  const a = template.split("\n");
  const b = workflow.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { inSync: false, firstDifferingLine: i + 1 };
  }
  return { inSync: false, firstDifferingLine: null };
}

function main() {
  const check = process.argv.includes("--check");
  // An INSTALLED copy of this package has templates/ but no .github/, because npm does not
  // publish the repository's own workflows. There is nothing to compare, and no drift is
  // possible. Say that OUT LOUD and exit 0 rather than exiting 0 quietly: a check that
  // decided not to bind is exactly as invisible as a check that passed, and this package
  // spends most of its comments arguing that silence must never read as a clean result.
  if (!existsSync(WORKFLOW_PATH)) {
    console.log(
      "tribunal.yml drift check DID NOT RUN: no .github/workflows/tribunal.yml here, so this is an " +
        "installed package rather than the source checkout. Nothing was compared."
    );
    return;
  }
  const pair = readPair();
  const { inSync, firstDifferingLine } = compare(pair);
  if (inSync) {
    console.log("tribunal.yml: the workflow and the template are identical.");
    return;
  }
  if (check) {
    console.error(
      `::error title=Workflow drift::.github/workflows/tribunal.yml has diverged from templates/tribunal.yml` +
        (firstDifferingLine ? ` (first difference at line ${firstDifferingLine})` : "") +
        `. The template is the source. Run: npm run sync:workflow`
    );
    process.exit(1);
  }
  mkdirSync(dirname(WORKFLOW_PATH), { recursive: true });
  // Write the template's own bytes, so a difference in line endings on disk cannot
  // survive a sync and re-trip the check on the next run.
  writeFileSync(WORKFLOW_PATH, readFileSync(TEMPLATE_PATH));
  console.log("tribunal.yml: regenerated .github/workflows/tribunal.yml from templates/tribunal.yml.");
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  main();
  // Bare filename, not the path: argv[1] uses backslashes on Windows, so a
  // "scripts/sync-workflow.mjs" pattern would never match and the loud half would go quiet.
} else if (reportMisidentifiedEntrypoint(process.argv[1], import.meta.url, "sync-workflow.mjs")) {
  process.exit(1);
}
