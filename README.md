# Tribunal Review

Claude checking its own work has the same blind spots it had while writing it. Tribunal Review has other AI models check it too.

Every goal Claude writes and every pull request it opens gets reviewed by ChatGPT (through the Codex CLI) and, if you turn it on, Gemini. Each model reviews on its own, without seeing the others. You get one list of the problems they found, including the ones only one model caught. It runs on the Claude and ChatGPT subscriptions you already have, so it costs nothing extra.

## Install

Paste this into Claude Code, then start a new session:

```text
/plugin install tribunal-review --marketplace ViktoriousLLC/tribunal-review
```

If the Codex CLI is installed and signed in, ChatGPT joins the review. Without it, only Claude reviews.

## What runs automatically

1. **Pull requests.** `gh pr merge 123` is blocked until PR 123 has been reviewed.
2. **Goals.** When you change a goal file, Claude can't finish its reply until that version has been reviewed.

To review anything else yourself:

```text
/tribunal-review:review docs/plan.md      a file
/tribunal-review:review 123               a pull request
/tribunal-review:review                   the current conversation
```

To turn either automatic review off, add this to `tribunal.config.json` in your repository:

```json
{ "gates": { "goalWall": false, "mergeGate": false } }
```

## What you get back

- The problems found, sorted by how serious they are, each with the file and how to check it.
- The problems only one model found. Those are the reason to use more than one.
- Whether to keep going or stop. When a review comes back with nothing new, it stops.
- What it cost. Subscription models show `$0 (plan)`.

A review takes two to three minutes. The first one takes about a minute longer.

## Cost

Claude and ChatGPT run on your subscriptions. Gemini is off by default and is paid per use on your own API key. The plugin only talks to the AI companies you set up ([SECURITY.md](SECURITY.md)).

## Try it

A small repository with planted bugs to test it on:

https://github.com/ViktoriousLLC/tribunal-review-demo

Settings, adding other models and everything else: [docs/REFERENCE.md](docs/REFERENCE.md). Licence [Apache 2.0](LICENSE).
