# Contributing

The plugin owns review machinery; consuming repositories own policy. Keep that boundary
when changing the runner, prompts, model registry, or hooks. See
[`MAINTENANCE.md`](MAINTENANCE.md) for release and pricing responsibilities.

The manual review command is `/tribunal-review:review`, defined in
[`review.md`](tribunal/commands/review.md). Goal and merge gates are enabled by default;
keep their opt-outs, bounded blocking, and visible bypass notices covered by fixtures.

Use Node.js 20 or newer. From the repository root, run:

```text
cd tribunal/scripts
npm ci --ignore-scripts
node --test
cd ../hooks
node --test
node --test goal-wall.negative-control.cjs
node ../scripts/noTelemetry.negative-control.mjs
```

CI runs these commands on Ubuntu and Windows. Fixtures stub model calls and GitHub
operations; tests must not invoke a real model service, post comments, or modify Git
state. Use `os.tmpdir()` for disposable repositories, mutation copies, fake executables,
logs, and other scratch. Before recursive cleanup, verify the resolved target belongs
to the fixture that created it. Preserve both platform shims when adding fake CLIs:
Windows uses a `.cmd` with its sibling JavaScript entrypoint; POSIX uses an executable
shell script that runs the same entrypoint with Node.

New behavioral fixtures are red-first. Add the assertion, deliberately break the rule
in a disposable copy, and observe the intended failure before accepting the working
implementation. Record the mutation and failing assertion in the test's comment. A
failure caused only by setup, an unavailable dependency, or zero discovered tests does
not establish that the fixture can catch the regression. Keep existing regression tests.

A guard's blocking fixture must fail against a do-nothing guard. The goal wall's
[`negative control`](tribunal/hooks/goal-wall.negative-control.cjs) substitutes that guard
and runs the same fixtures with their expected blocking outcomes reversed to allow.
The control itself passes only when the fixture suite executes and those requests are
observed as allowed; it also rejects an empty test run. Run this control after both
suites. A silent do-nothing implementation passing the ordinary blocking assertions is
a broken fixture, even if every other test is green.

The [network negative control](tribunal/scripts/noTelemetry.negative-control.mjs)
requires the offline runner fixture to fail when unauthorized network or child-process
calls are added, even if the runner swallows the interception error.

Use self-contained, plain-English comments explaining the failure mode a regression test
prevents, without dates, incident narratives, or private ticket references. Keep secrets out
of configuration, fixtures, patches, and logs; the
credential and isolation rules are documented in [`SECURITY.md`](SECURITY.md). Add the
user-visible change to [`CHANGELOG.md`](CHANGELOG.md) under Unreleased and report the
test counts and any platform checks that could not run locally.
