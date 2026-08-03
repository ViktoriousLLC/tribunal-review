// Seed the Tribunal's Codex PLAN credential onto the runner, and make the
// "this leg cannot bill" claim actually true.
//
// `codexCliEnv()` already refuses to hand the CLI an OPENAI_API_KEY. That is only half a
// guarantee, because Codex does not read its credential from the environment: it reads
// $CODEX_HOME/auth.json, and THAT FILE HAS AN `OPENAI_API_KEY` FIELD OF ITS OWN. A blob
// captured from a machine where someone had run `codex login --api-key` would carry a
// metered key straight past the env allowlist, and `runCodex` would still stamp the leg
// `plan = true, costUsd = 0`. That is exactly the same failure — a presence-inference plus a
// hard-zero — one JSON field away, so the field is stripped here rather than trusted.
//
// Usage (from the workflow): CODEX_AUTH_JSON=... node seed-codex-auth.mjs <path>
// Exits non-zero with a ::error:: annotation on an api-key-shaped credential, so the
// failure is loud at seed time instead of silent on the invoice.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Returns { json, warnings } with any metered credential removed, or throws when the
 * blob is api-key-authed (there is nothing to salvage — that credential IS the bill).
 * Pure, so the rule is unit-tested rather than trusted to a shell one-liner.
 */
export function sanitizeCodexAuth(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CODEX_AUTH_JSON is not valid JSON — the secret is empty or truncated.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("CODEX_AUTH_JSON is not a JSON object.");
  if (String(parsed.auth_mode || "").toLowerCase() === "apikey") {
    throw new Error(
      'CODEX_AUTH_JSON is API-KEY authed (auth_mode "apikey"), which bills the metered OpenAI API. The Tribunal GPT leg is plan-only. Re-run `codex login` (the ChatGPT plan flow, NOT --api-key) and re-upload the secret.'
    );
  }
  const warnings = [];
  if (parsed.OPENAI_API_KEY) {
    // Not fatal — a plan-authed blob that merely carries a stale key is still usable once
    // the key is gone. Strip it and say so, rather than shipping it to the CLI.
    warnings.push("CODEX_AUTH_JSON carried an OPENAI_API_KEY field; it was stripped before writing auth.json.");
  }
  delete parsed.OPENAI_API_KEY;
  if (!parsed.tokens || !parsed.tokens.refresh_token) {
    throw new Error("CODEX_AUTH_JSON has no plan tokens (tokens.refresh_token missing) — it cannot authenticate.");
  }
  return { json: JSON.stringify(parsed), warnings };
}

function main() {
  const dest = process.argv[2];
  if (!dest) {
    console.error("::error title=Codex credential::seed-codex-auth.mjs needs a destination path.");
    process.exit(1);
  }
  try {
    const { json, warnings } = sanitizeCodexAuth(process.env.CODEX_AUTH_JSON || "");
    for (const w of warnings) console.log(`::warning title=Codex credential::${w}`);
    mkdirSync(dirname(dest), { recursive: true });
    // mode 0600 at CREATE time, not via a later chmod — no window where it is readable.
    writeFileSync(dest, json, { encoding: "utf8", mode: 0o600 });
    console.log("Codex plan credential seeded (plan auth, no API key present).");
  } catch (e) {
    console.log(`::error title=Codex credential::${String(e?.message || e)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
