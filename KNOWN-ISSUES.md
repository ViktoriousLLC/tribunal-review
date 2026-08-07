# Known issues

Open source does not ship at zero defects. It ships when the paths people actually use are
exercised and the rest is written down. This is the rest.

Nothing here is a surprise to the authors, and nothing here is hidden in a comment.

## Never executed end to end

**The two pay-per-call routes have never run against a real invoice.** A Claude
`ANTHROPIC_API_KEY` with `ALLOW_METERED=true` and no subscription, and the same for
`OPENAI_API_KEY`, are wired and unit-tested but have not been dispatched. This route was
broken for its entire life once already: the step that installs the Codex CLI was gated on
the subscription credential alone, so the metered GPT leg spawned a binary that was never
installed. Every unit test was green, because the tests test pure functions and that was
wiring.

What exists now is a test that reads the workflow's install gates and the reviewer's own
auth-mode functions together, and fails when they disagree
(`workflow-sync.test.mjs`). That closes the class. It is not the same as having run it.

**The cost estimate on a metered leg is an estimate.** It is priced from the leg's own
token counts and is not checked against the provider's invoice. The subscription legs are
the ones with invoice verification. Treat a metered figure as close, not exact, and read
the provider's dashboard for the number that counts.

## Boundaries that are enforced by a denylist

**The Codex leg's capabilities are switched off by name.** `codex exec` is given
`--disable` for every feature that hands the model a shell, a browser, computer control, a
sub-agent, a plugin or an MCP app — sixteen of them, all switched ON by default in
codex-cli 0.144.5. That was measured, not assumed: with the read-only sandbox alone, a
prompt asking the model to print a file outside its working directory returned that file's
contents. `read-only` is a write boundary.

A denylist inherits the obvious weakness. A capability added in a future CLI version
arrives switched on and unnamed. The pin on `@openai/codex@0.144.5` in the workflow is what
stops that happening under a run you did not choose; when you unpin it, re-read
`CODEX_DISABLED_FEATURES` against `codex features list`.

**The Claude leg's is the same shape**, `--disallowedTools` plus `--strict-mcp-config` and
an empty `--setting-sources`, against `@anthropic-ai/claude-code@2.1.220`. Same caveat, same
mitigation. `--disallowedTools` is verified behaviourally too: with a file inside the working
directory and no denylist, the model reads it and returns the contents; with the
comma-joined list, the same prompt answers CANNOT and no read happens.

**`--setting-sources ""` is the one that is only parse-verified.** Nobody has demonstrated
that an empty value loads zero sources rather than falling back to a default. If it silently
means "defaults", ambient user-level hooks, skills and plugins would still load through the
forwarded `HOME` with every assertion green. On a GitHub-hosted runner that set is empty
anyway; on a self-hosted runner it is exactly the thing to check first.

**The mutation baselines were measured on a developer machine, not on a runner.** Both
`break` thresholds therefore carry one point of provisional tolerance. Replace them with the
first scheduled run's own score and close the gap; a gate pinned at zero tolerance to a
number its own environment has never produced cries wolf, which is the failure this package
spends its comments arguing against.

## Known and not yet fixed

**The two Claude legs block the event loop.** `callClaudeCli` uses `spawnSync` while
`main()` fans the four legs out with `Promise.all`. The async `spawnCapture` helper exists
precisely because a synchronous multi-minute child stops the other legs' timers — its own
docstring says so — and the Claude legs do not use it. Consequences: the Codex hard timeout
is not hard, a Gemini retry backoff can be starved past its deadline, and the panel is
closer to serial than parallel. It has not been noticed because a serial panel looks exactly
like a slow one. Found by a full-panel read of this package, agreed by two models.

**`init` never prints the `TRIBUNAL_PACKAGE` command.** The workflow defaults to
`tribunal-review@0.1.0`, which is not published, so a user who follows `tribunal init`
exactly reproduces the documented `npm error 404` on their first dispatch. The command is in
the README and not in `init`'s output, which is the wrong way round.

## Not tested on

- **Anything but `ubuntu-latest`.** Windows and macOS runners, self-hosted runners, and
  container jobs are all unexercised. The seeding step writes a mode-0600 file and assumes
  a POSIX `$HOME`.
- **Repositories with an existing `tribunal.yml`.** `tribunal init` refuses to overwrite,
  which is correct, but the resulting half-configured state has not been walked through.
- **Forks.** `workflow_dispatch` cannot be triggered from a fork, so fork PRs cannot read
  the secrets — that is the safety property, and it also means the panel cannot review a
  fork PR at all.

## Structural limits, stated rather than fixed

- **A dispatched run cannot be a required status check.** Its check attaches to the
  dispatched ref, not to the pull request head. `EVAL_BLOCKING=true` gives you a red run,
  never a blocked merge.
- **The panel reads a diff.** It structurally cannot see two files that have drifted apart,
  a feature that has never executed, or a control that is present but unreachable. Every
  bug that survived several review rounds of this package was one of those three. Do not
  read a quiet panel as a clean system.
- **Large diffs are truncated** at `EVAL_MAX_DIFF_CHARS` (500,000 by default) and the
  comment says so. An empty finding list on a truncated diff means very little.
- **Subscription credentials expire.** Codex rotates roughly every 8 days and the runner is
  ephemeral, so the stored secret goes stale. The leg then fails loudly with the refresh
  command. It never falls back to a credit card.

## Not published

Not on npm. Install it from a pinned git commit; see the README. That means no semver, no
release notes, and an upgrade is you changing a SHA on purpose.
