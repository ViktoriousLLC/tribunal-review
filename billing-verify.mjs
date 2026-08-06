// PROVE IT, DON'T ASSUME IT.
//
// This module exists because the panel reported "on the plan" on every pull request
// for over a week while a metered invoice quietly grew. Nothing had actually checked
// what the run was billed to.
//
// The reason that bug survived is worth stating plainly: EVERY layer
// that claimed the Claude legs were free was making an INFERENCE, not an observation.
//   - the reviewer inferred from a secret being present  ("a token exists, so: plan")
//   - the digest inferred from a hardcoded label         ("Claude Max covers the legs")
//   - and the one job that reads the REAL invoice had never been wired to run at all.
// Three layers of confident agreement, zero measurements.
//
// So this module does exactly one thing: it asks Anthropic what we were ACTUALLY billed.
//
// It reads the org Admin usage_report (a READ-ONLY billing key — it can never make a
// model call) and compares a snapshot taken before the Claude legs run with one taken
// after. Any metered tokens that appear on the eval's own models in that window mean we
// paid, no matter what any environment variable, flag or label says.
//
// Measured facts this relies on (2026-07-12, do not re-derive):
//   - usage_report reflects a metered call in ~50 seconds, hence SETTLE_MS below.
//   - the CLI's own JSON envelope is USELESS for this: `total_cost_usd` is non-zero on a
//     plan-covered run too ($0.0505 on a call that cost nothing). There is no runtime
//     signal from the CLI. The invoice is the only ground truth.
//
// THE RULE, and the whole point of this file:
//   absence of proof is "unverified", NEVER "free".

// The same rule extends to the SECOND vendor. The GPT leg moved off the
// metered OpenAI API onto the Codex plan, and a plan claim about OpenAI is worth
// exactly as little as a plan claim about Anthropic was: nothing, until an invoice
// says so. So this module is now provider-shaped — one verdict engine, two readers.
const USAGE_URL = "https://api.anthropic.com/v1/organizations/usage_report/messages";
const OPENAI_USAGE_URL = "https://api.openai.com/v1/organization/usage/completions";

/** Give the vendor's usage pipeline time to reflect the calls we just made. */
export const SETTLE_MS = 75_000;

/**
 * Return null (= unmeasurable) and SAY WHY in the run log.
 *
 * Every unreadable path used to return a bare null, so at the caller a systematic
 * every-run miss (a paginated window, a reshaped bucket) was indistinguishable from a
 * missing credential — the panel's point, and a fair one: "unverified" that never explains
 * itself trains a reader to ignore it, which is how a real regression hides inside a state
 * everyone has learned to skip. The verdict is unchanged; only the diagnosis is added.
 */
function unmeasurable(reason, { warn = true } = {}) {
  // Flattened here too, not only on the ::warning below. Actions parses a workflow
  // command from ANY log line that starts with `::`, so a vendor error string carrying a
  // newline can open one from inside this plain line just as easily. Two callers
  // interpolate a vendor string, which is a narrow channel but not a closed one.
  const flat = String(reason).replace(/[\r\n]+/g, " ");
  console.log(`  ↷ Billing read unmeasurable: ${flat}`);
  // A RESPONSE-SHAPE anomaly means the verifier is structurally blind and every future run
  // will report unverified, so it earns an annotation the workflow UI actually shows. A
  // missing credential is a configuration state, not an anomaly, and warning on it every
  // run would train the reader to ignore the channel.
  if (warn) console.log(`::warning title=Billing check unmeasurable::${flat.slice(0, 400)}`);
  return null;
}

