# Tribunal Review

**One model reviewing its own work only knows what it knows. Tribunal Review gives it a second
and a third brain that can disagree with it, on the subscriptions you already pay for.**

You write a plan, a goal statement or a pull request with Claude. Then Claude, Codex and (if
you want) Gemini each read it cold, in parallel, without seeing each other. You get one merged
list of findings, each with the file, why it matters, and how to check it. When a full round
comes back quiet on unchanged content, it stops. A reviewer that did not answer never counts as
agreement, and metered spend is measured or reported as unknown, never as zero.

## Install

Inside Claude Code v2.1.275 or later:

```text
/plugin install tribunal-review --marketplace ViktoriousLLC/tribunal-review
```

Older versions: `/plugin marketplace add ViktoriousLLC/tribunal-review`, then `/plugin install tribunal-review@viktorious`.

Restart the session. That is the whole setup. The panel runs on whatever you have signed in
to: the Claude CLI gives you the Claude seat; the Codex CLI adds two ChatGPT seats; a seat whose
CLI is not installed is skipped and named, never counted as a failure.

## Use

```text
/tribunal-review:review docs/plan.md      a file
/tribunal-review:review 123               a pull request
/tribunal-review:review                   what you were just discussing
```

The first run takes about a minute longer: it measures, once, that the reviewers cannot read
files outside the review and records the result. After that a round takes two to three minutes.

## What a round looks like

- Findings grouped by severity: blocker, suggestion, nit. Each names the file, the reason, and
  the check that proves or refutes it.
- "What only one model saw": the disagreements, which are the point of running three.
- A next step: continue, stop (quiet), or blocked (a reviewer was lost).
- A cost line: subscription seats print `$0 (plan)`; a metered seat prints what it measured.

Every round is written to a ledger on your machine, outside the repository.

## Cost

Claude and Codex seats run on your Claude and ChatGPT subscriptions; nothing here can spend
against an API key for those. Gemini, or any OpenAI-compatible model you add, is metered on a
key you hold and is off by default. The plugin opens network connections only to the model
vendors you configured; that promise is checked by a test, see [SECURITY.md](SECURITY.md).

## Try it before you trust it

A small repository with planted bugs, so a first run has something to find and you can compare:
https://github.com/ViktoriousLLC/tribunal-review-demo

## Reference

Everything below is detail for when you need it: per-repository configuration, adding models,
the automatic review gates, the convergence rules, and how to run the checks.

Two defaults worth knowing. A seat whose CLI is not on this machine is skipped and named in
the round output, not counted as a lost reviewer; naming that seat in `enabledLegs` makes its
absence an error instead. And the isolation measurement runs by itself on the first review, or
again after a CLI upgrade; pass `--no-auto-probe` to make a missing measurement refuse instead.
Both `doctor` and `isolationProbe` remain available as explicit commands:

```text
node "<installed-plugin-root>/scripts/doctor.mjs"          which seats work on this machine
node "<installed-plugin-root>/scripts/isolationProbe.mjs"  measure the reviewer boundary by hand
```

## Per-repository configuration

The runner walks upward from the working directory to a `.git` marker, falling back to the
working directory when none exists. It reads an optional `tribunal.config.json` at that root:

```json
{
  "modelsFile": "review/models.json",
  "reviewerPromptPath": "review/reviewer.md",
  "goalsDir": "plans/goals",
  "gates": { "goalWall": true, "mergeGate": true },
  "ledgerHome": "../tribunal-history/example-project",
  "enabledLegs": ["opus", "sol", "astra"],
  "disabledLegs": ["gemini"]
}
```

All fields are optional (including `preset` and `envFile`). `preset` accepts `claude-only`,
`claude-plus-chatgpt`, or `claude-plus-api-keys` and selects a bundled registry when `modelsFile` is absent; an
explicit `modelsFile` takes precedence. File and directory paths resolve relative to that repository root;
absolute paths are also accepted. Defaults are the bundled `models.default.json`, bundled
`prompts/reviewer-default.md`, `docs/reference/goals` for `goalsDir`, and
`~/.tribunal/<repo-folder>-<hash>/` for `ledgerHome`. The hash is the first
eight hexadecimal characters of SHA-256 over the absolute root path, keeping repositories
with the same folder name separate. `enabledLegs` enables the named registry legs;
`disabledLegs` disables the named legs and takes precedence. Copy the default registry if you
need custom model settings. Config and registries contain environment-variable **names**,
never secret values.
See the [complete config example](tribunal/scripts/tribunal.config.example.json) and
[JSON Schema](tribunal/scripts/tribunal.config.schema.json) for the accepted fields.
To opt into Gemini, include `gemini` in `enabledLegs`, remove it from `disabledLegs`, and
provide `GEMINI_API_KEY` in your environment.

The supported pattern for keys is the config field `envFile`: the path of a
**gitignored** file of `NAME=VALUE` lines. The config carries only that path; the file
carries the secrets, stays out of version control, and its values load only when the
variable is not already set (a real environment always wins). A checkout without the
file still runs; the keyless leg becomes a named not-run.

