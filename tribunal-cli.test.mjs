// The setup commands are the only instructions a new user actually acts on, so the rule
// that decides WHICH ones they see is worth pinning. Everything else in the CLI is
// printing; this is the part that can be wrong in a way that costs somebody an hour.
//
// Env-free. `secretCommands` is pure, and importing the CLI does not run it (the module
// only acts when invoked as the entry point).

import test from "node:test";
import assert from "node:assert/strict";
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
