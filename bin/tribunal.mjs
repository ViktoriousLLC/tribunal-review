#!/usr/bin/env node
// tribunal init / doctor
//
// init   asks four questions, writes the workflow + a starter gates file, and
//        prints the exact `gh secret set` commands for whatever you said yes to.
// doctor prints which credentials are present in the current environment and
//        what each missing one would unlock. Reads values? No. Presence only.
//
// No dependencies. No network. Nothing here ever prints a secret's value.

import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CWD = process.cwd();

// Every credential the panel understands. `unlocks` is what you lose without it.
const CREDENTIALS = [
  { env: "CLAUDE_CODE_OAUTH_TOKEN", kind: "plan", leg: "Claude reviewer + judge",
    unlocks: "the reviewer leg and the blinded judge",
    how: "run `claude setup-token` on a machine logged into a Claude subscription" },
  { env: "CODEX_AUTH_JSON", kind: "plan", leg: "GPT reviewer",
    unlocks: "the GPT reviewer leg",
    how: "log into the Codex CLI, then upload the contents of ~/.codex/auth.json" },
  { env: "GEMINI_API_KEY", kind: "metered", leg: "Gemini reviewer",
    unlocks: "the Gemini reviewer leg (this one is billed per call)",
    how: "create a key at Google AI Studio" },
  { env: "ANTHROPIC_ADMIN_KEY", kind: "readonly", leg: "billing verification (Anthropic)",
    unlocks: "proof from the invoice that the Claude legs cost what they claim",
    how: "an Anthropic organisation admin key, read-only usage scope" },
  { env: "OPENAI_ADMIN_KEY", kind: "readonly", leg: "billing verification (OpenAI)",
    unlocks: "proof from the invoice that the GPT leg cost what it claims",
    how: "an OpenAI organisation admin key, read-only usage scope" },
];

function present(env) {
  return Boolean(process.env[env] && process.env[env].trim());
}

function doctor() {
  console.log("\ntribunal doctor — credential presence in this environment\n");
  let configured = 0;
  for (const c of CREDENTIALS) {
    const ok = present(c.env);
    if (ok) configured++;
    console.log(`  ${ok ? "✓" : "·"} ${c.env.padEnd(24)} ${ok ? "present" : "not set"}`);
    console.log(`    ${ok ? "enables" : "would enable"}: ${c.unlocks}`);
    if (!ok) console.log(`    how: ${c.how}`);
  }
  const metered = present("GEMINI_API_KEY");
  const allowed = String(process.env.ALLOW_METERED || "").toLowerCase() === "true";
  console.log("");
  if (metered && !allowed) {
    console.log("  ! GEMINI_API_KEY is set but ALLOW_METERED is not \"true\".");
    console.log("    The metered leg stays OFF. That is deliberate: a key alone never");
    console.log("    starts billing you. Set ALLOW_METERED=true to turn it on.");
  }
  console.log(`\n  ${configured} of ${CREDENTIALS.length} configured.`);
  if (configured === 0) {
    console.log("  With none of these the panel runs no legs. It still posts a comment");
    console.log("  naming each one and what would enable it, and exits 0.");
  }
  console.log("");
  return 0;
}

async function ask(rl, question, options) {
  const list = options.map((o, i) => `    ${i + 1}) ${o.label}`).join("\n");
  while (true) {
    const answer = (await rl.question(`\n${question}\n${list}\n  choose 1-${options.length}: `)).trim();
    const idx = Number(answer) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) return options[idx].value;
    console.log("  not one of the options, try again");
  }
}

