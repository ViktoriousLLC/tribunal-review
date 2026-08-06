# Tribunal

**Several AI models review your pull request independently. A blinded judge reconciles what they found. It runs on the AI subscriptions you already pay for.**

- **No new bill.** A Claude or ChatGPT subscription is enough. Both legs run at no per-call cost. An API key works instead if you have no subscription, billed per call, and only after you explicitly opt in.
- **Independent, then reconciled.** Each model reads the diff cold, in its own context. A judge that cannot see which model produced which finding merges the duplicates, ranks what is left, and says where they disagreed.
- **It tells you what it cost.** Where it can, it checks the run against the provider's own billing API. Where it cannot, it says **unverified** rather than printing a zero it did not measure.

## Quick start

Not on npm yet, so clone this repository and run it from there:

```
git clone https://github.com/ViktoriousLLC/tribunal-review && cd tribunal-review
node bin/tribunal.mjs init
```

Four questions about what access you have. It never asks for a secret's value. It writes your workflow and prints the exact `gh secret set` commands for the answers you gave. Then point your workflow at this repository, which it will also tell you to do if you forget:

```
gh variable set TRIBUNAL_PACKAGE --body 'github:ViktoriousLLC/tribunal-review#main'
```

```
node bin/tribunal.mjs doctor --repo
```

Asks GitHub what your repository actually has, and tells you which reviewers will run on your next dispatch. This is the "did my setup work" command.

```
gh workflow run tribunal.yml -f pr_number=42
```

Run it on the commit you are about to merge. It posts one comment and updates that same comment on re-runs.

## What you get for what you have

| You have | What runs |
|---|---|
| Nothing | No reviewers. It still comments, naming each leg and what would enable it, and exits without failing your build. |
| A Claude subscription | Two reviewers plus the blinded judge |
| Claude and ChatGPT subscriptions | Three reviewers plus the judge |
| Either of the above, plus a Gemini key and `ALLOW_METERED=true` | Four reviewers plus the judge |
| An API key instead of a subscription | The same reviewers, billed per call |
| Plus read-only billing keys | Costs verified against the invoice instead of reported as unverified |

Two rules hold throughout. **A leg that could not run is always named in the comment**, because silence reads as a clean review. And **a key alone never starts billing you**: anything metered needs the key *and* `ALLOW_METERED=true`.

## Make the review yours

`.tribunal/review-gates.md` is prepended to every reviewer's instructions. Write down the mistakes your project actually makes. "Look for bugs" changes nothing; one gate naming your own recurring failure is worth ten generic ones. Without the file it still works and reviews generically.

It is read from your default branch, never from the pull request, so an untrusted PR cannot rewrite the reviewer's own instructions.

## Why it checks its own bill

Tools that claim to be free usually infer it from a config flag rather than measuring. That inference fails quietly: a panel can report `$0.0000 (plan)` on every pull request while an API key is being charged the whole time, because the key silently outranks the subscription token in the CLI's auth order.

So this one asks the provider what it was actually billed, before and after each run. If it cannot get an answer it prints unverified. Subscription and API credentials are never placed in the same environment, and the subscription always wins, so the situation that causes that failure cannot arise.

## Requirements and limits

Node 20 or newer, the GitHub CLI, and a GitHub repository with Actions on. No runtime dependencies; the workflow installs the provider CLIs your credentials enable, into a scratch directory, never into your `node_modules`.

- **GitHub only**, with Actions.
- **You dispatch it**, it does not review every push. That is deliberate: reviewing snapshots you are about to change costs time and money for nothing.
- **Advisory.** A dispatched run cannot be a required status check, so it never blocks a merge.
- **Large diffs are truncated**, and the comment says so. An empty finding list on a huge diff means less than it looks like.
- **Subscription credentials expire** (roughly weekly for Codex). When one does, that leg fails loudly in the comment with the refresh command. It never falls back to a credit card.

## Support

Open an issue. MIT licensed.