/**
 * Does a usage-report row belong to one of OUR models?
 *
 * Not a bare `startsWith`. The report groups by the RESOLVED snapshot id, so `gpt-5.6-sol`
 * is billed as `gpt-5.6-sol-2026-01-31` and an exact compare would miss real spend. But a
 * prefix compare is too generous in the other direction: if the panel's model is a family
 * name, every sibling on the same organisation key (`gpt-5.6-terra`, `gpt-5.6-luna`)
 * prefix-matches it, and this panel gets billed for work it never did.
 *
 * Three answers, not two, because guessing either way is wrong:
 *   "ours"       exact, or the model name plus a dated snapshot suffix.
 *   "other"      does not prefix-match any of our models. Skip it.
 *   "ambiguous"  prefix-matches but is not a dated snapshot of it. That is either a
 *                sibling model we must NOT count or a snapshot format we do not know.
 *                We cannot tell, and the two answers differ, so the caller refuses.
 *                Refusing renders as "unverified", which is this module's safe state;
 *                silently skipping it would UNDER-count, and an under-read delta renders
 *                as "plan (verified)", which is the exact sin this file exists to prevent.
 */
export function classifyModelRow(reported, models) {
  let sawPrefix = false;
  for (const m of models) {
    if (reported === m) return "ours";
    if (!reported.startsWith(m)) continue;
    sawPrefix = true;
    // `-2026-01-31`, and the legacy four-digit `-0613` form OpenAI still has rows for.
    if (/^-(\d{4}-\d{2}-\d{2}|\d{4})$/.test(reported.slice(m.length))) return "ours";
  }
  return sawPrefix ? "ambiguous" : "other";
}

/**
 * Metered output tokens billed since `sinceIso`, restricted to `models`.
 *
 * Restricted to the panel's OWN models on purpose. An organisation admin key sees
 * every model the org bills, and your application almost certainly bills some of
 * them for its own reasons. Counting all of it would raise an alarm about spend
 * this panel did not cause. Returns null when it cannot measure — the caller MUST
 * render that as "unverified", not as zero.
 */
