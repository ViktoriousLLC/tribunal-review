# Security

Tribunal sends the selected artifact and reviewer prompt to the model vendors enabled in
the consuming repository's policy. Review artifacts are untrusted input. The local CLI
processes run as your user and can authenticate through your existing vendor login stores;
their tool restrictions must hold before a review is admitted.

## What a review leg can reach

Claude receives this tool denylist: `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`,
`NotebookEdit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`, `Agent`, `TodoWrite`,
`BashOutput`, `KillShell`, and `SlashCommand`. Its invocation also passes
`--setting-sources ""` and `--strict-mcp-config` to isolate settings and MCP configuration.

Codex runs with `-s read-only`, `--skip-git-repo-check`, `--ephemeral`, and
`--ignore-user-config`. The runner disables `shell_tool`, `browser_use`,
`browser_use_external`, `browser_use_full_cdp_access`, `computer_use`, `image_generation`,
`multi_agent`, `apps`, `enable_mcp_apps`, `plugins`, `remote_plugin`, `plugin_sharing`,
`hooks`, `tool_suggest`, and `skill_mcp_dependency_install`. The complete argv is defined
in [`legRunner.mjs`](tribunal/scripts/legRunner.mjs), shared with the guarded probe.

Each CLI leg receives a fresh `tribunal-leg-*` working directory under `os.tmpdir()`.
Review text is supplied on stdin. The runner attempts cleanup after every result and
only removes paths under the OS temp directory with its own prefix. Separate directories
prevent a later invocation from continuing another leg's working-directory conversation.

Each CLI subprocess receives its registry `envKeys` allowlist plus the OS baseline:
`PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TEMP`, `TMP`, `APPDATA`, `LOCALAPPDATA`,
and `ComSpec`. `CODEX_HOME`, when allowlisted, defaults to the user's `.codex` directory.
Only `requiredEnv` makes an absent variable a missing-credential result. Registry validation
rejects `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GOOGLE_API_KEY` in
agent-leg allowlists and in any leg claiming plan billing. Existing CLI login stores
remain reachable by the CLI for authentication; a temp working directory is not an OS
security boundary.

The optional Gemini leg runs in the runner process through `@google/genai`. It supplies
`GEMINI_API_KEY` to the SDK and sends text without tools, shell access, or model-driven
filesystem access. It is disabled by default and metered when enabled. It does not spawn
a separately isolated process or receive a separate working directory.

## Compatible-API credentials and destinations

An `openai-api` leg runs in its own short-lived Node process using built-in fetch,
without tools or model-driven filesystem access. It is metered and declares exactly one environment
variable in both `envKeys` and `requiredEnv`. Before reading that variable, the runner
requires its name and the destination origin to appear together in the user's fixed
`~/.tribunal/trust.json` file. Its shape is:

```json
{
  "bindings": [
    {"env":"COMPATIBLE_API_KEY","origin":"https://api.example.com"}
  ]
}
```

An origin comprises the scheme, host, and port; the API path prefix is not part of it.
Repository policy cannot choose this trust file, and `ledgerHome` cannot relocate it.
A repository's endpoint declaration therefore cannot authorize its own credential use.
The trust file is a control against a COPIED CONFIGURATION, not against code already running
as the user: any local process that can write the home directory can add a binding, and the
review legs are kept from that only by the tool restrictions the isolation probe measures.
Missing authorization refuses the leg before credential access, names the data and
destination involved, and shows the exact candidate JSON binding without commanding
the user to insert it. The refusal is the moment to stop and think: a copied config
can steal a key by naming an attacker's server. Verify the recipient independently.

Requests require HTTPS, except HTTP to the literal loopback addresses `127.0.0.1` or `::1` (never a name such as `localhost`, which a hosts file can redirect) for local
fixtures. Each leg issues exactly one POST to its configured `/chat/completions`
endpoint, carrying the review in a user message and the key in the bearer header.
Fetch uses `redirect: "manual"`; all redirects fail without following the location.
There are no retries or fallback destinations. The row's `timeoutMs` defaults to
120000. Non-2xx results name the HTTP status and include no more than the first 200
redacted response-body characters; the key must never appear in a failure message.

