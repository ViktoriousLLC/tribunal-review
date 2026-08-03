// The rule: the Tribunal's GPT leg must be structurally incapable of billing.
// The env allowlist is not enough on its own, because Codex reads its credential from
// auth.json, and that file can carry an OPENAI_API_KEY of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeCodexAuth } from "./seed-codex-auth.mjs";

const planBlob = (extra = {}) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "i", access_token: "a", refresh_token: "r", account_id: "acct" },
    last_refresh: "2026-07-17T00:13:19Z",
    ...extra,
  });

test("a clean plan credential passes through with its tokens intact", () => {
  const { json, warnings } = sanitizeCodexAuth(planBlob());
  const out = JSON.parse(json);
  assert.equal(out.auth_mode, "chatgpt");
  assert.equal(out.tokens.refresh_token, "r");
  assert.deepEqual(warnings, []);
});

test("THE POINT: an OPENAI_API_KEY inside auth.json is STRIPPED, and said out loud", () => {
  // This is the shape one field away: the CLI would bill metered while runCodex
  // stamped the leg plan/$0. The env allowlist never sees this key, so stripping is the
  // only thing that makes "structurally incapable of billing" a true statement.
  const { json, warnings } = sanitizeCodexAuth(planBlob({ OPENAI_API_KEY: "sk-live-metered" }));
  assert.equal(JSON.parse(json).OPENAI_API_KEY, undefined);
  assert.equal(json.includes("sk-live-metered"), false);
  assert.match(warnings.join(" "), /stripped/i);
});

test("an API-KEY-authed credential is REJECTED, not quietly downgraded", () => {
  assert.throws(() => sanitizeCodexAuth(planBlob({ auth_mode: "apikey" })), /plan-only|codex login/i);
  assert.throws(() => sanitizeCodexAuth(planBlob({ auth_mode: "ApiKey" })), /plan-only|codex login/i);
});

test("an empty, truncated, or token-less secret fails loudly at seed time", () => {
  assert.throws(() => sanitizeCodexAuth(""), /not valid JSON/);
  assert.throws(() => sanitizeCodexAuth('{"auth_mode":"chatgpt"'), /not valid JSON/);
  assert.throws(() => sanitizeCodexAuth('"a string"'), /not a JSON object/);
  assert.throws(() => sanitizeCodexAuth('{"auth_mode":"chatgpt","tokens":{}}'), /no plan tokens/);
});
