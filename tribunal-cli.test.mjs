// The setup commands are the only instructions a new user actually acts on, so the rule
// that decides WHICH ones they see is worth pinning. Everything else in the CLI is
// printing; this is the part that can be wrong in a way that costs somebody an hour.
//
// Env-free. `secretCommands` is pure, and importing the CLI does not run it (the module
// only acts when invoked as the entry point).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secretCommands } from "./bin/tribunal.mjs";

const both = { claude: "plan", gpt: "plan", gemini: "none", billing: "yes" };

test("only asks for credentials the chosen legs actually use", () => {
  const { wanted } = secretCommands(both);
  assert.deepEqual(wanted, [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_AUTH_JSON",
    "ANTHROPIC_ADMIN_KEY",
    "OPENAI_ADMIN_KEY",
  ]);
});

test("an admin key is only requested for a leg that will run", () => {
  // Asking somebody to create an OpenAI organisation admin key so the panel can verify a
  // GPT leg they never enabled is asking for a credential that does nothing.
  const { wanted } = secretCommands({ claude: "plan", gpt: "none", gemini: "none", billing: "yes" });
  assert.ok(wanted.includes("ANTHROPIC_ADMIN_KEY"));
  assert.ok(!wanted.includes("OPENAI_ADMIN_KEY"));
  assert.ok(!wanted.includes("CODEX_AUTH_JSON"));
});

test("declining invoice verification asks for no admin keys at all", () => {
  const { wanted } = secretCommands({ ...both, billing: "no" });
  assert.deepEqual(wanted, ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_AUTH_JSON"]);
});

test("the metered leg needs the key AND the explicit switch, and only the switch is conditional", () => {
  // Two locks. A key alone must never start billing anybody, so ALLOW_METERED appears
  // only when they said they want it on.
  const on = secretCommands({ ...both, gemini: "on" });
  assert.ok(on.wanted.includes("GEMINI_API_KEY"));
  assert.ok(on.lines.some((l) => l.includes("gh variable set ALLOW_METERED --body true")));

  const off = secretCommands({ ...both, gemini: "off" });
  assert.ok(off.wanted.includes("GEMINI_API_KEY"), "they still need to store the key they said they have");
  assert.ok(
    !off.lines.some((l) => l.includes("ALLOW_METERED")),
    "but nothing turns billing on until they ask for it"
  );
});

test("the Codex credential is uploaded from a file, not typed", () => {
  // It is a JSON blob, not a string a human can paste, and getting this wrong is a
  // confusing failure much later at seed time.
  const { lines } = secretCommands(both);
  assert.ok(lines.some((l) => l.includes(`gh secret set CODEX_AUTH_JSON < "$HOME/.codex/auth.json"`)));
});

test("no credentials chosen means no commands, not a broken list", () => {
  const { wanted, lines } = secretCommands({ claude: "none", gpt: "none", gemini: "none", billing: "no" });
  assert.deepEqual(wanted, []);
  assert.deepEqual(lines, []);
});

// The pay-per-call route, asked only of people who said they have no subscription.
test("choosing an API key asks for the key, not the subscription token", () => {
  const { wanted, lines } = secretCommands({
    claude: "metered",
    gpt: "metered",
    gemini: "none",
    billing: "no",
  });
  assert.deepEqual(wanted, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  assert.ok(!wanted.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.ok(!wanted.includes("CODEX_AUTH_JSON"));
  assert.ok(
    lines.some((l) => l.includes("ALLOW_METERED --body true")),
    "anything billed needs the second lock, whichever leg it is"
  );
});

test("a mixed setup asks for exactly the credentials that setup uses", () => {
  // A subscription for one vendor and a key for the other is a real shape, and the two
  // must never both be requested for the same leg.
  const { wanted } = secretCommands({ claude: "plan", gpt: "metered", gemini: "none", billing: "yes" });
  assert.deepEqual(wanted, ["CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_ADMIN_KEY"]);
  assert.ok(!wanted.includes("ANTHROPIC_API_KEY"), "the Claude leg is on the plan; its key would never be read");
  assert.ok(!wanted.includes("OPENAI_ADMIN_KEY"), "there is no plan claim to verify for a pay-per-call leg");
});

test("no billed leg means no ALLOW_METERED line at all", () => {
  const { lines } = secretCommands({ claude: "plan", gpt: "plan", gemini: "none", billing: "no" });
  assert.ok(!lines.some((l) => l.includes("ALLOW_METERED")));
});

test("init tells you to point the workflow at this package, not just the README", () => {
  // The workflow defaults to the npm release, which is not published, so a user who follows
  // init exactly hits `npm error 404 tribunal-review@0.1.0 is not in this registry` on
  // their first dispatch. The workflow's own comment records that this already happened.
  // A setup command that omits the step its own error message tells you to run is the
  // wrong way round. (Frozen-artifact panel catch.)
  const src = readFileSync(new URL("./bin/tribunal.mjs", import.meta.url), "utf8");
  const init = src.slice(src.indexOf("Now add the secrets"), src.indexOf("Then open a pull request"));
  assert.match(init, /gh variable set TRIBUNAL_PACKAGE/, "init must print the variable command");
  assert.match(init, /rev-parse HEAD/, "and pin a commit, because a branch moves under the thing that gates your merges");
  // Derived from package.json, so a fork prints its own repository instead of confidently
  // sending its users to this one.
  assert.match(src, /const PACKAGE_REPO = /, "the repository name must come from package.json, not a literal");
  assert.doesNotMatch(init, /github:ViktoriousLLC/, "no hardcoded owner in the printed command");
});
