# Tribunal

**It reviews your pull requests on the AI subscriptions you already pay for, and it proves what each run cost by reading the provider's invoice.**

Not another API key with a meter running. If you have a Claude subscription and a ChatGPT subscription, you already have everything two of the three review legs need, and they add nothing to your bill. The only optionally-metered leg is Gemini, and it stays off until you set `ALLOW_METERED=true` on purpose.

The second half matters more than it sounds. Most tools that claim to be free are inferring it from a config flag. This one asks the provider's own usage API what it was actually billed, before and after the run, and reports the difference. When it cannot get an answer it prints **unverified** rather than a number it made up.

That exists because of a specific failure. For nine days this panel printed `$0.0000 (plan)` on every pull request while billing a metered API key about $62. Three separate surfaces each inferred "free" from the presence of a subscription token, and none of them measured. The lesson is in the code now: **a claim of free that nothing measured is not evidence, it is an echo.**

What it does with the diff, since you asked: several models review it independently from a fresh context, a blinded judge that cannot see which model produced which finding reconciles and ranks them, and one comment is posted and upserted on re-runs.

## The first five minutes

> **Not on npm yet.** Until it is, `npx tribunal-review` has nothing to fetch. Run the CLI
> straight from a clone (`node bin/tribunal.mjs init`), and point the workflow at a
> checkout instead of the registry:
> `gh variable set TRIBUNAL_PACKAGE --body 'github:OWNER/REPO#main'`.
> The workflow prints exactly that command if the install step fails, rather than leaving
> you with a bare npm 404.

```
npx tribunal-review init
```

Four questions. It never asks for a secret's value, only for which kinds of access you have, so it knows which review legs to switch on. Then it writes `.github/workflows/tribunal.yml` and a starter `.tribunal/review-gates.md`, and prints the exact `gh secret set` commands to paste.

```
npx tribunal-review doctor
```

Prints which credentials are present in the current environment, and for each missing one, what it would unlock. Safe to run in CI. It reads presence, never values, and prints no secret.

Then, on the final commit of a pull request:

```
gh workflow run tribunal.yml -f pr_number=42
```

## What runs with what you have

| You have | Legs that run | What the comment says |
|---|---|---|
| Nothing | none | it still posts a comment, naming every leg that could not run and what would enable it. Exits 0, no red X on your PR. |
| A Claude subscription | reviewer + judge | names the legs that did not run, and why |
| Claude + a ChatGPT subscription usable by the Codex CLI | two reviewers + judge | same |
| The above plus a Gemini API key **and** `ALLOW_METERED=true` | three reviewers + judge | states that the metered leg ran and across how many billed attempts. The dollar figure stays in the CI log, not in a public comment |
| Plus organisation admin keys | unchanged | costs are **verified against the invoice** instead of reported as unverified |

Two things follow from that table and both are deliberate.

**A configured leg that could not run is always named in the comment.** It never silently disappears. Silence reads as a clean review, and that is exactly the failure this tool was built around.

**A metered key alone never starts billing you.** The Gemini leg needs the key *and* the explicit `ALLOW_METERED=true` opt-in. Two locks, because installing a tool should not be able to open an account with a payment method attached.

## Running the tests

201 tests, no dependencies, no build step:

```
npm test
```

They run on every pull request here too. A guard nothing exercises is the exact defect
this package exists to catch, so it would be poor form to ship one.

## The one file that makes it yours

`.tribunal/review-gates.md` is read at review time and prepended to every reviewer's instructions. Write down the mistakes your project actually makes. A gate that says "look for bugs" changes nothing. A gate that names your own recurring failure is worth ten generic ones. Without the file the panel still works and reviews generically.

Point it somewhere else with `TRIBUNAL_GATES_FILE`. If you already use Claude Code and have `.claude/agents/change-reviewer.md`, that is picked up automatically with no configuration. If you set `TRIBUNAL_GATES_FILE` and the file cannot be read, the run says so loudly rather than quietly falling back.

**The gates file is read from your default branch, not from the pull request.** That is deliberate: an untrusted pull request must not be able to rewrite the reviewer's own instructions. It also means edits to your gates file take effect after they merge, not while you are iterating on them in a branch.

## What you need installed

Node 20 or newer, the GitHub CLI for the setup commands, and a GitHub repository with Actions enabled. The panel itself has no runtime dependencies; the workflow installs the provider CLIs it needs, and only the ones your credentials enable. Everything installs into a scratch directory on the runner, never into your repository's `node_modules`.

## Assumptions, stated plainly

- **GitHub, with Actions.** No GitLab, no Bitbucket.
- **Dispatch, not automatic.** It runs when you fire it, on the commit you are about to merge. It does not review every push, on purpose: that reviews snapshots you are about to change, and bills for each one.
- **Advisory, and it cannot be made blocking as shipped.** A dispatched run's check attaches to the dispatched ref, not to the pull request head, so it never becomes a required status check. Making it blocking would mean triggering on every push, which is the trade this workflow deliberately does not make.
- **The diff is truncated** past a size limit. On a very large pull request the models see part of it, so an empty finding list on a huge diff means less than it looks like.
- **The Codex CLI version is pinned** because the parser is coupled to that version's JSON event shape. A newer CLI may break the GPT leg.
- **Codex plan tokens rotate roughly every eight days** and the runner is ephemeral, so the stored secret eventually goes stale. When it does, the GPT leg fails loudly in the comment with the exact refresh command. It never falls back to a credit card.
- **Comments carry ticket ids from the repository this came out of.** They resolve to nothing public. They are kept because the reasoning in those comments is the useful part.

## If your setup differs

| Situation | What happens |
|---|---|
| No credentials at all | Posts a comment saying no legs ran and what each one needs. Exits 0, no failed check. |
| Only some credentials | Runs those legs, names the rest as not run. |
| No `.tribunal/review-gates.md` | Generic review, plus a log line telling you what you are missing. |
| Your own infrastructure email addresses in the diff | Redacted before the models see them, unless you list your domains in `TRIBUNAL_EMAIL_KEEP_DOMAINS`. **Use bare names with no dot and no TLD**: `TRIBUNAL_EMAIL_KEEP_DOMAINS=my-product,my-org`, not `my-product.com`. An entry containing a dot is rejected and the run logs which one it dropped. |
| A fork opens the pull request | A fork cannot dispatch the workflow, so no fork can start a run that holds your secrets. Note the limit of that guarantee: if **you** dispatch it against a fork PR number, fork-authored diff content is read by a job that holds them. The diff is data, never instructions, and secrets are never echoed, but dispatch a fork PR only when you would review it by hand. |
| The provider changes its usage API | Cost verification degrades to **unverified**. It never guesses. |

## Support

Provided as-is. Issues may not get a response. Forks are welcome.

## License

MIT.
