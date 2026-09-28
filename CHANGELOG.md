# Changelog

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
