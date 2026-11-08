# Tribunal Review reference

Everything the front page leaves out: per-repository configuration, adding models, the automatic review gates, the convergence rules, exit codes, and how to run the checks. Start with the [README](../README.md).

## Install on an older Claude Code

The one-line install needs Claude Code v2.1.275 or later. Older versions take two commands: `/plugin marketplace add ViktoriousLLC/tribunal-review`, then `/plugin install tribunal-review@viktorious`.

## Two defaults worth knowing

A seat whose CLI is not on this machine is skipped and named in
the round output, not counted as a lost reviewer; naming that seat in `enabledLegs` makes its
absence an error instead. And the isolation measurement runs by itself on the first review, or
again after a CLI upgrade; pass `--no-auto-probe` to make a missing measurement refuse instead.
Both `doctor` and `isolationProbe` remain available as explicit commands:

```text
node "<installed-plugin-root>/scripts/doctor.mjs"          which seats work on this machine
node "<installed-plugin-root>/scripts/isolationProbe.mjs"  measure the reviewer boundary by hand
```

## Model versions and effort

Claude seats use CLI aliases (`opus`, `fable`), which the Claude CLI resolves to its newest
model. Codex seats keep a pinned `id` and may declare `family` (for example, `sol` or
`astra`). Tribunal selects the highest numeric version in that family from
`$CODEX_HOME/models_cache.json` (default `~/.codex`), excluding hidden models. If the
installed Codex CLI is older than the list's `client_version`, it keeps the pin and prints
an upgrade notice when a different model is available. Missing or unreadable cache/version
information also keeps the pin and prints a notice. Two enabled seats never resolve onto one
model: a family seat takes the newest model no other seat holds. Every Codex client on the
machine rewrites that list for its own version, so when two Codex versions are installed the
chosen model can change from one review to the next; the printed model is what ran.

