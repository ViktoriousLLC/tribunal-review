// Does the PINNED Codex CLI still name every feature this package disables?
//
// `CODEX_DISABLED_FEATURES` is a list of sixteen STRINGS passed as `--disable <name>`. A
// string is a claim about a binary. A pin bump that renames or removes one leaves the GPT
// leg reviewing an untrusted diff with that capability switched back on, and nothing
// downstream says so: the CLI does not fail on a name it does not recognise, the unit
// tests only inspect the argv array this package builds, and the PR comment looks exactly
// the same either way. Silence would read as a clean boundary.
//
// So the install step asks the CLI for its own feature list and diffs it. Ten seconds, at
// install time, loud — the same treatment the Claude leg's flags get one step up. One leg
// checked and the other trusted is the shape of the bug that made this list necessary, so
// leaving it that way in the workflow would have been the same mistake one level higher.
//
// Usage: node scripts/check-codex-features.mjs <path to `codex features list` output>
import { readFileSync } from "node:fs";
import { CODEX_DISABLED_FEATURES } from "../eval-reviewer.mjs";
import { isDirectInvocation, reportMisidentifiedEntrypoint } from "../entrypoint.mjs";

/**
 * `codex features list` prints `<name> <status> <enabled>`, whitespace-aligned. Take the
 * first token of each non-empty line. Pure, so the parsing is unit-tested rather than
 * trusted to a shell pipeline.
 */
export function parseFeatureNames(stdout) {
  return new Set(
    String(stdout || "")
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean)
  );
}

/** @returns {string[]} the disabled features this CLI version does not name */
export function missingFeatures(stdout, wanted = CODEX_DISABLED_FEATURES) {
  const known = parseFeatureNames(stdout);
  return wanted.filter((f) => !known.has(f));
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.log("::error title=Codex feature check::needs the path to `codex features list` output.");
    process.exit(1);
  }
  let out;
  try {
    out = readFileSync(path, "utf8");
  } catch (e) {
    console.log(`::error title=Codex feature check::could not read ${path}: ${String(e?.message || e)}`);
    process.exit(1);
  }
  // An EMPTY list is not a pass. It means the command printed nothing, and a check that
  // could not run must say so rather than exit zero next to the ones that did.
  if (parseFeatureNames(out).size === 0) {
    console.log("::error title=Codex feature check::`codex features list` produced no feature names. The check could not run, so it is reporting that rather than passing.");
    process.exit(1);
  }
  const missing = missingFeatures(out);
  if (missing.length) {
    console.log(
      `::error title=Codex feature names drifted::${missing.join(", ")} — this CLI version does not name them, so the reviewer is disabling nothing when it passes them. Re-read CODEX_DISABLED_FEATURES against 'codex features list' for this pin.`
    );
    process.exit(1);
  }
  console.log(`Codex names all ${CODEX_DISABLED_FEATURES.length} of the features the reviewer disables.`);
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  main();
  // Bare filename, not the path: argv[1] uses backslashes on Windows.
} else if (reportMisidentifiedEntrypoint(process.argv[1], import.meta.url, "check-codex-features.mjs")) {
  process.exit(1);
}
