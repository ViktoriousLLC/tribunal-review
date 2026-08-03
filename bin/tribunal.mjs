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
import { isDirectInvocation, reportMisidentifiedEntrypoint } from "../entrypoint.mjs";

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
  { env: "ANTHROPIC_API_KEY", kind: "metered", leg: "Claude reviewer + judge (pay-per-call)",
    unlocks: "the same Claude legs WITHOUT a subscription, billed per call",
    how: "an Anthropic API key — only used when there is no subscription token, and only with ALLOW_METERED=true" },
  { env: "OPENAI_API_KEY", kind: "metered", leg: "GPT reviewer (pay-per-call)",
    unlocks: "the same GPT leg WITHOUT a subscription, billed per call",
    how: "an OpenAI API key — only used when there is no Codex plan credential, and only with ALLOW_METERED=true" },
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

/**
 * The `gh secret set` / `gh variable set` lines for a given set of answers.
 *
 * Shared by `init` and `setup`, because printing this list once into a terminal that then
 * scrolls away is not a way to deliver instructions. `setup` reprints it on demand, and
 * `doctor --repo` narrows it to what is actually still missing.
 */
export function secretCommands({ claude, gpt, gemini, billing }) {
  const wanted = [];
  if (claude === "plan") wanted.push("CLAUDE_CODE_OAUTH_TOKEN");
  if (claude === "metered") wanted.push("ANTHROPIC_API_KEY");
  if (gpt === "plan") wanted.push("CODEX_AUTH_JSON");
  if (gpt === "metered") wanted.push("OPENAI_API_KEY");
  if (gemini !== "none") wanted.push("GEMINI_API_KEY");
  // Per leg. Asking someone to create an OpenAI org admin key to verify a leg they never
  // enabled is asking for a credential that does nothing. The admin keys verify a PLAN
  // claim against the invoice; a pay-per-call leg reports a token-priced ESTIMATE of what it spent from its own
  // counts, so there is no plan claim to check and no reason to ask for the key.
  if (billing === "yes" && claude === "plan") wanted.push("ANTHROPIC_ADMIN_KEY");
  if (billing === "yes" && gpt === "plan") wanted.push("OPENAI_ADMIN_KEY");

  const lines = wanted.map((env) =>
    env === "CODEX_AUTH_JSON"
      ? `  gh secret set CODEX_AUTH_JSON < "$HOME/.codex/auth.json"`
      : `  gh secret set ${env}`
  );
  // ONE switch arms every billed leg, and nothing bills without it. Two locks, always.
  const anyMetered = gemini === "on" || claude === "metered" || gpt === "metered";
  if (anyMetered) lines.push("  gh variable set ALLOW_METERED --body true");
  return { wanted, lines };
}

/**
 * Said at the moment somebody agrees to be billed, not buried in a file.
 *
 * Three things they need and cannot work out from the prompt they just answered: that it
 * charges on EVERY dispatch with nothing capping it, how to stop, and what happens if they
 * later get a subscription. That last one is the correction worth making out loud, because
 * "an API key overrides your plan" is the normal behaviour of these tools and is exactly
 * what caused the incident this project was built around. It is not what happens here.
 */
function meteredWarning(vendor, keyEnv, planEnv) {
  console.log("");
  console.log(`  ┌─ ${vendor}: you are choosing to be BILLED ─────────────────────────`);
  console.log("  │");
  console.log("  │  Every dispatch charges your account. Not once at setup: each time");
  console.log("  │  you run the panel, for as long as the key is there.");
  console.log("  │");
  console.log("  │  NOTHING IN THIS TOOL CAPS THAT SPEND. There is no budget, no limit,");
  console.log("  │  no monthly ceiling. Set one on the vendor's own dashboard if you");
  console.log("  │  want a floor under how wrong this can go.");
  console.log("  │");
  console.log("  │  Every run reports an ESTIMATE of what it cost, in the pull request comment");
  console.log("  │  and in the run log. Read the first one before you dispatch a second.");
  console.log("  │");
  console.log("  │  TO STOP BILLING, either is enough and both take effect immediately:");
  console.log("  │    gh variable set ALLOW_METERED --body false     (keeps the key, off)");
  console.log(`  │    gh secret delete ${keyEnv}`.padEnd(68) + "(removes it entirely)");
  console.log("  │");
  console.log(`  │  If you later get a subscription, add ${planEnv}`);
  console.log("  │  and this tool switches to it automatically. It prefers the");
  console.log("  │  subscription and stops touching your key, so billing stops without");
  console.log("  │  you deleting anything. You are never charged twice for one leg.");
  console.log("  └───────────────────────────────────────────────────────────────────");
}