No effort override is sent by default. Set a leg's optional `effort` to `low`, `medium`,
`high`, `xhigh`, `max`, or `ultra` to override it; the vendor CLI decides which levels its
model supports. Status lines and the review footer show the answering model and effort,
labelled as set or model default (including Codex's default level when the cache reports
it). Each ledger leg banks the answering `model` and displayed `effort`. Claude's JSON
reply supplies its actual model identity, including for the judge.

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
See the [complete config example](../tribunal/scripts/tribunal.config.example.json) and
[JSON Schema](../tribunal/scripts/tribunal.config.schema.json) for the accepted fields.
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
The merge gate requires a COMPLETE panel row for its PR number: a diff round whose decision is
not PARTIAL or UNREADABLE and on which at least two DISTINCT models answered and parsed (one
model is not a panel, a registry shrunk to one leg completes every round by construction, and two
seats on one model are still one opinion). A complete round
that still found actionable findings unlocks the merge, because the gate proves a review
happened and the operator reads the verdict; the gate then shows a `systemMessage` naming the
latest round and its actionable count. It is silent only after a `QUIET` round: any other
verdict warns, including a `REDO`, where the previous round's findings are still present.
Legs count only with kind `answered` and a named model, so a leg with no model fails closed. The newest incomplete round with a recorded verdict that found findings (a
leg hit its plan limit after a fix), when it is newer than the latest complete round, cannot
unlock the merge, but is named in the same notice rather than hidden behind the older complete
round. A row with no recorded verdict (a crashed round) is not shown. Two models is the gate's floor; the PR proof comment needs three
(`MIN_PROOF_LEGS`), so a two-model panel unlocks the local gate and posts no proof. The goal
wall applies the same floor but does not warn on findings. A merge that names no number (the current branch, a branch name, a variable,
a GraphQL node id) cannot be checked, so it blocks as `UNVERIFIED` and asks for the number,
under one three-block budget per session shared by all unnumbered merges. A REST merge (`gh api ... pulls/<n>/merge`) counts as a merge
of that PR. It reads commands from both the Bash and PowerShell tools and finds a merge in any
piece a shell runs (after a newline, `;`, `&&`, `|`, `&`, a subshell or command substitution),
after shell keywords, common wrappers (`env`, `exec`, `timeout`, `nice`, `winpty`, `npx`,
`cmd /c`), a leading redirection, `VAR=value` or PowerShell's `$out =`, and with gh's own `-R`
before `pr`. Quoted text, a heredoc body and a PowerShell here-string are prose, except a command
substitution inside them, which the shell runs. Not seen: a merge inside `bash -c "..."`, `powershell -Command "..."`, a
script file, an alias or a deliberately escaped name (`g\h`). A merge in a branch or function
that never runs still blocks. Rows carry no repository, so a review of another repository's
PR #7 (a shared `ledgerHome`, or `--pr 7 --repo other/x`) unlocks this one's PR #7. The parser
is a guard against forgetting the review, not against someone hiding a merge from it. Goal writes under `goalsDir` get a reminder;
the goal wall enforces review at Stop. Hooks resolve the consumer root by walking upward
from `CLAUDE_PROJECT_DIR` when set, otherwise their working directory, using the same policy
resolution as the runner. Goal paths are matched under that root's configured directory;
case is folded only on Windows and macOS. A goal is **reviewed at this content** only when
its current bytes' SHA-256 appears in a document ledger row from a complete round (the merge
gate's rule: not PARTIAL or UNREADABLE, at least two distinct models read). An older version or
an incomplete attempt does not suppress the reminder. The goal wall checks goal files that
differ from `origin/main` in this checkout, so a goal written, merged and pulled back within one
reply, or written in a sibling worktree, is not checked at Stop. The merge gate still asks for a
review of that PR's diff, which contains the goal text, but that is a code review, not a review
of the goal statement.
Hooks direct the assistant to `/tribunal-review:review`; they never run a model themselves.
The merge gate checks recorded PR identity; it does not fetch or compare the PR's current head.
Each gate blocks at most three times per session for a given goal's bytes or PR number,
then stands down loudly. Brake state lives under `ledgerHome`; unavailable state also
causes a loud stand-down, shown as a `systemMessage` (Claude Code does not show stderr when a
hook allows). Goal verification errors use a bounded `UNVERIFIED` block. Each hook has a
60-second timeout and its own 40-second budget: Claude Code lets the action through when it
kills a hook, so a check that runs out of time blocks as `UNVERIFIED`, through the same brake.
The budget is checked between git calls and ledger reads; a single read, or loading the policy
files, that hangs past the timeout is still a pass. `TRIBUNAL_HOOK_BUDGET_MS` (whole
milliseconds, at most 40000) shortens the budget for tests; an empty or malformed value keeps 40000.
Automation that performs its own review can set `TRIBUNAL_ALLOW_UNREVIEWED_MERGE=1`;
the merge gate allows with a visible notice. Setting `gates.mergeGate` to `false`
retains the merge reminder without blocking.

## Adding any OpenAI-compatible model

Choose the **Claude + API keys** preset with `{ "preset": "claude-plus-api-keys" }`.
Opus is enabled; its compatible-API example is disabled. Copy
[that registry](../tribunal/scripts/presets/claude-plus-api-keys.json) to your repository,
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
- When this round and the previous round (`runnerRound` minus one) of the same artifact both
  have actionable findings on one **mechanism**, a **STOP PATCHING: <mechanism>** block names
  both rounds, what each found, and the three choices: cut it (revert), redesign it once (only
  if that removes machinery), or ship it behind an off-by-default switch. A `Next:` line that
  would say CONTINUE says STOP PATCHING instead and still names the unchanged verdict. It is
  advice: no decision, count, gate or exit code changes. The row banks `stopPatching` as
  `[{ mechanism, rounds }]`; JSON output adds `stopPatching` and `stopPatchingSignal`. The
  mechanism key is the finding's `file`, normalised (slashes, a leading `./`, a trailing
  `:line`, case, a diff's `a/` or `b/` side prefix), with a path-suffix match so `src/x.js` and `x.js` agree; a placeholder such as `N/A` is no file. The finding contract
  has no function field, and the spiral this catches is a new title each round, so a title key
  would miss it. In a single-file review every finding names that file, so there the block
  means "this file drew findings twice running"; a finding with no file never signals.

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

