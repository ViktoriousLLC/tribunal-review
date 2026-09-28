---
description: "Review a PR, goal statement, plan, report, or pasted text with the cross-model Tribunal panel. Usage: /tribunal-review:review <path | PR number | nothing, to review what we just discussed>"
---

# /tribunal-review:review — review with the panel on this machine

**This file is the ONLY home for the Tribunal's judgment.** When it runs, what counts as
worth another round, and when the loop stops all live here. Other project instructions
should point here instead of maintaining a second copy. Duplicating a rule across shipping
instructions and CI documentation makes them contradict each other about whether a
docs-only diff earns a panel. The panel reviews much more than pull requests.

The machinery is `${CLAUDE_PLUGIN_ROOT}/scripts/`. This file never restates its internals.

## Run it

For `/tribunal-review:review doctor`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"` from the reviewed repository to report seat and machine readiness.

Run from the repository being reviewed, preserving that working directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" --file <path>            # a goal, a plan, a report, a spec
node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" --pr <n>                 # a pull request diff
node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" --stdin --title "<name>" # pasted text
```

PR rounds print proof text by default; add `--post-proof` to create or update the plugin's marked PR comment.
The default `hooks/goal-wall.js` Stop hook gates changed goals at their current content; the
PreToolUse merge gate requires a recorded panel row for an explicit PR number. Follow their
`/tribunal-review:review` instructions to run the panel. Consumer config can disable either
gate with `gates.goalWall: false` or `gates.mergeGate: false`; see the README.

Add `--json` for the machine shape. The runner assigns `runnerRound` across all recorded
months for this artifact; caller-supplied `--round` is rejected. Every attempted panel is
banked to the resolved ledger home as `YYYY-MM.ndjson`, outside the reviewed repository by
default. Inspect the resolved paths with `--print-policy`.

Concurrent attempts for the same artifact are refused while its lock is held. Wait for the
active attempt to finish. If it was interrupted, the refusal names a `.lock` file whose text
contains its process ID; remove only that stale lock after confirming the attempt has stopped.
An override bypasses the two convergence refusals below, never the lock or isolation gate.

If the user said "use tribunal" with no argument, review the artifact under discussion:
the file just written, the PR about to merge, or the text they just pasted. Ask only if
there are two plausible candidates.

## What it costs

The registry contains the Claude and Codex plan-covered legs, run in parallel on subscriptions
the user already holds. Plan legs never inherit metered API keys. Availability and elapsed
time depend on those plans and CLIs; the registry records which legs are enabled. The Gemini
leg is a disabled, metered template. A repository may enable it through `tribunal.config.json`
and supply the named environment variable itself. The default registry is
`${CLAUDE_PLUGIN_ROOT}/scripts/models.default.json`.

The panel runs on the user's own machine. The hooks request a review when a changed goal or
explicit PR number has no qualifying ledger row; they do not host model calls themselves.

## When it runs

- **Every pull request, on the final commit, right before merge.** A review of a commit you
  then change describes something you are not merging.
- **Every goal statement**, before execution rather than after. Plan reviews can catch bad
  production writes before anyone performs them.
- **On demand, on anything.** This goes beyond the scope of a PR-only CI panel.
- A **docs-only diff is NOT grounds to skip it**. Prose is where the expensive mistakes get
  agreed to.

## What counts as worth another round

A finding is **actionable** when it is:

- a **BLOCKER** in `correctness`, `security`, `money`, `data-loss` or `pii`, or
- a **SUGGESTION** in one of those categories that **two or more legs found independently**.

Everything else is reported and does not earn a round. A lone suggestion is the shape both a
real insight and a hallucination take, and this panel produces many of them.

**Every finding is a hypothesis until you check it against the code.** Even high-severity
findings can be false positives, and a fix applied to a non-bug is damage. The panel prints
a `Check:` line with each finding for exactly this.

## When the loop stops

Fix, re-review, repeat. Then:

- **Stop on the first QUIET round** — a complete panel that returns nothing actionable. Not on
  a count. Real defects may still be found in late rounds; a round budget is not a verdict.
- **A dead leg is never a quiet round.** If any enabled leg did not answer with parseable
  findings, the round is PARTIAL, the tool exits non-zero, and it is not a verdict. Fix the
  leg and re-run. PARTIAL must never satisfy or end the loop.
- **Before spending a new round, re-verify the previous finding is actually gone** and that
  nothing else moved. Fixes can cause new damage, and a planned fix may never have landed.
- **Ceiling of ten**, as a runaway guard only. Hitting it is a signal about the artifact, not a
  clean bill: hand it back rather than declaring it done. The runner refuses another attempt
  after ten recorded rows unless `--override "reason"` is provided; the reason is banked.
- The runner also refuses unchanged content when the latest recorded row for the artifact
  is QUIET. Change the artifact or pass `--override "reason"`. A PARTIAL row cannot trigger
  this refusal. Content identity is the PR head SHA, file SHA-256, or stdin SHA-256.
- When the same actionable title occurs in at least three rows, inspect the
  **RECURRING FINDING (channel signal)** block and its round numbers. Repeated findings are
  a signal to investigate, not a substitute for checking the code.
- **A quiet panel is not a clean system.** The panel reads an artifact; it cannot see two files
  that have drifted apart, a feature that has never executed, or a control that is present but
  unreachable. Prove those by RUNNING things.

## Before you trust a local run

`${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs` refuses to start unless `isolation-probe.md` in the
resolved ledger home records `OVERALL: PASS`. That is a **recorded** pass, not a live
measurement. Re-run `node "${CLAUDE_PLUGIN_ROOT}/scripts/isolationProbe.mjs"` from the reviewed
repository after any CLI version bump, any change to a leg's argv, and any change to what a
leg is allowed to read. The probe invokes the configured CLIs; the hooks never do.