```json
{ "envFile": ".tribunal.env.local" }
```

Inspect the effective settings without running a panel:

```bash
node "<installed-plugin-root>/scripts/run.mjs" --print-policy
```

The ledger home holds monthly `YYYY-MM.ndjson` files and `isolation-probe.md`. No ledger or
probe is written into the reviewed repository by default. Both gates read this same home.
The merge gate requires a recorded panel row for an explicit PR number; a bare `gh pr merge`
stays silent because it identifies no PR. Goal writes under `goalsDir` get a reminder;
the goal wall enforces review at Stop. Hooks resolve the consumer root by walking upward
from `CLAUDE_PROJECT_DIR` when set, otherwise their working directory, using the same policy
resolution as the runner. Goal paths are matched under that root's configured directory;
case is folded only on Windows and macOS. A goal is **reviewed at this content** only when
its current bytes' SHA-256 appears in a document ledger row with a decision from a complete,
non-PARTIAL round. An older version or an incomplete attempt does not suppress the reminder.
Hooks direct the assistant to `/tribunal-review:review`; they never run a model themselves.
The merge gate checks recorded PR identity; it does not fetch or compare the PR's current head.
Each gate blocks at most three times per session for a given goal's bytes or PR number,
then stands down loudly. Brake state lives under `ledgerHome`; unavailable state also
causes a loud stand-down. Goal verification errors use a bounded `UNVERIFIED` block.
Automation that performs its own review can set `TRIBUNAL_ALLOW_UNREVIEWED_MERGE=1`;
the merge gate allows with a visible notice. Setting `gates.mergeGate` to `false`
retains the merge reminder without blocking.

## Adding any OpenAI-compatible model

Choose the **Claude + API keys** preset with `{ "preset": "claude-plus-api-keys" }`.
Opus is enabled; its compatible-API example is disabled. Copy
[that registry](tribunal/scripts/presets/claude-plus-api-keys.json) to your repository,
select it with `modelsFile`, and edit this example row in its `legs` array:

```json
{
  "$comment": "Example only. Empty price pins are intentionally UNPRICED; configure verified pricesUSDPer1M for the selected model.",
  "leg": "compatible",
  "id": "your-model-id",
  "vendor": "compatible",
  "runner": "openai-api",
  "baseUrl": "https://api.example.com/v1",
  "billing": "metered",
  "envKeys": ["COMPATIBLE_API_KEY"],
  "requiredEnv": ["COMPATIBLE_API_KEY"],
  "timeoutMs": 120000,
  "pricesUSDPer1M": {},
  "enabled": false,
  "note": "Optional OpenAI-compatible reviewer. Set the endpoint, model, and verified price pins before enabling.",
  "disabledReason": "Disabled template. Verify the endpoint and bind its origin in ~/.tribunal/trust.json before enabling this metered leg."
}
```

Replace the example endpoint and model with your provider's values. `envKeys` must name
exactly one key variable, and `requiredEnv` must contain that same name. Supply its value
through your environment or gitignored `envFile`. Once configured and authorized, enable
the row or name `compatible` in `enabledLegs`. This runner uses Node's built-in fetch;
it needs no vendor SDK.

`pricesUSDPer1M` is keyed by the model `id`. Each pin has `in` and `out` rates in USD per
million tokens, with optional `until` (YYYY-MM-DD), `tierAt`, `tierIn`, and `tierOut`.
For example, `"your-model-id": { "in": 1, "out": 2 }` demonstrates the shape with
illustrative rates, not vendor prices. Verify and pin your actual rates. Above `tierAt`
prompt tokens, the tier rates apply to the entire request. Empty, missing, or expired
pins produce a visible **UNPRICED** result, never a fabricated `$0`; absent usage is
also unpriced. Prompt, completion, and reported cached token counts are banked.

The key also needs a separate binding in **`~/.tribunal/trust.json`**, in your user home.
This fixed file cannot be selected by repository config or relocated with `ledgerHome`.
For the example above, its shape and exact binding line are:

```json
{
  "bindings": [
    {"env":"COMPATIBLE_API_KEY","origin":"https://api.example.com"}
  ]
}
```

A binding authorizes one variable name for one origin: scheme, host, and port, without
the `/v1` path. Review the actual destination before authorizing it. The refusal happens
before the runner reads the key and explains what would be sent where. This is the
moment to **stop and think**: a copied config can steal a key by replacing the endpoint.
Keeping authorization outside the repository prevents a copied registry from granting
itself permission to send your key elsewhere.

