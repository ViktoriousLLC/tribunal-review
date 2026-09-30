# Tribunal Review

The problem today is that when Claude makes a plan, it only knows what it knows, and it cannot judge it, look at it from an objective third-party perspective and analyze it. Codex and Gemini have completely different brains and can critically give feedback. There are many tools that can do this on a metered basis, where you pay per review, but none that use a plan (the Claude or ChatGPT subscription you already pay for).

I built Tribunal Review, a Claude Code plugin that has other AI models review Claude's work using your current plan, and you don't have to pay for metered usage.

## How it works

1. **Install it and connect your accounts.** Paste this into Claude Code and open a new session:

   ```text
   /plugin install tribunal-review --marketplace ViktoriousLLC/tribunal-review
   ```

   Then connect ChatGPT (on your plan, through the Codex CLI, OpenAI's coding agent) and Gemini if you want it (metered, on your own key). Other models are coming soon. Open an issue on this repo if you need one prioritized.

2. **Several models read the same work.** Opus reviews it on the Claude side, plus Fable if you turn it on, and the top two ChatGPT models, Sol and Astra, review it on the ChatGPT side. Each one reviews on its own, without seeing the others. You get one merged list of problems, and the problems only one model caught are listed separately. A review takes 2 to 3 minutes.

## What runs automatically

The whole point of building this was that every PR and every goal statement is automatically run by the Tribunal.

- **Every goal statement.** When Claude writes a goal (the plan it works from on a bigger build), it gets reviewed before Claude can finish its reply.
- **Every pull request.** `gh pr merge` isn't allowed until the pull request has been reviewed.

It reruns up to 10 times. If the review finds problems, Claude fixes them and the Tribunal runs again on the fixed version, so you don't have to keep sitting there asking it to review again and again. It stops the first time a round comes back with nothing to fix.

You can also run it yourself on any file:

```text
/tribunal-review:review docs/plan.md
```

The command is long because Claude Code puts the plugin name in front of every plugin command, and there's no way around it.

## Turning the automatic reviews off

Both automatic reviews are on when you install. If you'd rather it only runs when you type the command yourself, add this to `tribunal.config.json` in your repo:

```json
{ "gates": { "goalWall": false, "mergeGate": false } }
```

Settings, adding models and exit codes are all in [docs/REFERENCE.md](docs/REFERENCE.md).