### Blinded judge (trial)

After each local panel round with single-model findings, the judge makes one extra Claude CLI
call. It prefers the enabled, non-advisory `opus` seat, otherwise the first enabled,
non-advisory Claude CLI seat. It reads the same artifact message as the reviewers and only
the non-nit findings raised by exactly one reviewer, with reviewer identities removed, then annotates
each with keep or likely false positive and a reason.

This is annotation only: it changes no findings, actionable count, decision, proof, exit code,
or gate. It fails open on an unavailable leg, failed or unparseable reply, or any other judge
error. The ledger's `judge` field records whether it ran, its model or skip reason, and, when
it ran, counts and, per finding, its id, title, the seat that raised it, the verdict and the
reason. Only a seat that answered this round can judge, the judge is skipped when fewer than
two reviewers answered (every finding would be "lone" and self-judged), and its call has a
five-minute timeout. The judge is usually the same model as
one of the reviewers: it is blinded, not independent, so the ledger keeps the raising seat to
let the trial measure whether it favours its own findings. Its call is one plan-covered Claude
CLI call and is not in the metered cost line. It is on by default; set `"judge": false` in
`tribunal.config.json` or pass `--no-judge` to turn it off.

## PR scorecard

From the reviewed repository, inspect a PR's cumulative results:

```text
node "<installed-plugin-root>/scripts/scorecard.mjs" --pr 123
node "<installed-plugin-root>/scripts/scorecard.mjs" --pr 123 --json
node "<installed-plugin-root>/scripts/scorecard.mjs" --pr 123 --mark "P1:real:Added the missing ownership check" --mark "P2:not-real:The caller already validates this"
node "<installed-plugin-root>/scripts/scorecard.mjs" --pr 123 --mark "P3:duplicate=P1:Same underlying defect" --mark "P4:unsure"
```

**Total** is the sum of counted reviewers' findings across complete rounds. **Unique** is
the number of problems matched across those rounds using the panel's file/title similarity
rule. Problems are assigned `P<n>` IDs in monthly file name and append order, so backdated
timestamps in later rows do not change existing IDs. **Real** means a
code change was made because of that problem. Mark it real only after making that change;
`not-real` and `duplicate=P<n>` require a reason. `unsure` records an unresolved judgment.
Marks are repeatable arguments; the latest appended mark for an ID wins. A duplicate folds
its reviewer credit and Judge evidence into the target problem, whose mark decides whether
it is real. Duplicate chains are allowed; new marks with cycles or unknown IDs are refused
with exit 4. Stored duplicates with missing targets or cycles stay unfolded and unmarked,
with a warning. Invalid stored marks do not prevent corrections or marking other problems.

The table shows each reviewer seat, the model IDs seen, total findings, unique problems,
problems found by that seat alone, and real/not-real counts. PARTIAL and UNREADABLE rounds
are skipped and reported. Finding lists start with v0.13 rounds; older rounds still contribute
to total findings, with a `unique: not recorded` note. No old findings are reconstructed.
Every banked run prints a short cumulative scorecard line.

The Judge check compares its keep/demote annotations with operator marks: demoted-but-real
(Judge wrong), kept-but-not-real, demoted-and-not-real, kept-and-real, and unmarked/unsure.
A problem counts once per verdict type; a problem kept in one round and demoted in another
can appear in both relevant categories. Judge annotations do not decide operator marks.

