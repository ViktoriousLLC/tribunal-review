# Tribunal Review

Cross-model review panel for Claude Code. It reviews pull requests, files, goal statements
and pasted text with a parallel panel of models on the Claude and ChatGPT subscriptions you
already hold, records every attempted round, and refuses to loop: a complete, quiet round on
unchanged content stops it, and a failed leg never counts as agreement.

This directory is the plugin root (what a marketplace entry or the npm package `tribunal-review`
delivers). The full documentation, security notes and changelog live one level up in the
repository: https://github.com/ViktoriousLLC/tribunal-review

## Install

Inside Claude Code v2.1.275 or later:

```text
/plugin install tribunal-review --marketplace ViktoriousLLC/tribunal-review
```

Older versions: `/plugin marketplace add ViktoriousLLC/tribunal-review`, then `/plugin install tribunal-review@viktorious`.

Then `/tribunal-review:review <file>` reviews a file, `/tribunal-review:review <PR number>`
reviews a pull request, and `/tribunal-review:review` reviews the current discussion.
Changed goals are gated at the end of a reply and explicit PR numbers at merge by default.
Set `gates.goalWall` or `gates.mergeGate` to `false` in the consumer's `tribunal.config.json`
to turn off that gate. The file `.claude/tribunal-wall-breakglass` bypasses both with a notice.

## First run

```text
node "<installed-plugin-root>/scripts/doctor.mjs"          # what works, what is missing
node "<installed-plugin-root>/scripts/isolationProbe.mjs"  # measure the reviewer boundary once
node "<installed-plugin-root>/scripts/run.mjs" --file plan.md
```

Installed from npm, the same three commands are `tribunal-review-doctor`,
`tribunal-review-probe` and `tribunal-review`.

Licence: Apache-2.0. No telemetry: the runner opens connections only to the model vendors you
configured (SECURITY.md in the repository states the promise and the fixture that checks it).