After authorization, the parent launches the worker with `process.execPath` and only
the declared key variable in its environment. No parent Node startup arguments or
`NODE_OPTIONS` are inherited. Request data enters through private stdin; neither the
review nor the credential appears in process arguments. This fresh process keeps
proxy and certificate settings loaded during the parent's startup out of fetch. Parent
`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, and
`SSL_CERT_FILE` values are excluded. Fetch is not given a dispatcher derived from
those variables, preventing ambient proxy or certificate settings from redirecting
credential handling. Authorization covers sending the review and key to the chosen
origin; it does not establish the provider's retention or privacy practices.

## Isolation probe and binding

Run `node "<installed-plugin-root>/scripts/isolationProbe.mjs"` from the consuming
repository before reviewing. Each enabled CLI type is measured using a random canary
file outside its invocation directories. A permissive control must read and return the
canary; the guarded invocation must not. A control that does not leak is `VACUOUS`, an
errored measurement is `UNKNOWN`, and a guarded leak is `FAIL`. None admits a review.
A separate guarded prompt-injection observation records what happened without replacing
the direct-read boundary measurement. Probe scratch is removed in `finally`.

The record at `<ledgerHome>/isolation-probe.md` includes the probe version, measurement
time, enabled CLI runner types, each resolved executable path and entrypoint prefix,
the CLI version, and a SHA-256 of the invocation arguments with model selection blanked.
The runner compares this binding with the current executable, version, and argv before
dispatch. An old text-only PASS, a changed binding, or a newly enabled unmeasured CLI
requires a new probe. A `--leg` subset cannot certify another enabled CLI. API-only policy
records `NO-AGENT-BOUNDARY`, accepted only while no CLI is enabled.

This is a recorded measurement, not a live proof on every review. Repeat the probe after
CLI upgrades, invocation changes, or changes to what a reviewer may read. The binding is
local state, not a cryptographic signature or a defense against someone who can rewrite
the user's files.

## Automatic review gates

The default Stop hook requires a complete document panel row for the current bytes of a goal
that differs from `origin/main`. The merge gate requires a recorded panel row for an explicit
PR number in `gh pr merge`; it does not verify the PR's current head. Both direct the assistant
to `/tribunal-review:review`. They block at most three times per item per session, then stand
down with a notice. These local controls do not replace repository branch protection.

Consumer config can disable either gate through `gates.goalWall` or `gates.mergeGate`.
The consumer's `.claude/tribunal-wall-breakglass` file bypasses both with a notice;
`TRIBUNAL_ALLOW_UNREVIEWED_MERGE=1` bypasses the merge gate for automation with its own review.
The same local user who can change policy or ledger files can change these controls.

## No secrets in configuration

Configuration and model registries name environment variables and files; they never
contain secret values. Set credentials in your environment or a gitignored `envFile`.
`tribunal.config.json` contains only that file's path. Existing nonempty environment
variables take precedence over file values. Keep credentials, local env files, and CLI
login stores out of commits. Use one account per vendor, without credential pooling,
token proxying, or rotation to bypass plan limits.

## NO-TELEMETRY PROMISE

For local `--file` and `--stdin` rounds, the plugin opens network connections only to the
model vendors the user configured. It sends no analytics, usage reports, crash uploads,
or background requests to the plugin author or any other service: nothing else, ever.

The user's own GitHub is accessed through the user's own `gh` login: selecting `--pr`
explicitly fetches that PR's metadata and diff; only passing `--post-proof` authorizes
posting or updating a proof comment. Without `--post-proof`, eligible PR rounds print the
proof locally. A local file round does not fetch GitHub input or post a proof.

The offline runner fixture in [`noTelemetry.test.mjs`](tribunal/scripts/noTelemetry.test.mjs)
stubs the model boundaries and intercepts network and process entry points during a real
`--file` round, rejecting unapproved hosts and processes. It verifies the plugin's own
dispatch behavior; vendor CLIs and SDKs are separate software with their own behavior.
Its [negative control](tribunal/scripts/noTelemetry.negative-control.mjs) injects
unauthorized network and process attempts and requires the fixture to reject them,
including when the code under test swallows the resulting errors.
The compatible-API tests alone may use their loopback fake server. The no-telemetry
fixture has no loopback exception and continues intercepting network entry points.

## Reporting a problem

Send a minimal reproduction to the repository maintainers through an available private
security-reporting channel. Include the plugin and CLI versions and the affected boundary.
Remove credentials, real canaries, private artifact contents, and local account details
from reports and probe output before sharing them.