/** Run a gh command and return its stdout, or null when gh cannot answer. */
async function gh(args) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("gh", args, { encoding: "utf8", shell: false });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/**
 * Does the REPOSITORY have these credentials — not this laptop.
 *
 * The gap this closes: `doctor` reads environment variables on the machine you run it
 * from, so somebody who correctly pasted five secrets into GitHub and then ran `doctor`
 * to check their work saw "0 of 5 configured" and reasonably concluded they had broken
 * something. That is the likeliest way to lose a first-time user, and it is the one
 * question the tool could not answer: did my setup work.
 *
 * GitHub never returns a secret's VALUE, to anyone, ever. It does return the NAMES, which
 * is all this needs.
 */
async function doctorRepo(repoArg) {
  const target = repoArg ? ["--repo", repoArg] : [];
  const label = repoArg || "the current repository";
  console.log(`\ntribunal doctor --repo — what ${label} actually has\n`);

  const secretsRaw = await gh(["secret", "list", ...target, "--json", "name"]);
  if (secretsRaw === null) {
    console.log("  Could not ask GitHub. That is usually one of three things:");
    console.log("    - the GitHub CLI is not installed        → https://cli.github.com");
    console.log("    - you are not logged in                  → gh auth login");
    console.log("    - you are not inside the repository      → pass it: tribunal doctor --repo owner/name");
    console.log("");
    return 2;
  }
  const variablesRaw = (await gh(["variable", "list", ...target, "--json", "name,value"])) || "[]";

  let secretNames = [];
  let variables = [];
  try {
    secretNames = JSON.parse(secretsRaw).map((s) => s.name);
    variables = JSON.parse(variablesRaw);
  } catch {
    console.log("  GitHub answered in a shape this version does not understand, so nothing is reported.");
    console.log("  Refusing to guess: an unreadable answer is not the same as an empty one.");
    console.log("");
    return 2;
  }

  const has = (n) => secretNames.includes(n);
  const missing = [];
  for (const c of CREDENTIALS) {
    const ok = has(c.env);
    if (!ok) missing.push(c);
    console.log(`  ${ok ? "✓" : "·"} ${c.env.padEnd(24)} ${ok ? "set in this repository" : "not set"}`);
    console.log(`    ${ok ? "enables" : "would enable"}: ${c.unlocks}`);
  }

  const allowMetered = variables.find((v) => v.name === "ALLOW_METERED");
  const meteredOn = String(allowMetered?.value || "").trim().toLowerCase() === "true";
  console.log("");

  // What will actually happen on the next dispatch, which is the thing they wanted to know.
  // Mirrors legAuthMode in the reviewer: the plan wins, and a key only counts when the
  // metered switch is on. If these two ever disagree, this one is the liar.
  const legs = [];
  const billed = [];
  const claudeMode = has("CLAUDE_CODE_OAUTH_TOKEN") ? "plan" : has("ANTHROPIC_API_KEY") && meteredOn ? "metered" : "none";
  const gptMode = has("CODEX_AUTH_JSON") ? "plan" : has("OPENAI_API_KEY") && meteredOn ? "metered" : "none";
  if (claudeMode !== "none") legs.push("claude-reviewer", "judge");
  if (gptMode !== "none") legs.push("gpt-reviewer");
  if (has("GEMINI_API_KEY") && meteredOn) legs.push("gemini-reviewer");
  if (claudeMode === "metered") billed.push("claude-reviewer + judge");
  if (gptMode === "metered") billed.push("gpt-reviewer");
  if (has("GEMINI_API_KEY") && meteredOn) billed.push("gemini-reviewer");

  if (legs.length === 0) {
    console.log("  Legs that will run on the next dispatch: NONE.");
    console.log("  The panel will still post a comment naming every leg and what it needs,");
    console.log("  and exit 0. It will not review anything.");
  } else {
    console.log(`  Legs that will run on the next dispatch: ${legs.join(", ")}.`);
  }
  if (billed.length > 0) {
    console.log(`  BILLED PER CALL: ${billed.join(", ")}. Everything else is on a subscription.`);
    console.log("  Every dispatch charges you, and nothing in this tool caps it.");
    console.log("  Stop it with:  gh variable set ALLOW_METERED --body false");
  }
  if (claudeMode === "none" && legs.length > 0) {
    console.log("  No judge: the blinded reconciliation pass is Claude-only, so you get each");
    console.log("  reviewer's findings and nothing that reconciles them.");
  }
  for (const [name, key, plan] of [
    ["Claude", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    ["GPT", "OPENAI_API_KEY", "CODEX_AUTH_JSON"],
  ]) {
    if (has(key) && has(plan)) {
      console.log(`  Note: both ${plan} and ${key} are set. The ${name} legs will use the`);
      console.log("  SUBSCRIPTION and the key will not be touched, so you are not being billed twice.");
    } else if (has(key) && !meteredOn) {
      console.log(`  ! ${key} is set but ALLOW_METERED is not "true", so the ${name} legs stay OFF.`);
    }
  }
  if (has("GEMINI_API_KEY") && !meteredOn) {
    console.log("");
    console.log("  ! GEMINI_API_KEY is set but ALLOW_METERED is not \"true\", so that leg stays OFF.");
    console.log("    Deliberate: a key alone never starts billing you.");
    console.log("    Turn it on with:  gh variable set ALLOW_METERED --body true");
  }

  if (missing.length > 0) {
    console.log("\n  Still missing. Run these from inside the repository:\n");
    for (const c of missing) {
      const cmd =
        c.env === "CODEX_AUTH_JSON"
          ? `gh secret set CODEX_AUTH_JSON < "$HOME/.codex/auth.json"`
          : `gh secret set ${c.env}`;
      console.log(`  ${cmd}`);
      console.log(`      how to get the value: ${c.how}`);
    }
  } else {
    console.log("\n  Every credential this tool understands is set. Nothing left to do.");
  }
  console.log("");
  return 0;
}

function doctor() {
  console.log("\ntribunal doctor — credential presence ON THIS MACHINE\n");
  console.log("  This reads environment variables here, which is NOT where the panel runs.");
  console.log("  To check whether your repository is set up, run:  tribunal doctor --repo\n");
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

  // The pay-per-call route is a FOLLOW-UP, asked only of people who said they have no
  // subscription. That is not just kinder ordering: it is what makes the two modes
  // mutually exclusive by construction, so nobody ends up configuring both and wondering
  // which one is being charged.
  let claude = await ask(rl, "Claude access?", [
    { label: "A Claude subscription (Pro or Max). Included, no per-call charge.", value: "plan" },
    { label: "None", value: "none" },
  ]);
  if (claude === "none") {
    claude = await ask(rl, "No subscription. Use an Anthropic API key instead? This one IS billed per call.", [
      { label: "Yes, use my API key and bill me per call", value: "metered" },
      { label: "No, skip the Claude legs entirely", value: "none" },
    ]);
    if (claude === "metered") meteredWarning("Anthropic", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN");
  }

  let gpt = await ask(rl, "GPT access?", [
    { label: "A ChatGPT subscription usable by the Codex CLI. Included, no per-call charge.", value: "plan" },
    { label: "None", value: "none" },
  ]);
  if (gpt === "none") {
    gpt = await ask(rl, "No subscription. Use an OpenAI API key instead? This one IS billed per call.", [
      { label: "Yes, use my API key and bill me per call", value: "metered" },
      { label: "No, skip the GPT leg entirely", value: "none" },
    ]);
    if (gpt === "metered") meteredWarning("OpenAI", "OPENAI_API_KEY", "CODEX_AUTH_JSON");
  }
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
  // Either credential runs the leg. The judge is Claude-family either way.
  if (claude !== "none") legs.push("claude-reviewer", "judge");
  if (gpt !== "none") legs.push("gpt-reviewer");
  if (gemini === "on") legs.push("gemini-reviewer");

  if (legs.length === 0) {
    console.log("\nNo legs available, so there is nothing to install yet.");
    // EITHER subscription is enough on its own — the old wording here said "a Claude
    // subscription", which would have turned away someone the tool works fine for.
    console.log("You need at least one of: a Claude subscription (Pro or Max), a ChatGPT");
    console.log("subscription the Codex CLI can use, or a Gemini API key you are willing to");
    console.log("be billed for. Any ONE of those runs a review. Nothing was written.\n");
    return 0;
  }

  // The judge runs on the Claude subscription and only on it. Without one you still get
  // reviewers, which is most of the value, but you lose the pass that reads every finding
  // with the sources stripped and reconciles them — and nothing downstream says so. A
  // capability you silently do not have is worse than one you were told about, so say it
  // here, before anything is written, and say what turns it back on.
  const judgeless = claude === "none";
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

  const { lines } = secretCommands({ claude, gpt, gemini, billing });
  console.log("\nNow add the secrets. Run these from inside the repository, one at a time,");
  console.log("and paste the value when asked:\n");
  for (const line of lines) console.log(line);
  console.log("\nLost this list? `tribunal setup` prints it again.");
  console.log("Want to know whether it worked? `tribunal doctor --repo` asks GitHub.");

  console.log(`\nLegs that will run: ${legs.join(", ")}.`);
  if (judgeless) {
    console.log("No judge in that list, and that is not a typo: see the note above.");
  }
  if (gemini === "off") {
    console.log("Gemini is configured but off. Set ALLOW_METERED to true when you want it.");
  }
  if (billing === "no" && (claude === "plan" || gpt === "plan")) {
    // Only a PLAN claim needs an invoice to back it. A pay-per-call leg reports what it
    // actually spent from its own token counts, so there is nothing unverified about it.
    console.log("Without admin keys, a subscription leg's cost is reported as \"unverified\" rather");
    console.log("than as zero. That is deliberate: an unmeasured run is never reported as free.");
  }
  if (claude === "metered" || gpt === "metered") {
    console.log("Your pay-per-call legs report an ESTIMATE of what they spent, priced from their");
    console.log("own token counts. It is not checked against the provider's invoice, so treat it");
    console.log("as close rather than exact. The provider's dashboard is the number that counts.");
  }
  console.log("\nThen open a pull request and run:  gh workflow run tribunal.yml -f pr_number=<n>\n");
  return 0;
}

/**
 * Reprint the setup commands without re-running init.
 *
 * init prints them once, into a terminal that then scrolls away. That is not a way to
 * deliver instructions somebody has to act on across two websites and a password manager.
 * Non-interactive on purpose, so it works over ssh, in a script, and in CI.
 */
function setup(argv) {
  const flag = (name) => argv.includes(name);
  // Default to the full set. Anyone who skipped a leg simply ignores its line, which is
  // cheaper than making them answer four questions again to reread one command.
  const answers = {
    claude: flag("--no-claude") ? "none" : "plan",
    gpt: flag("--no-gpt") ? "none" : "plan",
    gemini: flag("--gemini") ? "on" : "none",
    billing: flag("--no-billing") ? "no" : "yes",
  };
  const { lines } = secretCommands(answers);
  console.log("\nSetup commands. Run these from inside the repository:\n");
  for (const line of lines) console.log(line);
  console.log("\nEach one prompts for the value; nothing is echoed and nothing is stored locally.");
  console.log("Where to get each value:  tribunal doctor");
  console.log("Did it work:              tribunal doctor --repo\n");
  console.log("Showing every credential. Skip any leg you are not using, or narrow the list:");
  console.log("  --no-claude   --no-gpt   --gemini   --no-billing\n");
  return 0;
}

async function runCli() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);
  if (cmd === "doctor") {
    // `--repo` alone means the current directory's repository; `--repo owner/name` names one.
    const i = args.indexOf("--repo");
    if (i === -1) process.exit(doctor());
    const named = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
    process.exit(await doctorRepo(named));
  } else if (cmd === "init") process.exit(await init());
  else if (cmd === "setup") process.exit(setup(args));
  else {
    console.log("usage: tribunal <init|setup|doctor>");
    console.log("  init            ask four questions, write the workflow, print the secret commands");
    console.log("  setup           print those secret commands again, without re-running init");
    console.log("  doctor          which credentials are present ON THIS MACHINE, and what each unlocks");
    console.log("  doctor --repo   which are present IN THE REPOSITORY, and which legs will actually run");
    console.log("                  (add owner/name to check a repository you are not standing in)");
    process.exit(cmd ? 1 : 0);
  }
}

// Same entry-point guard as the other executables, and it earned its place immediately:
// without it, `import { secretCommands } from "./bin/tribunal.mjs"` RAN the dispatcher,
// which printed usage and called process.exit(0), killing the test process before a single
// assertion. The suite then reported one passing test and went green. A file that cannot
// be imported cannot be tested, and a test run that exits early looks exactly like one
// that succeeded.
if (isDirectInvocation(process.argv[1], import.meta.url)) {
  await runCli();
} else if (reportMisidentifiedEntrypoint(process.argv[1], import.meta.url, "tribunal.mjs")) {
  process.exit(1);
}
