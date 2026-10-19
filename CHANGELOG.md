# Changelog

## v0.10.3 — 2026-10-19

Three design calls left open by the v0.10.2 break-it pass.

- One model is not a panel. A ledger row now counts as a review, for both the merge gate and
  the goal wall, only when at least two DISTINCT models answered and parsed (legs of kind
  `answered` with a named model only, deduplicated by model; both hooks share one tested rule). A registry shrunk to one leg used to complete, and
  pass, every round by construction. An `UNREADABLE` round (every leg answered, none parsed) no
  longer counts either. Upgrading re-judges rows already in the ledger: measured on the
  maintainer's 1,113 complete rows (every leg banked with kind `answered` and a model), exactly
  one stopped counting, a one-model review.
- A complete round that still found actionable findings keeps unlocking the merge (the gate
  proves a review happened; the verdict is the operator's call), and the hook now says so: a
  visible notice names the latest round and its actionable count, in both gate and reminder
  mode, after any verdict but `QUIET`, including a `REDO` (the fix did not land). A later quiet
  round clears it. A newer
  incomplete round that found findings is named too, instead of hiding behind an older quiet one.
- Known limit, documented rather than fixed: the goal wall checks goal files that differ from
  `origin/main` in this checkout, so a goal merged and pulled back within one reply, or written
  in a sibling worktree, is not checked at Stop.
- A parser timing test's bound went from 2s to 10s: the input takes about 1.5s, so 2s failed
  under a loaded run, and catastrophic backtracking still takes minutes.

## v0.10.2 — 2026-10-18

From the first break-it pass (two attackers, Claude and Codex, running attempts against the real
hooks; the procedure is now a release step in `docs/BREAK-IT.md`).

- A merge that names no PR number (`gh pr merge --squash` on the current branch, a branch name,
  a variable such as `$PR`, a GraphQL merge) used to pass silently, by design, because the
  ledger is keyed by number. It was the most common merge an agent types, so it now blocks as
  `UNVERIFIED` and asks for the number, under its own three-block budget per session.
- `gh api -X PUT ... pulls/<n>/merge` counts as a merge of PR n (the plain GET form only reads
  merge status and is left alone).
- Recognised now: gh's repo flag before `pr` (`-R x`, `-Rx`, `--repo=x`), `GH`, a leading
  redirection (`2>/dev/null gh`, `2> /dev/null gh`), `nice -n 10`, `winpty`, `npx`, `cmd /c`
  (quoted or not), PowerShell `$out = gh pr merge 7`, `-F/--body-file` values, PR URLs ending in
  `/files`, `/` or `#...`, and `'#7'`.
- PowerShell here-strings (`@'...'@`, `@"..."@`) are parsed as text, so an apostrophe inside one
  no longer swallows the next command; block comments (`<# #>`) are skipped; `${#ARRAY[@]}` is no
  longer read as a comment.
- Known limits now name that ledger rows carry no repository.

## v0.10.1 — 2026-10-18

Fixes from an outside review that faked ledger rows against both gates.

- The merge gate counted ANY ledger row naming the PR, so a round in which every leg failed
  (decision PARTIAL) or a row with no decision unlocked the merge. It now needs a complete diff
  round, the same rule the goal wall already used.
- The merge gate split commands only on `&&`, `||`, `;` and `|`, so a merge on its own line
  after `git push` was missed. It now splits the way a shell does: newlines, `&`, subshells,
  braces and command substitution (also inside double quotes and unquoted heredocs), with line
  continuations joined, comments skipped, quotes and heredoc bodies kept as prose, and shell
  keywords (`if`, `!`), wrappers (`env`, `exec`, `timeout 60`), `VAR=value`, and a full,
  quoted or `.exe` path before `gh` recognised.
- The merge gate now also reads commands from the PowerShell tool, not only Bash, with
  PowerShell's own escape and continuation character (the backtick).
- The goal wall's break-glass and stand-down banners went to stderr with exit 0, which Claude
  Code does not show. They are now a `systemMessage` on stdout.
- Hooks had a 10-second timeout, and Claude Code lets the action through when it kills a hook.
  The timeout is now 60 seconds, each hook keeps its own 40-second budget and BLOCKS as
  `UNVERIFIED` (through the three-per-item brake) when it runs out, and both hooks parse only
  the ledger lines that name the PR or goal hash in question.

## v0.10.0 — 2026-10-16

- New `grok-cli` runner: xAI's Grok Build CLI as a plan-billed review leg. It runs with every
  built-in tool removed by name (an empty `--tools` allowlist removes nothing), web search off,
  one turn, its own system prompt, and its home variables pointed at the invocation's empty
  directory so it cannot read the user's rules, skills or MCP servers. It signs in through its own
  Grok home (`~/.tribunal/grok-home`, or `TRIBUNAL_GROK_HOME`), never `~/.grok`, with API-key
  login, self-update and telemetry switched off. `XAI_API_KEY` joins the spend keys an agent leg
  can never receive. The isolation probe covers it (`--leg grok`).
- New optional seat fields: `advisory: true` prints a seat's findings under their own heading and
  keeps them out of every count (quiet, partial, blocking, proof, ledger `legs`), and
  `until: "YYYY-MM-DD"` turns a seat off after that UTC day, even when `enabledLegs` names it; an impossible date such as 2026-02-31 is refused.
- An advisory seat whose isolation is not proven (signed out, say) is dropped for that run with a
  loud line, and the counted seats are admitted on their own measurement; it never refuses the
  panel. `doctor` knows `grok-cli`, and an advisory seat that cannot run never fails `doctor`.

## v0.9.0 — 2026-09-28

- The command is `/tribunal-review:review`; the published plugin name remains `tribunal-review`.
- Install in one in-session command on Claude Code v2.1.275 or later:
  `/plugin install tribunal-review --marketplace ViktoriousLLC/tribunal-review`.
  Older versions retain the two-command fallback.
- Goal review is gated at Stop by default, and an explicit `gh pr merge <PR number>` blocks
  without a recorded panel row. Both gates have a three-block budget per item per session
  and honor `.claude/tribunal-wall-breakglass` with a loud notice. Automation can also set
  `TRIBUNAL_ALLOW_UNREVIEWED_MERGE=1` to allow an unreviewed merge with a notice.
- Consumer config accepts `gates.goalWall` and `gates.mergeGate`, both defaulting to `true`.
  Disabling the merge gate restores reminder-only behavior; goal-write notices remain reminders.

## v0.8.6 — 2026-09-27

- Zero-setup first run. With no configuration file the panel runs on whatever CLIs are installed:
  a seat whose CLI is absent is skipped and named, never counted as a lost reviewer (naming it in
  enabledLegs restores the loud failure). The isolation measurement now runs by itself on the
  first review and again after a CLI upgrade; --no-auto-probe keeps the strict refusal. doctor
  labels skipped seats and exits 1 only when no seat can run at all.
- README rewritten around what the tool is for and a two-command install; the reference material
  moved below it.

## v0.8.5 — 2026-09-25

- The key-and-value secret rule no longer rewrites code: a value containing brackets or
  parentheses, or running into a call, is left alone, so a line such as
  `const someToken = [encode(header), ...]` reaches the legs intact. A real removal now reads
  `[secret removed by the review runner]`, so a leg cannot mistake it for the author's text.

## v0.8.4 — 2026-09-26

- Source comments, test names and documentation rewritten as self-contained technical
  explanations. Behaviour unchanged; the runtime JavaScript is token-identical.

## v0.8.3 — 2026-09-25

- Updated the registry fixture to assert the v0.8.2 loopback policy: localhost is refused.

## v0.8.2 — 2026-09-25

- The plain-http exception for the compatible-API runner now covers only the literal loopback
  addresses 127.0.0.1 and ::1: the name localhost was dropped because a hosts file can point it
  anywhere. SECURITY.md says the trust file guards against a copied configuration, not against
  code already running as the user. README no longer implies the npm package is published.

## v0.8.1 — 2026-09-25

- Enforced LF on every checkout through .gitattributes so command frontmatter parses
  consistently. The description is a quoted YAML scalar. Windows fixture cleanup tolerates
  transient deletion races.

## v0.8.0 — 2026-09-25

- The plugin is named `tribunal-review` (permanent; the command is `/tribunal-review:review`).
  The unrelated npm package `tribunal` is a separate project.
- Public home: https://github.com/ViktoriousLLC/tribunal-review (Apache-2.0). `plugin.json`
  carries displayName, author, licence, keywords, homepage and repository;
  `claude plugin validate --strict` passes for the plugin and the marketplace.
- npm packaging prepared at the plugin root (`tribunal/package.json`: bins `tribunal-review`,
  `tribunal-review-doctor`, `tribunal-review-probe`; tests and dotfiles excluded). The package
  deliberately declares no module `type` so the CommonJS `.js` hooks retain their module
  semantics. Publishing is a maintainer step described in
  docs/PUBLISHING.md, together with the community-marketplace submission.
- The `openai-api` runner and `claude-plus-api-keys` preset support optional compatible-API
  seats; the example seat remains disabled until configured and authorized.
- A gitleaks policy allowlists the deliberately credential-shaped probe canaries.

## v0.7.0 — 2026-09-25

- Added the metered `openai-api` runner for compatible chat-completions endpoints,
  with per-row timeouts, token usage, pinned pricing, and explicit unpriced results.
- Bound each compatible-API key variable to an origin in the fixed user-home
  `~/.tribunal/trust.json` before credential access. Enforced HTTPS outside loopback,
  one request without redirects or retries, key-only environments, and redacted failures.
- Added the Claude + API keys preset with Opus enabled and a disabled compatible-API
  example, setup and security documentation, and loopback fake-server tests while
  preserving the offline no-telemetry fixture's network restrictions.

## v0.6.0 — 2026-09-24

- Apache 2.0 licensing, security and contribution guides, this changelog, and
  a config example and JSON Schema validated without an additional dependency.
- Ubuntu/Windows CI on Node 20, offline network/process assertions for file
  rounds, portable fake-CLI shims, OS-temp fixtures, and safe runner-test cleanup.
- Self-contained regression explanations in source
  comments and tests.

## v0.5.0 — 2026-09-24

- Added `goalsDir` policy shared by the runner and hooks, including current-content
  hashes for goal reminders and platform-appropriate path comparisons.
- Added an optional Stop-hook goal wall with bounded blocking, visible break-glass,
  an end-to-end fixture, and a do-nothing-guard negative control.
- Made proof posting opt-in through `--post-proof`. Eligible PR rounds print proof
  by default; posting updates the plugin's marked comment or creates one. Metered
  costs come from the banked summary; unknown spend is not reported as zero.

## v0.4.0 — 2026-09-24

- Added machine-readable probe bindings and refusal when an executable, entrypoint,
  CLI version, invocation shape, or enabled unmeasured CLI invalidates the record.
- Added `NO-AGENT-BOUNDARY` for API-only policy. An enabled but unmeasured CLI cannot
  receive a vacuous pass.
- Tracked and cleaned probe scratch in `finally`, including failing measurements.

## v0.3.0 — 2026-09-24

- Added doctor checks for enabled-seat binaries, login, billing, isolation flags,
  credentials, Node version, writable ledger/temp paths, and GitHub CLI availability.
- Added `claude-only` and `claude-plus-chatgpt` presets and shared executable resolution.
- Matched the probe's guarded arguments and allowlisted environment to the runner.
- Added a named missing-`gh` error, removed unsupported CLI fallback pins, and declared
  Node.js 20 as the minimum supported runtime. Gemini's implemented fallback remains.

## v0.2.1 — 2026-09-21

- Documented `envFile` as the path to a gitignored secrets file, environment precedence,
  and behavior when the file or a credential is absent.
- Clarified the available rollback history and ownership of default price pins and
  their expiration dates. These were documentation corrections.

## v0.2.0 — 2026-09-21

- Established the first version-controlled standalone Claude Code plugin snapshot,
  with marketplace packaging, consumer policy, external ledgers, and a reminder hook.
- Included isolated model legs, the recorded-probe gate, runner-assigned rounds,
  convergence refusals, artifact locks, PARTIAL results, recurrence reporting,
  and pinned metered pricing with regression fixtures.
- Included `envFile` policy support, tiered vendor pricing that re-rates the whole
  request, and visible warnings when a Gemini fallback lowers the configured model.

Earlier development predates this repository's tagged history; no earlier release is
represented here as a version-controlled rollback target.
