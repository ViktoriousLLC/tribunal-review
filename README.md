# Tribunal Review

When you write something with Claude, you need two brains. Claude only knows what it knows. This plugin gives it a second and a third one that can contradict it: Codex reads the same plan or pull request cold, and Gemini too if you want, in parallel, without seeing each other's answers. You get one merged list of what they found, and it runs on the Claude and ChatGPT subscriptions you already pay for.

## Install

One line inside Claude Code, then restart the session:

```text
/plugin install tribunal-review --marketplace ViktoriousLLC/tribunal-review
```

That's it. The panel runs on whatever you're already signed in to. The Claude CLI gives you the Claude seat and the Codex CLI adds two ChatGPT seats, and a seat whose CLI isn't installed just gets skipped and named in the output, so a missing tool never counts as a failed review.

## What happens after that

Two things happen on their own, and one you ask for.

1. Every pull request gets reviewed before it merges. `gh pr merge 123` is blocked until the panel has looked at PR 123. It blocks at most three times in a session, then stands down and says so.
2. Every goal statement gets reviewed before Claude stops. If a goal file in your goals folder differs from `origin/main`, Claude can't end its reply until a full panel round has covered exactly those bytes.
3. Anything else, you ask for:

```text
/tribunal-review:review docs/plan.md      a file
/tribunal-review:review 123               a pull request
/tribunal-review:review                   what you were just discussing
```

The plugin name sits in front of the command because Claude Code puts it in front of every plugin command, so two plugins can both ship a `review` without colliding. There's no way to drop it from inside a plugin.

## What a round gives you

- Findings grouped by severity (blocker, suggestion, nit), each with the file, why it matters, and the check that proves or refutes it.
- The disagreements, under "what only one model saw". That list is why you run three.
- A next step: keep going, stop because the round came back quiet, or blocked because a reviewer was lost.
- A cost line. Subscription seats print `$0 (plan)`, and a metered seat prints what it actually measured.

A reviewer that didn't answer never counts as agreement. A full round that comes back quiet on unchanged content ends the loop, and the runner refuses to run again until the content changes. Every round is written to a ledger on your machine, outside the repository.

The first run takes about a minute longer: it checks once that the reviewers can't read files outside the review, and records that. After that a round takes two to three minutes.

## Cost

Claude and Codex seats run on your subscriptions, and nothing here can spend against an API key for those two. Gemini, or any OpenAI-compatible model you add, is metered on a key you hold and is off by default. The plugin only talks to the model vendors you configured, and a test in CI checks that promise ([SECURITY.md](SECURITY.md)).

## Try it on the demo repo

A small repository with planted bugs, so a first run has something to find:

https://github.com/ViktoriousLLC/tribunal-review-demo

## Everything else

Turning a gate off, adding a model, per-repository settings, the exit codes, running the checks: [docs/REFERENCE.md](docs/REFERENCE.md). Licence [Apache 2.0](LICENSE).
