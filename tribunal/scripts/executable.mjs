// One executable lookup for the runner, isolation probe, and doctor.
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

const regularFile = (path) => {
  try { return statSync(path).isFile(); } catch { return false; }
};
const executable = (path) => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
};

/** Resolve a native binary or a Windows npm shim without invoking a shell. */
export function resolveExe(cmd, { env = process.env, platform = process.platform,
  execPath = process.execPath, isFile = regularFile, canExecute = executable } = {}) {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const pathKey = windows ? Object.keys(env).find((key) => key.toLowerCase() === "path") : "PATH";
  const pathValue = env[pathKey] || "";
  const searchedDirs = pathValue ? pathValue.split(windows ? ";" : ":")
    .map((dir) => path.resolve(windows ? dir.replace(/^"|"$/g, "") : dir || ".")) : [];
  const found = (file, prefix = []) => ({ file, prefix, found: true, searchedDirs });
  for (const dir of searchedDirs) {
    const native = path.join(dir, windows ? `${cmd}.exe` : cmd);
    if (isFile(native) && (windows || canExecute(native))) return found(native);
    if (!windows || !isFile(path.join(dir, `${cmd}.cmd`))) continue;
    // Node refuses .cmd with shell:false; run its known npm entrypoint under this Node.
    const entries = cmd === "claude"
      ? [["@anthropic-ai", "claude-code", "cli.js"], ["@anthropic-ai", "claude-code", "bin", "claude.js"]]
      : cmd === "codex" ? [["@openai", "codex", "bin", "codex.js"]] : [];
    entries.push([cmd, "bin", `${cmd}.js`]);
    for (const parts of entries) {
      const js = path.join(dir, "node_modules", ...parts);
      if (isFile(js)) return found(execPath, [js]);
    }
  }
  // Preserve the runner's named spawn-error path; doctor uses found to report the lookup.
  return { file: cmd, prefix: [], found: false, searchedDirs };
}
