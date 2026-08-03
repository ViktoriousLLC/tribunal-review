// Was this module run as a script, or imported?
//
// One shared answer, because getting it wrong is silent. Three files in this package
// each had their own copy of `import.meta.url === pathToFileURL(process.argv[1]).href`,
// and npm SYMLINKS a package installed from a local path, a git ref, or `npm link`. Under
// a symlink `process.argv[1]` is the link and `import.meta.url` is the target, so all
// three compared unequal, none of them ran, and every one of them exited 0.
//
// That is not an abstract risk. On the first real end-to-end dispatch of this package the
// reviewer exited 0 in 64 milliseconds having posted nothing, and the credential seeder
// reported success without writing the file, which left the GPT leg failing on a
// CODEX_HOME that had never been created. Three green steps, no work done.
//
// So: resolve BOTH sides to real paths, and never let "I could not tell" mean "do
// nothing quietly".

import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

/**
 * @param argv1     process.argv[1] from the calling module
 * @param moduleUrl import.meta.url from the calling module
 * @param resolve   seam for tests; defaults to fs.realpathSync
 */
export function isDirectInvocation(argv1, moduleUrl, resolve = realpathSync) {
  if (!argv1) return false;
  try {
    return pathToFileURL(resolve(argv1)).href === pathToFileURL(resolve(fileURLToPath(moduleUrl))).href;
  } catch {
    // A path that cannot be resolved is not evidence either way, so fall back to the raw
    // comparison rather than silently deciding not to run.
    return moduleUrl === pathToFileURL(argv1).href;
  }
}

/**
 * The loud half. Call when `isDirectInvocation` said no but the script name says the file
 * was clearly run on purpose: that can only be a resolution problem, and a tool that
 * cannot tell whether it is the entry point must not exit quietly.
 *
 * @returns true when it reported a contradiction (the caller should exit non-zero)
 */
export function reportMisidentifiedEntrypoint(argv1, moduleUrl, filename, log = console.error) {
  if (!argv1 || !new RegExp(`${filename.replace(/\./g, "\\.")}$`).test(argv1)) return false;
  log(
    `::error title=${filename} did not run::${filename} was executed directly but did not recognise itself as ` +
      `the entry point, so it did nothing. argv[1]=${argv1} import.meta.url=${moduleUrl}`
  );
  return true;
}
