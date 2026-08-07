// The feature-name check, hammered against real `codex features list` output.
import test from "node:test";
import assert from "node:assert/strict";
import { parseFeatureNames, missingFeatures } from "./scripts/check-codex-features.mjs";
import { CODEX_DISABLED_FEATURES } from "./eval-reviewer.mjs";

// Verbatim shape from codex-cli 0.144.5: `<name>  <status>  <enabled>`, whitespace-aligned.
const REAL = `apply_patch_freeform                 removed            false
browser_use                          stable             true
browser_use_external                 stable             true
browser_use_full_cdp_access          stable             true
code_mode_host                       stable             true
computer_use                         stable             true
enable_mcp_apps                      under development  false
hooks                                stable             true
image_generation                     stable             true
multi_agent                          stable             true
apps                                 stable             true
plugin_sharing                       stable             true
plugins                              stable             true
remote_plugin                        stable             true
shell_tool                           stable             true
skill_mcp_dependency_install         stable             true
tool_suggest                         stable             true
`;

test("every feature the reviewer disables is named by the pinned CLI", () => {
  assert.deepEqual(missingFeatures(REAL), [], "the shipped list must match the pinned CLI's own names");
  assert.ok(CODEX_DISABLED_FEATURES.length >= 16, "the list should not have quietly shrunk");
});

test("a renamed or removed feature is REPORTED, not ignored", () => {
  // The failure this exists for: a pin bump renames shell_tool, `--disable shell_tool`
  // becomes a no-op, and the leg reviews an untrusted diff with a shell.
  const bumped = REAL.replace("shell_tool  ", "exec_tool   ");
  assert.deepEqual(missingFeatures(bumped), ["shell_tool"]);
});

test("empty or garbled output yields no false pass", () => {
  assert.equal(parseFeatureNames("").size, 0);
  assert.equal(parseFeatureNames("   \n\n  ").size, 0);
  // An empty name set makes EVERY wanted feature missing, which is what the caller turns
  // into a loud "the check could not run" rather than a silent pass.
  assert.deepEqual(missingFeatures("", ["shell_tool"]), ["shell_tool"]);
});

test("the parser takes the NAME column, not the status", () => {
  const names = parseFeatureNames(REAL);
  assert.ok(names.has("shell_tool"));
  assert.equal(names.has("stable"), false, "the second column is a status, never a feature name");
  assert.equal(names.has("true"), false);
});