export async function meteredOutputTokens({ adminKey, sinceIso, models, allowEmptyWindow = false, fetchImpl = fetch }) {
  if (!adminKey) return unmeasurable("no admin key", { warn: false });
  const u = new URL(USAGE_URL);
  u.searchParams.set("starting_at", sinceIso);
  u.searchParams.set("bucket_width", "1m");
  u.searchParams.set("group_by[]", "model");
  u.searchParams.set("limit", "60");
  try {
    const r = await fetchImpl(u.toString(), {
      headers: { "anthropic-version": "2023-06-01", "x-api-key": adminKey },
    });
    if (!r.ok) return unmeasurable(`usage report returned HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.data)) return unmeasurable("usage report envelope had no data array");
    // A paginated answer is a PARTIAL answer, and an under-read delta renders as
    // "plan (verified)" — the same failure class as the empty-envelope hole. The probe
    // that measured this endpoint returned `data, has_more, next_page`, and limit=60 with
    // 1-minute buckets caps a read at one hour, so a long panel run can genuinely spill.
    // Rather than paginate for a number we only difference, refuse to answer: an
    // unfinished read is unmeasurable, never free.
    // Measured across five dispatched panel runs: 222s, 425s, 468s, 576s — call it
    // 4 to 10 minutes. The 60-bucket cap is one hour, so the headroom is roughly 6x and
    // this branch should never fire in normal operation. If it starts firing every run
    // the verdict degrades to "unverified" forever, which is SAFE but silent, so it is a
    // warning the workflow surface actually shows rather than a log line nobody reads.
    if (j.has_more) {
      return unmeasurable(
        "usage report paginated (has_more) — the window exceeded one hour of 1m buckets. " +
          "Panel runs measured 4-10 min against a 60-minute cap, so recurring hits mean runs " +
          "got much longer: raise `limit` or widen `bucket_width`."
      );
    }
    const buckets = j.data;
    // Measured against the live API on 2026-07-27: starting_at=60 seconds ago returned
    // HTTP 200 with data:[], while a 60+ minute window returned 60 complete buckets whose
    // results arrays were empty. Anthropic emits a bucket only for a COMPLETE interval,
    // so emptiness means different things at the two call sites — and the caller, not this
    // function, is the one that knows which it is asking for.
    //
    // The default is the SAFE reading, and that is deliberate. The first version defaulted
    // to treating an empty window as zero and made the strict reading opt-in, which meant
    // a caller that simply forgot the flag silently got the unsafe answer while every test
    // stayed green — a guard that can be disabled by omission is not a guard. Now the
    // dangerous reading has to be REQUESTED:
    //
    //   default                 -> an empty window is UNMEASURABLE. A de-scoped key that
    //                              answers HTTP 200 with data:[] can no longer be
    //                              differenced against itself into "plan (verified)",
    // which is the same sin with better manners.
    //   allowEmptyWindow: true  -> only the BEFORE snapshot, whose window is seconds old
    //                              and so legitimately has no closed interval yet. Without
    //                              this every single run would report unverified.
    if (!allowEmptyWindow && buckets.length === 0) {
      return unmeasurable("usage report returned no complete buckets for a window that should have them");
    }
    const want = new Set(models);
    let out = 0;
    let sawUngroupedRow = false;
    for (const b of buckets) {
      // A bucket with no `results` array is a reshaped response, not an empty hour. The
      // previous `b.results || []` quietly turned `{data:[{}]}` into a verified zero,
      // which is the envelope check passing at the top level and failing one level down.
      if (!b || !Array.isArray(b.results)) return unmeasurable("usage report bucket carried no results array");
      for (const x of b.results) {
        if (!x || x.model == null) {
          sawUngroupedRow = true;
          continue;
        }
        if (!want.has(x.model)) continue;
        // `?? 0` on a row we are actually counting turns a missing field into a verified
        // zero — the same defect as the empty envelope, one level further down. A row for
        // OUR model that carries no usable token count is unmeasurable, not free.
        if (typeof x.output_tokens !== "number" || !Number.isFinite(x.output_tokens) || x.output_tokens < 0) {
          return unmeasurable(`usage report row for ${x.model} carried no usable output_tokens`);
        }
        out += x.output_tokens;
      }
    }
    // This is the path that money walked out of, and it is the one that lacked the
    // guard. A row with no model field means group_by[] did not take effect for that row,
    // so its output_tokens cannot be attributed and silently dropping it understates spend.
    //
    // This is PER-ROW, not all-or-nothing. The first version fired only when NO row
    // anywhere carried a model field, which the panel correctly called a weaker guard than
    // its own comment claimed: one attributed row disarmed it and every ungrouped row's
    // tokens vanished from a number main() then treats as measured. My defence for that
    // was wrong — when grouping works, EVERY row carries a model, so a single ungrouped
    // row is already evidence of a malformed response and cannot make an ordinary answer
    // read as unverified. Unattributable tokens are unmeasurable, never free.
    if (sawUngroupedRow) return unmeasurable("usage report carried rows with no model field — group_by did not take effect");
    return out;
  } catch (e) {
    return unmeasurable(`usage report read threw: ${String(e?.message || e).slice(0, 120)}`);
  }
}

/**
 * The same question, asked of OpenAI.
 *
 * Metered output tokens billed on `models` since `sinceEpoch` (UNIX SECONDS — OpenAI's
 * usage API takes an integer timestamp where Anthropic's takes ISO, which is exactly the
 * kind of detail worth encoding once rather than at each call site).
 *
 * Reasoning tokens are INCLUDED in OpenAI's `output_tokens` for this report, so unlike
 * the Gemini cost path there is nothing to add back. NOTE the settle time: SETTLE_MS was
 * measured against ANTHROPIC's pipeline (~50s) and is reused here without an equivalent
 * OpenAI measurement — which is exactly why an empty-envelope answer degrades to null
 * below rather than to a confident zero. Restricted to the eval's own models
 * for the same reason as the Anthropic reader: the key is shared with an app that bills
 * legitimately, and counting its spend would cry wolf. Returns null when we cannot
 * measure — the caller MUST render that as "unverified", not as zero.
 */
export async function openaiMeteredOutputTokens({ adminKey, sinceEpoch, models, allowEmptyWindow = false, fetchImpl = fetch }) {
  if (!adminKey) return unmeasurable("no OpenAI admin key", { warn: false });
  const u = new URL(OPENAI_USAGE_URL);
  u.searchParams.set("start_time", String(Math.floor(sinceEpoch)));
  u.searchParams.set("bucket_width", "1m");
  // `group_by=model`, NOT `group_by[]=model`. Anthropic uses the bracketed form and it was
  // copied across; OpenAI's own cookbook passes `"group_by": ["model"]` through requests,
  // which serializes as a plain repeated key. The bracketed name would simply be ignored,
  // leaving `x.model` null on every result — the prefix filter would then sum 0 and the
  // verdict would announce "plan (verified)" over real metered spend. Caught by the GPT
  // leg on this PR's own review, which no other model raised.
  u.searchParams.append("group_by", "model");
  u.searchParams.set("limit", "60");
  try {
    const r = await fetchImpl(u.toString(), { headers: { Authorization: `Bearer ${adminKey}` } });
    if (!r.ok) return unmeasurable(`OpenAI usage report returned HTTP ${r.status}`);
    const j = await r.json();
    const buckets = Array.isArray(j.data) ? j.data : [];
    // An answer with NO buckets is not "nothing was billed": it can equally mean we did
    // not observe the window at all (a lagging pipeline, a scope we cannot read), and
    // returning 0 would let `billingVerdict` assert "plan (verified)" from no evidence.
    // So the default stays the SAFE reading, exactly as on the Anthropic reader.
    //
    // The flag exists because the BEFORE snapshot is a different question. Its window is
    // seconds old, and Anthropic MEASURABLY emits a bucket only for a COMPLETE interval,
    // so an empty answer there is the normal one. We have NOT measured whether OpenAI
    // behaves the same way, and that uncertainty is why the flag is opt-in rather than a
    // rewritten default: without it, if OpenAI does behave like Anthropic, the before
    // snapshot is null on every run and the OpenAI verdict is permanently "unverified".
    // Safe, and permanently silent, which is the control state nothing looks for.
    // The AFTER snapshot never passes it, so an unread report still refuses to answer.
    if (!allowEmptyWindow && buckets.length === 0) {
      return unmeasurable("OpenAI usage report returned no buckets — the window was not observed");
    }
    // Same refusal as the Anthropic reader, for the same reason: a paginated answer is a
    // partial one, and a short read only ever SHRINKS the delta, which renders as
    // plan-covered. The guard was added on one vendor and not the other, which is how a
    // rule becomes a coincidence.
    if (j.has_more) return unmeasurable("OpenAI usage report paginated (has_more) — the window was read only in part");
    // A CLONE INHERITS ITS SIBLING'S LATENT BUGS. This reader was written from the
    // Anthropic one above and then that one was hardened three times without this one
    // following: `b.results || []`, an all-or-nothing ungrouped guard, and `?? 0` on a
    // matched row all survived here. Every one of them fails toward summing zero, and
    // zero renders as "plan (verified)" — the exact absence-as-proof failure this module
    // exists to prevent. The three guards below are the Anthropic reader's, ported.
    let out = 0;
    let sawUngroupedRow = false;
    for (const b of buckets) {
      // A bucket with no `results` ARRAY is a reshaped response, not a quiet interval.
      // `{data:[{}]}` passes the envelope check one level up and would sum to a
      // confident zero.
      if (!b || !Array.isArray(b.results)) {
        return unmeasurable("OpenAI usage report bucket carried no results array");
      }
      for (const x of b.results) {
        // PER ROW, not once across the whole report: a single attributed row used to
        // disarm the guard while every other row's tokens vanished from a total the
        // caller treats as measured.
        if (!x || x.model == null) { sawUngroupedRow = true; continue; }
        // Neither exact nor a bare prefix — see classifyModelRow. An exact compare misses
        // the dated snapshot id the report actually groups by; a bare prefix bills this
        // panel for a sibling model's spend on the same organisation key.
        const attribution = classifyModelRow(String(x.model), models);
        if (attribution === "other") continue;
        if (attribution === "ambiguous") {
          return unmeasurable(
            `OpenAI usage report row "${x.model}" starts with one of the panel's models but is not a dated ` +
              "snapshot of it, so it is either a sibling model or an unknown snapshot format. Counting it " +
              "would over-report and skipping it would under-report, and an under-read renders as plan-covered."
          );
        }
        // On a row we are actually counting, a missing or non-numeric token count is
        // unmeasurable. `?? 0` here turns it into a verified zero, and a string would
        // make `out` a concatenation and the delta NaN.
        // NEGATIVE counts too: a negative would SHRINK a real total toward zero, which
        // renders as plan-covered. The message already promised this check; now it exists.
        if (typeof x.output_tokens !== "number" || !Number.isFinite(x.output_tokens) || x.output_tokens < 0) {
          return unmeasurable("OpenAI usage report row carried a missing, non-numeric, or negative output_tokens");
        }
        out += x.output_tokens;
      }
    }
    // Rows exist but carry no model => the grouping did not take effect and we are
    // filtering against nulls. Unmeasurable, not free.
    if (sawUngroupedRow) {
      return unmeasurable("OpenAI usage report carried rows with no model field — group_by did not take effect");
    }
    return out;
  } catch (e) {
    return unmeasurable(`OpenAI usage report read threw: ${String(e?.message || e).slice(0, 120)}`);
  }
}

