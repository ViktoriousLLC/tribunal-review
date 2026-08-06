// The drift gate, as a test rather than only as a script.
//
// `templates/tribunal.yml` is what `tribunal init` copies into your repository.
// `.github/workflows/tribunal.yml` is the Tribunal reviewing its own pull requests. When
// those were two hand-maintained files they diverged twice in one day, and one of the
// divergences left a figure public in the copy nobody re-read. This fails the build.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readPair, compare, WORKFLOW_PATH, TEMPLATE_PATH } from "./scripts/sync-workflow.mjs";

test("the repository's own workflow is byte-identical to the shipped template", (t) => {
  assert.ok(existsSync(TEMPLATE_PATH), "templates/tribunal.yml is the source and must exist");
  if (!existsSync(WORKFLOW_PATH)) {
    // Announced, never silent. npm does not publish .github/, so an installed copy has
    // nothing to compare — which is a different statement from "compared and matched",
    // and the reader is told which one this is.
    t.diagnostic("no .github/workflows/tribunal.yml present: installed package, not the source checkout. NOTHING WAS COMPARED.");
    return;
  }
  const { inSync, firstDifferingLine } = compare(readPair());
  assert.ok(
    inSync,
    `.github/workflows/tribunal.yml has drifted from templates/tribunal.yml` +
      (firstDifferingLine ? ` (first difference at line ${firstDifferingLine})` : "") +
      `. The template is the source: edit it and run \`npm run sync:workflow\`.`
  );
});

// ── The install gates, against the reviewer's own idea of which legs will run ──────
//
// This is the test that would have caught the worst bug in this package's history in
// milliseconds instead of never. The pay-per-call GPT route was wired to spawn `codex`
// while the step that installs `codex` was gated on the PLAN credential alone, so that
// route died on ENOENT for its entire life with every unit test green. The tests tested
// pure functions; this was wiring, and nothing read the workflow and the code together.
//
// It costs no CI minutes, which matters: the real credential matrix runs on a schedule,
// and a job-per-combination would have been the expensive way to learn this.

/** Evaluate the subset of GitHub `if:` syntax this workflow actually uses. */
function evalGate(expr, env) {
  const js = expr
    .replace(/steps\.dedup\.outputs\.skip\s*!=\s*'true'/g, "true")
    .replace(/env\.([A-Z_]+)\s*!=\s*''/g, "!!env.$1")
    .replace(/env\.([A-Z_]+)\s*==\s*'([^']*)'/g, "env.$1 === '$2'");
  // Nothing but identifiers, the two boolean operators, parens and quoted literals may
  // survive the translation. A gate that grew a construct this evaluator does not model
  // must fail the test rather than be silently approximated.
  assert.match(js, /^[\sa-zA-Z0-9_.!&|()'=]+$/, `unmodelled if: syntax in ${JSON.stringify(expr)}`);
  // A LEFTOVER `!=` or a two-character `==`; `===` is what the translation produces.
  assert.doesNotMatch(js, /env\.[A-Z_]+\s*(?:!=|==(?!=))/, `an untranslated comparison survived: ${js}`);
  return new Function("env", `return (${js});`)({ ALLOW_METERED: "", ...env });
}

function installGates() {
  const { template } = readPair();
  const gates = {};
  const steps = template.split(/^ {6}- name: /m).slice(1);
  for (const step of steps) {
    const name = step.split("\n")[0].trim();
    const m = step.match(/^ {8}if: (.+)$/m);
    if (!m) continue;
    if (/Install Claude CLI/.test(name)) gates.claude = m[1];
    if (/Install Codex CLI/.test(name)) gates.codex = m[1];
    if (/Seed the Codex plan credential/.test(name)) gates.seed = m[1];
  }
  return gates;
}

test("every credential combination that makes a leg RUN also installs that leg's CLI", async () => {
  const { claudeAuthMode, codexAuthMode } = await import("./eval-reviewer.mjs");
  const gates = installGates();
  assert.ok(gates.claude && gates.codex && gates.seed, "the three gated install/seed steps must be found");

  // Each row: the secrets present in the job env, and what the run should do. Five
  // combinations plus the two "a key alone is not consent" rows.
  const rows = [
    { name: "nothing", env: {} },
    { name: "Claude subscription only", env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } },
    { name: "Codex plan only", env: { CODEX_AUTH_JSON: "{}" } },
    { name: "both subscriptions", env: { CLAUDE_CODE_OAUTH_TOKEN: "t", CODEX_AUTH_JSON: "{}" } },
    { name: "Anthropic key, opted in", env: { ANTHROPIC_API_KEY: "k", ALLOW_METERED: "true" } },
    // The row that was broken. It has never been dispatched; this pins the wiring anyway.
    { name: "OpenAI key, opted in", env: { OPENAI_API_KEY: "k", ALLOW_METERED: "true" } },
    { name: "Anthropic key, NOT opted in", env: { ANTHROPIC_API_KEY: "k" } },
    { name: "OpenAI key, NOT opted in", env: { OPENAI_API_KEY: "k" } },
  ];

  for (const { name, env } of rows) {
    // The seed step is what exports CODEX_HOME, so the reviewer's view of the plan route
    // is downstream of that gate — model it exactly, rather than assuming it.
    const seeded = evalGate(gates.seed, env);
    const reviewerEnv = { ...env, ...(seeded ? { CODEX_HOME: "/home/runner/.codex-ci" } : {}) };

    const claudeWillRun = claudeAuthMode(reviewerEnv) !== "none";
    const codexWillRun = codexAuthMode(reviewerEnv) !== "none";
    assert.equal(evalGate(gates.claude, env), claudeWillRun, `${name}: the Claude CLI install gate disagrees with claudeAuthMode`);
    assert.equal(evalGate(gates.codex, env), codexWillRun, `${name}: the Codex CLI install gate disagrees with codexAuthMode`);
  }
});

test("a key on its own never installs a metered CLI, because holding one is not consent", () => {
  const gates = installGates();
  assert.equal(evalGate(gates.claude, { ANTHROPIC_API_KEY: "k" }), false);
  assert.equal(evalGate(gates.codex, { OPENAI_API_KEY: "k" }), false);
  assert.equal(evalGate(gates.claude, { ANTHROPIC_API_KEY: "k", ALLOW_METERED: "yes" }), false, "only the literal string true");
  assert.equal(evalGate(gates.codex, { OPENAI_API_KEY: "k", ALLOW_METERED: "1" }), false, "only the literal string true");
});

test("the generator is a byte copy, because tribunal init is a byte copy too", async () => {
  // If the sync ever grew a transform — a header, a substitution, a re-serialisation —
  // the installed workflow and a consumer's installed workflow would stop being the same
  // file, and the divergence this whole mechanism closes would reopen one level up.
  // bin/tribunal.mjs uses copyFileSync; so must this.
  const { readFileSync } = await import("node:fs");
  const gen = readFileSync(new URL("./scripts/sync-workflow.mjs", import.meta.url), "utf8");
  assert.match(gen, /writeFileSync\(WORKFLOW_PATH, readFileSync\(TEMPLATE_PATH\)\)/, "the sync must write the template's own bytes");
  const cli = readFileSync(new URL("./bin/tribunal.mjs", import.meta.url), "utf8");
  assert.match(cli, /copyFileSync\(path\.join\(PKG_ROOT, "templates", "tribunal\.yml"\)/, "init must copy the same source file");
});
