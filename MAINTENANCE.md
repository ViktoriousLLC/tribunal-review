# Maintaining the tribunal plugin

## Ownership split

- The plugin owns mechanism: the runner and its refusal loop, isolation and leg
  runners, parsing and pricing code, the command, hooks, neutral default prompt,
  bundled presets, and `models.default.json`.
- Each consuming repository owns policy: its `tribunal.config.json`, custom model
  registry and price pins, reviewer prompt, and goals directory. Configuration names
  environment variables and the path to a gitignored `envFile`; that file holds secret
  values, which load only when the environment has no nonempty value for the name.
- Ledgers and probe records live per machine in `~/.tribunal/<repo-slug>/` by default.
  They belong to neither repository; `ledgerHome` can select another location.

## Release and upgrade

1. Make the change and add or adjust red-first fixtures. Prove a new blocking fixture
   fails against a do-nothing guard, following [`CONTRIBUTING.md`](CONTRIBUTING.md).
2. Run `npm ci --ignore-scripts` and `node --test` in `tribunal/scripts`, then
   `node --test` and `node --test goal-wall.negative-control.cjs` in `tribunal/hooks`.
   Run `node ../scripts/noTelemetry.negative-control.mjs` from there too.
   Check the Ubuntu and Windows CI results.
3. Update [`CHANGELOG.md`](CHANGELOG.md), bump `version` in
   `tribunal/.claude-plugin/plugin.json`, commit the release, and tag `vX.Y.Z`.
4. Push the release and tags to the plugin's GitHub repository:
   `git push origin main --tags`.
5. For the folder marketplace documented in the README, start a new Claude Code
   session to load the updated files. Re-run the consuming repository's isolation
   probe after a CLI or invocation change.

Release commands are maintainer operations after review; ordinary development changes
can remain uncommitted until ready for that release.

## Downgrade

With local work preserved, use `git log --oneline` to identify a release, then
`git checkout vX.Y.Z` to load it at the next session. Use `git checkout main` to return
to the development branch. Available releases are listed in the changelog; maintenance
design notes are kept in the maintainer's private archive.

## Price updates

Prices are pinned per model ID in a registry's `pricesUSDPer1M`, with the vendor source
and read date in `pricesSource`. Refresh a pin from its source and ship the registry
change through its owner's review process. The plugin maintains pins in the bundled
registry and presets; consuming repositories maintain their own overrides.

The pricing code reports an absent or expired pin as unpriced, never as zero. Tiered
prices use `tierAt`, `tierIn`, and `tierOut` to re-rate the whole request. Keep `until`
dates current. Plan-covered CLI legs carry no spend-capable API key in their allowed
environment and are recorded as zero incremental metered dollars; API legs use pins.

## Model changes

Add, remove, or swap a model through a row in the owning registry, verify availability
on the user's account, and probe the configured CLI boundary before use. New providers
require a supported runner and registry validation, plus fixtures for credentials,
isolation, outcomes, and pricing. A registry row alone cannot implement a new transport.

## Avoid duplicate implementations

A consuming repository's CI merge gate remains that repository's responsibility;
the plugin owns local reviews. Keep this boundary explicit when either implementation
changes so copied policy and mechanism do not silently drift apart.