async function init() {
  if (!process.stdin.isTTY) {
    console.error("tribunal init needs an interactive terminal. Run `tribunal doctor` in CI instead.");
    return 2;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\ntribunal init — four questions, then it writes your workflow.\n" +
    "Nothing here asks for a secret VALUE. It only asks what you have, so it knows\n" +
    "which review legs to switch on. You paste the values into GitHub yourself.");

  const claude = await ask(rl, "Claude access?", [
    { label: "A Claude subscription (Pro or Max). Included, no per-call charge.", value: "plan" },
    { label: "None", value: "none" },
  ]);
  const gpt = await ask(rl, "GPT access?", [
    { label: "A ChatGPT subscription usable by the Codex CLI. Included, no per-call charge.", value: "plan" },
    { label: "None", value: "none" },
  ]);
  const gemini = await ask(rl, "Gemini API key? This leg is billed per call.", [
    { label: "Yes, and I want it on", value: "on" },
    { label: "Yes, but leave it off for now", value: "off" },
    { label: "No", value: "none" },
  ]);
  const billing = await ask(rl, "Organisation admin keys, so the panel can check its own bill against the invoice?", [
    { label: "Yes, I will add them", value: "yes" },
    { label: "No. Costs will be reported as \"unverified\" rather than as a number.", value: "no" },
  ]);
  await rl.close();

  const legs = [];
  if (claude === "plan") legs.push("claude-reviewer", "judge");
  if (gpt === "plan") legs.push("gpt-reviewer");
  if (gemini === "on") legs.push("gemini-reviewer");

  if (legs.length === 0) {
    console.log("\nNo legs available, so there is nothing to install yet.");
    console.log("Come back when you have at least a Claude subscription. Nothing was written.\n");
    return 0;
  }

  // The judge runs on the Claude subscription and only on it. Without one you still get
  // reviewers, which is most of the value, but you lose the pass that reads every finding
  // with the sources stripped and reconciles them — and nothing downstream says so. A
  // capability you silently do not have is worse than one you were told about, so say it
  // here, before anything is written, and say what turns it back on.
  const judgeless = claude !== "plan";
  if (judgeless) {
    console.log("\n! No Claude subscription, so the BLINDED JUDGE will not run.");
    console.log("  You will get each reviewer's findings, deduplicated, and nothing that");
    console.log("  reconciles them: no cross-model synthesis, no ranking, no reading of");
    console.log("  which findings agree. That pass is Claude-only.");
    console.log("  To turn it on later: get a Claude subscription, run `claude setup-token`,");
    console.log("  and `gh secret set CLAUDE_CODE_OAUTH_TOKEN`. Nothing else changes.");
  }

  // Write the workflow and a starter gates file. Never overwrite silently.
  const wfDir = path.join(CWD, ".github", "workflows");
  const wfPath = path.join(wfDir, "tribunal.yml");
  mkdirSync(wfDir, { recursive: true });
  if (existsSync(wfPath)) {
    console.log(`\n! ${path.relative(CWD, wfPath)} already exists. Left untouched.`);
  } else {
    copyFileSync(path.join(PKG_ROOT, "templates", "tribunal.yml"), wfPath);
    console.log(`\n✓ wrote ${path.relative(CWD, wfPath)}`);
  }

  const gatesDir = path.join(CWD, ".tribunal");
  const gatesPath = path.join(gatesDir, "review-gates.md");
  mkdirSync(gatesDir, { recursive: true });
  if (existsSync(gatesPath)) {
    console.log(`! ${path.relative(CWD, gatesPath)} already exists. Left untouched.`);
  } else {
    copyFileSync(path.join(PKG_ROOT, "examples", "review-gates.md"), gatesPath);
    console.log(`✓ wrote ${path.relative(CWD, gatesPath)} — edit this. It is what makes the review yours.`);
  }

  const wanted = [];
  if (claude === "plan") wanted.push("CLAUDE_CODE_OAUTH_TOKEN");
  if (gpt === "plan") wanted.push("CODEX_AUTH_JSON");
  if (gemini !== "none") wanted.push("GEMINI_API_KEY");
  // Per leg, like the three lines above. Asking someone to create an OpenAI org admin
  // key to verify a leg they never enabled is asking for a credential that does nothing.
  if (billing === "yes" && claude === "plan") wanted.push("ANTHROPIC_ADMIN_KEY");
  if (billing === "yes" && gpt === "plan") wanted.push("OPENAI_ADMIN_KEY");

  console.log("\nNow add the secrets. Run these, one at a time, and paste the value when asked:\n");
  for (const env of wanted) {
    if (env === "CODEX_AUTH_JSON") {
      console.log(`  gh secret set CODEX_AUTH_JSON < "$HOME/.codex/auth.json"`);
    } else {
      console.log(`  gh secret set ${env}`);
    }
  }
  if (gemini === "on") {
    console.log(`  gh variable set ALLOW_METERED --body true`);
  }

  console.log(`\nLegs that will run: ${legs.join(", ")}.`);
  if (judgeless) {
    console.log("No judge in that list, and that is not a typo: see the note above.");
  }
  if (gemini === "off") {
    console.log("Gemini is configured but off. Set ALLOW_METERED to true when you want it.");
  }
  if (billing === "no") {
    console.log("Without admin keys, every cost is reported as \"unverified\". That is the honest");
    console.log("answer and it is deliberate: an unmeasured run is never reported as free.");
  }
  console.log("\nThen open a pull request and run:  gh workflow run tribunal.yml -f pr_number=<n>\n");
  return 0;
}

const cmd = process.argv[2];
if (cmd === "doctor") process.exit(doctor());
else if (cmd === "init") process.exit(await init());
else {
  console.log("usage: tribunal <init|doctor>");
  console.log("  init    ask four questions, write the workflow, print the secret commands");
  console.log("  doctor  show which credentials are present and what the missing ones unlock");
  process.exit(cmd ? 1 : 0);
}
