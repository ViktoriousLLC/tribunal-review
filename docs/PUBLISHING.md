# Publishing tribunal-review

Three channels. The first is live once the repository is public; the other two need the
maintainer's own accounts and are one command or one form each.

## 1. GitHub marketplace (live)

The repository root carries `.claude-plugin/marketplace.json` (marketplace `viktorious`, one
entry `tribunal-review` whose source is `./tribunal`). Inside Claude Code v2.1.275 or later:

```text
/plugin install tribunal-review --marketplace ViktoriousLLC/tribunal-review
```

Older versions: `/plugin marketplace add ViktoriousLLC/tribunal-review`, then `/plugin install tribunal-review@viktorious`.

The review command is `/tribunal-review:review <file | PR number>`.

Every release: if it touches the hooks, policy or the ledger row shape, run the break-it pass in
`docs/BREAK-IT.md` first and act on its report. Then bump `version` in
`tribunal/.claude-plugin/plugin.json` AND `tribunal/package.json` (keep them equal), add the
CHANGELOG entry, commit, then tag both ways and push:

```text
git tag -a v0.9.0 -m "v0.9.0: ..."          # the repository's own release tag
claude plugin tag ./tribunal --push          # the plugin tag Claude Code resolves version ranges against
git push origin main --tags
```

`claude plugin validate --strict ./tribunal` and `claude plugin validate --strict .` must both
print `Validation passed` before the tag.

## 2. npm (maintainer runs it)

The npm package root is `tribunal/` (the plugin root), so an npm-sourced marketplace entry
unpacks straight into a valid plugin. Claude Code never runs install scripts on an npm-sourced
plugin, and the package declares none.

```text
cd tribunal
npm pack --dry-run            # read the file list: no tests, no node_modules, no dotfiles
npm login                     # once per machine, the maintainer's own account
npm publish                   # publishConfig.access is public
```

A marketplace entry that points at the npm package instead of the git tree:

```json
{ "name": "tribunal-review", "source": { "source": "npm", "package": "tribunal-review", "version": "^0.9.0" } }
```

Use the package name `tribunal-review`. The unrelated package `tribunal` is a separate project.

## 3. Anthropic's community marketplace (maintainer submits)

Individual authors submit through the Console form:

https://platform.claude.com/plugins/submit

(Anthropic's other submission form is for Team or Enterprise organisations; the Console form
is the one for an individual maintainer.) Run `claude plugin validate --strict ./tribunal` first. Listed
plugins appear in `anthropics/claude-plugins-community`, pinned to a commit SHA, after a delay.
Users then install with `/plugin marketplace add anthropics/claude-plugins-community` and
`/plugin install tribunal-review@claude-community`.

Suggested submission text:

> **Name:** tribunal-review
> **Repository:** https://github.com/ViktoriousLLC/tribunal-review (plugin root: `tribunal/`)
> **Description:** Cross-model review panel for Claude Code. Reviews pull requests, files,
> goal statements and pasted text with a parallel panel of models (Claude, Codex, optionally
> Gemini or any OpenAI-compatible endpoint) on the subscriptions the user already holds. Every
> round is recorded; a complete quiet round on unchanged content stops the loop; a failed leg
> never counts as agreement; metered spend is measured or reported as unknown, never as zero.
> No telemetry: the runner contacts only the model vendors the user configured (fixture-checked).
> Licence Apache-2.0. Demo repository with planted defects:
> https://github.com/ViktoriousLLC/tribunal-review-demo

## A permanent name

Anthropic's docs: a published plugin's `name` is permanent; users' installs are recorded under
it. Change `displayName` for a new label, never `name`, so existing installations retain
their package identity.