/**
 * Turn a before/after pair into a verdict. Pure — unit-tested without the network.
 *
 * `before`/`after` are token counts, or null when the measurement was unavailable.
 * `provider` names the vendor whose invoice was (or was not) read, and `keyName` the
 * env var that would let us read it — so an "unverified" line tells the reader how to
 * stop it being unverified, instead of just shrugging.
 */
export function billingVerdict({ before, after, provider = "Anthropic", keyName = "ANTHROPIC_ADMIN_KEY", settleMeasured = true }) {
  if (before === null || after === null || before === undefined || after === undefined) {
    return {
      provider,
      state: "unverified",
      billedTokens: null,
      label: "unverified",
      // Deliberately NOT reassuring. An unmeasured run is not a free run.
      detail: `Could not verify against the ${provider} invoice (no ${keyName}, or the billing API did not answer). This run is UNVERIFIED, not proven free.`,
    };
  }
  // A COUNTER THAT WENT BACKWARDS IS A MEASUREMENT ANOMALY, NOT A FREE RUN. Both
  // snapshots read from the same start time, so the after-window is a superset of the
  // before-window and the total can only grow. A shrink means the key was rescoped, the
  // report reshaped, or the window moved — none of which is evidence that nothing was
  // billed. Clamping it to zero rendered it as "plan (verified)", which is this module's
  // own stated sin: absence of proof is unverified, never free.
  if (after < before) {
    return {
      provider,
      state: "unverified",
      billedTokens: null,
      label: "unverified",
      detail: `The ${provider} usage report went BACKWARDS during this run (${before} → ${after} tokens on the same window). That is a measurement anomaly, not evidence of a free run. UNVERIFIED, not proven free.`,
    };
  }
  const billed = after - before;
  if (billed > 0) {
    return {
      provider,
      state: "billed",
      billedTokens: billed,
      label: "BILLED (metered)",
      detail: `The ${provider} invoice shows ${billed} metered output tokens on the eval's models during this run. These legs were NOT free.`,
    };
  }
  // A zero is only as good as the settle window it was read after. SETTLE_MS was measured
  // against Anthropic's pipeline; for any provider whose ingestion lag we have NOT
  // measured, say so in the same breath as the zero rather than letting "verified" carry
  // more weight than the evidence does.
  return {
    provider,
    state: "verified-plan",
    billedTokens: 0,
    label: settleMeasured ? "plan (verified)" : "plan (0 observed, settle window unmeasured)",
    detail: settleMeasured
      ? `Verified against the ${provider} invoice: 0 metered tokens billed on the eval's models during this run.`
      : `The ${provider} invoice showed 0 metered tokens on the eval's models during this run. Caveat: ${provider}'s usage-reporting lag has not been measured, so a very recent charge could still be in flight.`,
  };
}

/** One line for the run log. Loud when it needs to be. */
export function billingLogLine(v) {
  const who = v.provider ? `${v.provider} ` : "";
  if (v.state === "billed") return `  [!!] ${who}BILLING CHECK FAILED — ${v.detail}`;
  if (v.state === "unverified") return `  [?]  ${who}BILLING CHECK UNVERIFIED — ${v.detail}`;
  return `  [ok] ${who}billing check: ${v.detail}`;
}