Marks live in the resolved `<ledgerHome>/marks.ndjson`, append-only and scoped to the
artifact key. Appends start a new line even after an incomplete final row. Stored verdicts
other than `real`, `not-real`, `unsure`, or `duplicate:P<n>` (positive IDs) are ignored.
New marks include the current problem title. If a stored title differs from
the current title, the mark still applies and a warning asks you to re-mark it. Warnings
appear before the unmarked problems. Monthly review history and the gates ignore that file. The scorecard uses the
same repository policy and ledger path as `run.mjs`. Use `--file <path>` with the exact path
used for review, or `--source <kind:source>` for another artifact (for example,
`--source document:null` for stdin). The running line prints the exact artifact key.
`--source` splits at the first colon when the prefix is two or more lowercase letters (so a
bare `c:\notes\a.md` stays a path); otherwise a bare `--source <s>` addresses `document:<s>`.
The printed selector uses single quotes (`--source '<key>'`), which keep paths and `$()`
literal in PowerShell and bash. A key containing a single quote or newline instead prints
`(the key contains a quote, so type its selector by hand)` without a pasteable selector.
A key with no recorded rounds says so instead of printing an empty table.
After marking, the command prints the refreshed scorecard; normal exit is 0.

Vendor rate limits get one retry after a 60-second base delay plus random jitter of less
than 25% of that delay, for every runner. Set `TRIBUNAL_RATE_LIMIT_RETRY_MS` to override
the base delay in milliseconds; empty or whitespace values use the default. The log shows
the actual wait rounded to whole seconds (fractional seconds for waits below one second).
Responses containing `insufficient_quota` are failures and are not retried. A second rate limit
keeps the round incomplete and asks the operator to wait a few minutes before running again.
Gemini tries its fallback model after a 429 because that model has its own quota. Only a
ladder where every rung failed with 429 and none mentioned `insufficient_quota` gets this retry;
mixed failures retain the error listing every failed rung.

Before classifying any CLI reply, the runner removes stderr lines matching the prompt or
contract (normalizing CRLF, trimming lines, and ignoring empty prompt lines). Only this
filtered stderr supplies classification and error details. A rate limit requires a nonzero
exit and no timeout; Claude `is_error` envelopes count as failed exits. The LAST remaining
stderr line starting with an error marker (`ERROR`, `Error`, `API Error`, optionally after a
timestamp) must name 429. Alternatively, trimmed stdout of at most 256 bytes must start with
a refusal (`API Error: 429`, a rate-limit phrase, or `too many requests`, optionally prefixed
with `error:` for the latter phrases), or its last error line must name 429. Ordinary review
prose mentioning rate limits does not count. A failure matching nothing known stays
`unrecognised`; its last filtered error line is redacted before truncation to 160 characters.

## Gemini on a Google AI Pro plan (the Antigravity seat)

The `agy-cli` runner reviews through Google's Antigravity CLI (`agy`) signed in with a Google AI
Pro account, so a Gemini review costs nothing beyond the subscription. It runs on Windows only
(see below). The shipped
`antigravity` row is a disabled template; enable it in `tribunal.config.json` on a machine where
`agy` is installed and you have signed in once by running `agy`.

What keeps it on the plan:

- **No key can reach it.** agy also signs in from `GEMINI_API_KEY` (with no prompt) and from a
  service account or Application Default Credentials, all metered. The seat's environment is the
  OS baseline only, and every name in `AGY_FORBIDDEN_ENV` is removed, in any letter case. The
  registry refuses an `agy-cli` row with `envKeys`, `requiredEnv`, or billing other than `plan`.