Each enabled leg makes one POST to `<baseUrl>/chat/completions`, with the configured
`id` as `model`, the review and finding contract as a standard user message, and the key
as a bearer credential. `timeoutMs` is a per-row timeout, defaulting to 120000 (120 seconds).
HTTPS protects the credential in transit; HTTP is allowed only for the loopback hosts
`127.0.0.1` and `::1` (never a name, not even `localhost`, which a hosts file can point anywhere). Redirects are manual: every 3xx fails without a second
request, and there are no retries or fallback endpoints. That keeps a trusted endpoint
from forwarding a key to an untrusted origin. Other non-2xx responses are named leg
failures carrying the status and at most 200 redacted body characters.
The standard `messages` and `usage` shapes are documented in the official
[OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

After authorization, the runner starts a short-lived Node worker whose environment
contains only its one key variable. A fresh process prevents proxy and certificate
settings already loaded by the parent from influencing the request. Proxy and
certificate variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`,
`NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE`) are excluded, and no fetch dispatcher is
built from them. The worker inherits neither Node startup arguments nor `NODE_OPTIONS`;
request data travels over private stdin, and the key never appears in process arguments.
Ambient routing settings cannot silently choose another key recipient.

## What runs automatically

At the end of a reply, the goal wall blocks goals under `goalsDir` that differ from `origin/main`
until a complete panel row covers their exact bytes. At merge, the merge gate blocks
`gh pr merge <PR number>` until that PR has a recorded panel row. Both name `/tribunal-review:review`.

Both gates default to on. To turn either off, set its field to `false` in `tribunal.config.json`:
```json
{ "gates": { "goalWall": false, "mergeGate": false } }
```
The consumer repository's `.claude/tribunal-wall-breakglass` file bypasses both with a loud notice;
remove it to restore the gates. Each gate stands down loudly after three blocks per item per session.

## Convergence and refusal rules

The command file is the source of review judgment: review every PR on its final commit,
every goal before execution, and any artifact on demand. Documentation-only changes count.
An actionable finding is a blocker in correctness, security, money, data loss, or PII, or a
suggestion in those categories independently found by at least two legs. Verify findings
against the code before fixing them, then verify the fix landed before spending another round.

- The runner requires a recorded `OVERALL: PASS` isolation probe.
- When the most recent row for an artifact is QUIET on unchanged content, the runner refuses
  another panel. Change the artifact or pass `--override "reason"`.
- After ten recorded rows for an artifact, another panel is refused unless an override
  reason is supplied. Ten rows are a runaway guard, never proof that the artifact is done.
- Each override is recorded in the row. Convergence refusals explain themselves on stderr.
- The runner assigns monotonic `runnerRound` values per artifact across all months.
  `--round` is rejected with an error naming `runnerRound`.
- An enabled leg failing to answer with parseable findings makes the panel PARTIAL and exits
  non-zero. PARTIAL is never QUIET and cannot satisfy the stop rule.
- An actionable title seen in at least three rows produces a **RECURRING FINDING (channel
  signal)** block with round numbers, in both human and JSON output.

| Exit code | Meaning |
| --- | --- |
| `0` | Successfully recorded QUIET panel, or successful `--print-policy` inspection. |
| `1` | Findings remain, a PARTIAL panel, or another runtime/ledger error. |
| `2` | Already QUIET on unchanged content; change it or supply `--override "reason"`. |
| `3` | Ten or more rows already recorded; supply `--override "reason"` to continue. |
| `4` | Removed `--round` option or missing/invalid `--override` reason. |
| `5` | Isolation-probe record is missing or does not record PASS. |
| `6` | Another attempt holds the same artifact's lock. |

The runner holds an artifact lock from admission through banking, so simultaneous attempts
cannot reuse a round number or bypass the ceiling. Wait for the active attempt to finish.
If a process was interrupted and left a stale lock, read the exact `.lock` file named in the
refusal; its text contains the process ID (PID). Confirm that attempt has stopped before
removing that one lock file and retrying. An override does not bypass the lock or probe gate.

Artifact identity is its PR number or its kind and source. Content identity is the PR head
SHA, file SHA-256, or stdin SHA-256. A QUIET panel only judges the artifact it saw: execute
the relevant behavior to detect drift, unexecuted features, and unreachable controls.

## Accounts and credentials

Use one account per vendor. There is no credential pooling, no token proxying, and no
account rotation to bypass plan limits. Each CLI uses your own existing authentication.
Plan-covered legs receive an allowlisted environment that excludes metered API keys.
The optional Gemini and compatible-API legs are metered and receive only their declared
key variable. Compatible-API keys additionally require the origin binding above. Never put
credentials or `.env` files in this plugin or its repository configuration.

## Local checks

```text
cd tribunal/scripts
npm ci --ignore-scripts
node --test
cd ../hooks
node --test
node --test goal-wall.negative-control.cjs
node ../scripts/noTelemetry.negative-control.mjs
```

The tests inject stub reviewer and process callbacks and do not call real model services.
Only the `openai-api` tests use a loopback fake server; the no-telemetry fixture retains
its network interception without a loopback exception. Packaging follows
the official [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
and [hook reference](https://code.claude.com/docs/en/hooks).

The plugin is licensed under [Apache 2.0](LICENSE). Read [SECURITY.md](SECURITY.md) for
the isolation boundary and no-telemetry promise, [CONTRIBUTING.md](CONTRIBUTING.md) for
fixture and negative-control requirements, and [CHANGELOG.md](CHANGELOG.md) for releases.
Technical design and portability notes are kept in the maintainer's private archive.
