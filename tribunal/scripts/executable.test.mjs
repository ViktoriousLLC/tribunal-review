// The shared resolver must return executable identity and lookup metadata so callers can
// distinguish a resolved binary from a missing command and diagnose PATH failures.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveExe } from "./executable.mjs";

// RED-FIRST mutation: return { file: cmd, prefix: [] } without searching PATH.
test("POSIX resolution names the first executable file and every searched directory", () => {
  const r = resolveExe("claude", { platform: "linux", env: { PATH: "/first:/second" },
    isFile: (path) => path === "/second/claude", canExecute: () => true });
  assert.equal(r.file, "/second/claude");
  assert.equal(r.found, true);
  assert.deepEqual(r.prefix, []);
  assert.deepEqual(r.searchedDirs, ["/first", "/second"]);
});

// RED-FIRST mutation: return { file: cmd, prefix: [] } without a detected-missing result.
test("a directory or non-executable file never counts as a POSIX executable", () => {
  for (const checks of [
    { isFile: () => false, canExecute: () => true },
    { isFile: () => true, canExecute: () => false },
  ]) {
    const r = resolveExe("codex", { platform: "linux", env: { PATH: "/bin" }, ...checks });
    assert.equal(r.found, false);
    assert.equal(r.file, "codex", "the runner can report its ordinary spawn failure");
    assert.deepEqual(r.searchedDirs, ["/bin"]);
  }
});

// RED-FIRST mutation: return { file: cmd, prefix: [] } for a Windows executable on PATH.
test("Windows resolves a native executable using case-insensitive PATH", () => {
  const r = resolveExe("gh", { platform: "win32", env: { Path: "C:\\one;C:\\two" },
    isFile: (path) => path === "C:\\two\\gh.exe" });
  assert.equal(r.file, "C:\\two\\gh.exe");
  assert.equal(r.found, true);
});

// RED-FIRST mutation: return { file: cmd, prefix: [] } instead of resolving npm entrypoints.
test("Windows npm shims resolve to Node plus the vendor's JavaScript entrypoint", () => {
  for (const [cmd, entry] of [
    ["claude", "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"],
    ["codex", "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"],
  ]) {
    const files = new Set([`C:\\npm\\${cmd}.cmd`, entry]);
    const r = resolveExe(cmd, { platform: "win32", env: { PATH: "C:\\npm" },
      execPath: "C:\\node\\node.exe", isFile: (path) => files.has(path) });
    assert.equal(r.found, true);
    assert.equal(r.file, "C:\\node\\node.exe");
    assert.deepEqual(r.prefix, [entry]);
  }
});