- **No paid overflow.** Each run passes `--settings` with `useG1Credits: false` (agy's "Use AI
  Credits" switch, which pays a used-up allowance from purchased credits). This is a per-run
  setting; nothing here has watched an allowance run out, so it is the switch set, not a measured
  refusal.
- **A used-up allowance is a named not-run**: `Google AI Pro allowance used up; waits for the
  reset (the paid key is never used instead)`, matched on agy's own wording ("Your AI credits
  balance is too low to continue.", a weekly, daily, 7-day or 5-hour limit). A missing sign-in is
  a named not-run when agy says so in its result. Neither falls back to the metered Gemini runner.
  A per-minute limit (429, RESOURCE_EXHAUSTED, "quota") is a rate limit like any other seat's and
  is retried once.
- **On Windows the seat runs in its own empty home.** agy keeps the plan sign-in in the Windows
  credential store: with HOME, USERPROFILE, APPDATA and LOCALAPPDATA pointed at an empty folder it
  still answered on the account (measured 2026-10-30). So your agy hooks, saved settings, `.env`
  files, a gcloud Application Default Credentials file and anything a run schedules stay out of
  it, and the folder is deleted afterwards. agy really does use that folder: it built its whole
  profile (`.gemini/antigravity-cli`, conversations, caches) inside it, and no `config/hooks.json`
  was there to run. **The seat runs only on Windows.** On macOS and Linux
  the sign-in may be a file in the home, so an empty home might break it and the real home would
  let those files reach it; until that is measured the policy turns the seat off there and names
  why.
- Also measured 2026-10-30, signed in: an invalid `GEMINI_API_KEY` in the environment, in a
  workspace `.env` or in `.gemini/.env` did not displace the sign-in. The stripping is for the day
  the sign-in lapses.

What keeps it a reviewer:

- The prompt goes in as one stream-json message on stdin (agy's print mode does not read plain
  stdin, and argv cannot hold a large diff). A 334 KB message was accepted whole (187,267 input
  tokens, 2026-10-30). The reply is the `response` of the last `result`
  event. A `result` with status `ERROR` is never an answer, even when agy exits 0, and neither is
  a `SUCCESS` whose `finished_reason` is anything but absent (agy's normal finish) or a plain stop:
  `max_tokens`, a timeout, `SAFETY` or an unknown reason may have cut the findings short.
- The same `--settings` deny `command`, `write_file`, `read_file`, `read_url`, `execute_url`,
  `mcp` and `unsandboxed` for every target. The `read_file` rule matters: without it agy read a
  file outside its workspace in a test on 2026-10-30. With the rules on, a request to grep, list
  or find files outside the workspace got no search tool at all, and its shell and read_file
  attempts were refused (same day). The isolation probe certifies this seat
  like the other CLI seats (`isolationProbe.mjs --leg agy`); its control drops the deny list but
  keeps `useG1Credits: false`, so probing never spends credits either.
- Not covered by those rules: agy's web search runs when a prompt asks for it, and no deny rule
  reaches it (`search_web(*)`, `web_search(*)` and `tool(search_web)` were all tried 2026-10-30).
  An instruction hidden in a reviewed artifact can therefore send text from that artifact to Google
  Search as a query. Its `schedule` tool also runs and `schedule(*)` does not deny it either
  (tried 2026-10-30). In that test the task was one of agy's own background tasks inside the run,
  with its log under agy's profile folder (which on Windows is the seat's own home), and the run
  still ended normally. Whether a scheduled task can outlive the process was not tested. Removal is best-effort: if a file is
  still locked, that folder (which holds agy's copy of the conversation) can stay under the temp
  directory. Doctor prints the web-search caveat on the
  seat's line, and the isolation probe's PASS covers file reads only. A probe run that agy
  refused (an `ERROR` result) or that stopped early is recorded as UNKNOWN, never as a run that
  did not leak.

- What is not measured: how a machine where agy was never signed in behaves (it may wait on a
  browser sign-in until the leg's timeout rather than answer with an error), and what agy says
  when the allowance runs out beyond "Your AI credits balance is too low to continue.". Billing
  also follows the Google account agy is signed in with: sign in with the AI Pro account, not a
  Workspace or Code Assist account billed to a Cloud project.
- An `id` that agy does not offer (`agy models` lists them) gets one run on the row's `fallback`,
  and the panel prints the usual DEMOTED warning.

It cannot run on a CI machine: agy has no plan sign-in for a machine nobody is sitting at, and its
headless sign-ins are the metered ones above.

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

The plugin is licensed under [Apache 2.0](../LICENSE). Read [SECURITY.md](../SECURITY.md) for
the isolation boundary and no-telemetry promise, [CONTRIBUTING.md](../CONTRIBUTING.md) for
fixture and negative-control requirements, and [CHANGELOG.md](../CHANGELOG.md) for releases.
Technical design and portability notes are kept in the maintainer's private archive.
