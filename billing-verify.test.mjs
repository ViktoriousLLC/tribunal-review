// The rule this file exists to enforce:
//   ABSENCE OF PROOF IS "UNVERIFIED", NEVER "FREE".
//
// Every layer that reported the Claude legs as free was inferring, not measuring:
// the reviewer read a secret's presence, the digest read a hardcoded label, and the
// job that reads the real invoice was never checked against them. real money walked out
// while three surfaces agreed it was $0.
import test from "node:test";
import assert from "node:assert/strict";
import { billingVerdict, billingLogLine, meteredOutputTokens, openaiMeteredOutputTokens, classifyModelRow } from "./billing-verify.mjs";

test("the OpenAI reader counts only the eval's own models, and answers in tokens", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenAuth = init.headers.Authorization;
    return {
      ok: true,
      json: async () => ({
        data: [
          {
            results: [
              { model: "gpt-5.6-sol", output_tokens: 700 },
              { model: "gpt-5.5", output_tokens: 300 },
              { model: "gpt-4o-mini", output_tokens: 90_000 }, // somebody else's spend
            ],
          },
        ],
      }),
    };
  };
  const out = await openaiMeteredOutputTokens({
    adminKey: "admin",
    sinceEpoch: 1_760_000_000.7,
    models: ["gpt-5.6-sol", "gpt-5.5"],
    fetchImpl,
  });
  assert.equal(out, 1_000);
  // OpenAI takes UNIX SECONDS (integer) where Anthropic takes ISO — a float or an ISO
  // string here silently returns the wrong window, which would read as "0 billed".
  assert.match(seenUrl, /start_time=1760000000(&|$)/);
  assert.match(seenUrl, /bucket_width=1m/);
  // `group_by=model`, NOT the bracketed Anthropic form. OpenAI's cookbook passes
  // {"group_by": ["model"]} through requests, i.e. a plain repeated key; the bracketed
  // name is ignored, which leaves every result's model null and sums real spend to 0.
  assert.match(seenUrl, /(^|&)group_by=model(&|$)/);
  assert.equal(/group_by%5B%5D/.test(seenUrl), false, "the bracketed form is silently ignored by OpenAI");
  assert.equal(seenAuth, "Bearer admin");
});

test("results with NO model field mean the grouping failed => unverified, not zero", async () => {
  // If group_by never took effect, every result carries a null model, the filter matches
  // nothing, and a naive sum of 0 would be announced as "plan (verified)" over real spend.
  const ungrouped = async () => ({
    ok: true,
    json: async () => ({ data: [{ results: [{ model: null, output_tokens: 5000 }] }] }),
  });
  assert.equal(
    await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["gpt-5.6-sol"], fetchImpl: ungrouped }),
    null
  );
});

test("a snapshot-suffixed model id still counts as our spend", async () => {
  // OpenAI groups by the RESOLVED model (`gpt-5.6-sol-2026-02-01`). An exact-match filter
  // would score real metered spend as zero and print "plan (verified)".
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [{ results: [{ model: "gpt-5.6-sol-2026-02-01", output_tokens: 250 }] }] }),
  });
  assert.equal(await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["gpt-5.6-sol"], fetchImpl }), 250);
});

test("an EMPTY usage envelope is unverified, not a confident zero", async () => {
  // The report returns a bucket per interval whether or not anything landed in it, so no
  // buckets at all means we did not observe the window. Answering 0 would let the verdict
  // assert "plan (verified)" from no evidence.
  const empty = async () => ({ ok: true, json: async () => ({ data: [] }) });
  assert.equal(await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["m"], fetchImpl: empty }), null);
  const noData = async () => ({ ok: true, json: async () => ({}) });
  assert.equal(await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["m"], fetchImpl: noData }), null);
  // But a bucket that exists and is genuinely empty IS a real zero.
  const realZero = async () => ({ ok: true, json: async () => ({ data: [{ results: [] }] }) });
  assert.equal(await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["m"], fetchImpl: realZero }), 0);
});

test("no OpenAI admin key, or a refusing billing API, returns null (=> unverified)", async () => {
  assert.equal(await openaiMeteredOutputTokens({ adminKey: "", sinceEpoch: 1, models: [] }), null);
  const dead = async () => ({ ok: false, status: 401, text: async () => "nope" });
  assert.equal(await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["m"], fetchImpl: dead }), null);
  const throws = async () => {
    throw new Error("network");
  };
  assert.equal(await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["m"], fetchImpl: throws }), null);
});

test("the verdict names the provider it actually checked, and the key that would prove it", () => {
  const unv = billingVerdict({ before: null, after: null, provider: "OpenAI", keyName: "OPENAI_ADMIN_KEY" });
  assert.equal(unv.provider, "OpenAI");
  assert.match(unv.detail, /OpenAI invoice/);
  assert.match(unv.detail, /OPENAI_ADMIN_KEY/);
  assert.match(unv.detail, /not proven free/i);
  assert.match(billingLogLine(unv), /OpenAI BILLING CHECK UNVERIFIED/);

  const billed = billingVerdict({ before: 0, after: 42, provider: "OpenAI", keyName: "OPENAI_ADMIN_KEY" });
  assert.match(billingLogLine(billed), /OpenAI BILLING CHECK FAILED/);
  // And the default stays Anthropic, so every existing caller keeps its wording.
  assert.equal(billingVerdict({ before: 0, after: 0 }).provider, "Anthropic");
});

test("metered tokens billed during the run => BILLED, loudly", () => {
  const v = billingVerdict({ before: 100, after: 4_512 });
  assert.equal(v.state, "billed");
  assert.equal(v.billedTokens, 4_412);
  assert.match(v.detail, /NOT free/i);
  assert.match(billingLogLine(v), /BILLING CHECK FAILED/);
});

test("zero metered tokens => plan, and it is EARNED, not assumed", () => {
  const v = billingVerdict({ before: 7, after: 7 });
  assert.equal(v.state, "verified-plan");
  assert.equal(v.billedTokens, 0);
  assert.match(v.label, /verified/);
  assert.match(billingLogLine(v), /\[ok\]/);
});

test("THE WHOLE POINT: an unmeasurable run is UNVERIFIED — never 'plan', never '$0'", () => {
  for (const pair of [
    { before: null, after: 10 },
    { before: 10, after: null },
    { before: null, after: null },
    { before: undefined, after: undefined },
  ]) {
    const v = billingVerdict(pair);
    assert.equal(v.state, "unverified", `${JSON.stringify(pair)} must not read as verified`);
    assert.equal(v.billedTokens, null);
    assert.equal(v.label, "unverified");
    // The exact failure mode we are legislating against: quietly reporting free.
    assert.doesNotMatch(v.label, /plan/i);
    assert.match(v.detail, /not proven free/i);
  }
});

test("a counter that went BACKWARDS is unverified, never a verified-free run", () => {
  // The old version clamped the delta to 0 and returned verified-plan, which reads a
  // measurement anomaly as proof of a free run. The Tribunal caught it on the
  // open-source candidate: 3 of 3 reviewers, one line.
  const v = billingVerdict({ before: 500, after: 100 });
  assert.equal(v.state, "unverified");
  assert.equal(v.billedTokens, null);
  assert.equal(v.label, "unverified");
  assert.doesNotMatch(v.label, /plan/i);
  assert.match(v.detail, /not proven free/i);
});

test("only the PANEL's models count — another model on the same org key is not this panel's alarm", async () => {
  // An org admin key sees every model the organisation bills. Counting all of it would
  // raise an alarm about spend this panel did not cause.
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      data: [
        {
          results: [
            { model: "claude-opus-4-8", output_tokens: 900 },
            { model: "claude-fable-5", output_tokens: 100 },
            { model: "claude-sonnet-4-6", output_tokens: 50_000 }, // another consumer of the same org key
          ],
        },
      ],
    }),
  });
  const out = await meteredOutputTokens({
    adminKey: "admin",
    sinceIso: "2026-07-13T00:00:00Z",
    models: ["claude-opus-4-8", "claude-fable-5"],
    fetchImpl,
  });
  assert.equal(out, 1_000);
});

// Emptiness means two different things at the two call sites, which is why the caller
// declares which it is asking for. Measured 2026-07-27: Anthropic emits a bucket only for
// a COMPLETE interval, so a window seconds old is legitimately empty while a window
// spanning a whole panel run cannot be.
test("an empty envelope on the BEFORE window (no closed interval yet) is a measured zero", async () => {
  const empty = async () => ({ ok: true, json: async () => ({ data: [] }) });
  assert.equal(
    await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["m"], allowEmptyWindow: true, fetchImpl: empty }),
    0
  );
});

test("an empty envelope on the AFTER window means we could not read the report => unverified", async () => {
  // The hole the panel caught: a de-scoped key that still answers HTTP 200 with data:[]
  // was indistinguishable from a quiet window, and differencing two such answers produced
  // "plan (verified)" from no observation at all. The after-snapshot must SEE the report.
  const empty = async () => ({ ok: true, json: async () => ({ data: [] }) });
  assert.equal(
    await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["m"], fetchImpl: empty }),
    null
  );
  // A window that DOES carry complete buckets, all of them quiet, is still a real zero.
  const quiet = async () => ({ ok: true, json: async () => ({ data: [{ results: [] }, { results: [] }] }) });
  assert.equal(
    await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["m"], fetchImpl: quiet }),
    0
  );
});

test("a bucket with no results ARRAY is a reshaped response, not an empty hour", async () => {
  // `b.results || []` made `{data:[{}]}` a verified zero: the envelope check passing at the
  // top level and failing one level down.
  for (const shape of [{}, { results: null }, { results: "nope" }]) {
    const reshaped = async () => ({ ok: true, json: async () => ({ data: [shape] }) });
    assert.equal(
      await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["m"], fetchImpl: reshaped }),
      null,
      `bucket shape ${JSON.stringify(shape)} must be unverified`
    );
  }
});

test("a PAGINATED answer is a partial answer, so it is unverified", async () => {
  // limit=60 over 1-minute buckets caps a read at one hour. Silently dropping pages
  // shrinks the delta, and an under-read delta renders as "plan (verified)".
  const paginated = async () => ({
    ok: true,
    json: async () => ({ data: [{ results: [{ model: "claude-opus-5", output_tokens: 10 }] }], has_more: true, next_page: "cursor" }),
  });
  assert.equal(
    await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["claude-opus-5"], fetchImpl: paginated }),
    null
  );
});

test("ONE ungrouped row among attributed ones is still unverified, not a silent drop", async () => {
  // The first guard fired only when NO row anywhere carried a model, so a single
  // attributed row disarmed it and every ungrouped row's tokens vanished from a number
  // main() then treats as measured. Per-row, because when grouping works every row
  // carries a model — so one that does not is already a malformed response.
  const mixed = async () => ({
    ok: true,
    json: async () => ({
      data: [{ results: [{ model: "claude-opus-5", output_tokens: 10 }, { output_tokens: 5_000 }] }],
    }),
  });
  assert.equal(
    await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["claude-opus-5"], fetchImpl: mixed }),
    null,
    "5,000 unattributable tokens must never be dropped into a verified-looking 10"
  );
});

test("a missing or reshaped Anthropic data envelope is unverified", async () => {
  const noData = async () => ({ ok: true, json: async () => ({}) });
  assert.equal(
    await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["m"], fetchImpl: noData }),
    null
  );
  const nonArrayData = async () => ({ ok: true, json: async () => ({ data: { results: [] } }) });
  assert.equal(
    await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["m"], fetchImpl: nonArrayData }),
    null
  );
});

test("Anthropic rows with NO model field mean grouping failed => unverified", async () => {
  const ungrouped = async () => ({
    ok: true,
    json: async () => ({ data: [{ results: [{ output_tokens: 5_000 }] }] }),
  });
  assert.equal(
    await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["claude-opus-5"], fetchImpl: ungrouped }),
    null
  );
});

test("no admin key, or a billing API that will not answer, returns null (=> unverified)", async () => {
  assert.equal(await meteredOutputTokens({ adminKey: "", sinceIso: "x", models: [] }), null);
  const dead = async () => ({ ok: false, status: 401, text: async () => "nope" });
  assert.equal(
    await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["m"], fetchImpl: dead }),
    null
  );
  const throws = async () => {
    throw new Error("network");
  };
  assert.equal(
    await meteredOutputTokens({ adminKey: "k", sinceIso: "x", models: ["m"], fetchImpl: throws }),
    null
  );
});

test("a zero read after an UNMEASURED settle window says so, instead of banking 'verified'", () => {
  // SETTLE_MS was measured against Anthropic's pipeline. Reusing it for OpenAI and then
  // printing a flat "plan (verified)" would be a stronger claim than the evidence carries
  // — the GPT leg's own catch on the PR that introduced it.
  const v = billingVerdict({ before: 0, after: 0, provider: "OpenAI", keyName: "OPENAI_ADMIN_KEY", settleMeasured: false });
  assert.equal(v.state, "verified-plan");
  assert.match(v.label, /unmeasured/);
  assert.match(v.detail, /lag has not been measured/);
  // Anthropic, whose lag IS measured, keeps the unqualified wording.
  assert.equal(billingVerdict({ before: 0, after: 0 }).label, "plan (verified)");
});

// The OpenAI reader was a clone of the Anthropic one and inherited three of its
// pre-hardening bugs. Every one of them fails toward summing zero, and zero renders
// as "plan (verified)". Found by the Tribunal panel on the open-source candidate.
test("OpenAI reader: a bucket with no results ARRAY is unmeasurable, not an empty hour", async () => {
  for (const shape of [{}, { results: null }, { results: "nope" }]) {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [shape] }) });
    assert.equal(
      await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["m"], fetchImpl }),
      null,
      `${JSON.stringify(shape)} must not sum to a confident zero`
    );
  }
});

test("OpenAI reader: ONE ungrouped row among attributed ones is still unverified", async () => {
  // The old guard fired only when NO row anywhere carried a model, so a single
  // attributed row disarmed it and every other row's tokens vanished silently.
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [{ results: [
      { model: "gpt-5.6-sol", output_tokens: 100 },
      { model: null, output_tokens: 9000 },
    ] }] }),
  });
  assert.equal(
    await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["gpt-5.6-sol"], fetchImpl }),
    null
  );
});

test("OpenAI reader: a matched row with a missing or non-numeric token count is unmeasurable", async () => {
  for (const tokens of [undefined, null, "1200", NaN, Infinity, -50]) {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ data: [{ results: [{ model: "gpt-5.6-sol", output_tokens: tokens }] }] }),
    });
    assert.equal(
      await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["gpt-5.6-sol"], fetchImpl }),
      null,
      `output_tokens=${String(tokens)} must not count as zero`
    );
  }
  // A real number still counts.
  const good = async () => ({ ok: true, json: async () => ({ data: [{ results: [{ model: "gpt-5.6-sol", output_tokens: 250 }] }] }) });
  assert.equal(await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["gpt-5.6-sol"], fetchImpl: good }), 250);
});

// The four defects found in the release review. Each one fails toward a WRONG number, and
// three of the four fail toward the number this module exists to refuse: a confident zero.

test("the OpenAI BEFORE window may legitimately be empty, and the AFTER window may not", async () => {
  // Without the flag, the before-snapshot reads null on every run if OpenAI (like
  // Anthropic, measured) emits a bucket only for a complete interval — and a null before
  // makes the OpenAI verdict permanently "unverified". Safe, and permanently silent.
  const empty = async () => ({ ok: true, json: async () => ({ data: [] }) });
  assert.equal(
    await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["gpt-5.6-sol"], allowEmptyWindow: true, fetchImpl: empty }),
    0
  );
  // The strict default is unchanged, so an unread AFTER report still refuses to answer.
  assert.equal(
    await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["gpt-5.6-sol"], fetchImpl: empty }),
    null
  );
});

test("a sibling model's spend is never attributed to this panel", () => {
  assert.equal(classifyModelRow("gpt-5.6-sol", ["gpt-5.6-sol"]), "ours");
  assert.equal(classifyModelRow("gpt-5.6-sol-2026-01-31", ["gpt-5.6-sol"]), "ours");
  assert.equal(classifyModelRow("gpt-4-0613", ["gpt-4"]), "ours", "the legacy four-digit snapshot form still bills");
  // The bug: a bare startsWith counts every sibling on the same organisation key.
  assert.equal(classifyModelRow("gpt-5.6-terra-2026-01-31", ["gpt-5.6-sol"]), "other");
  assert.equal(classifyModelRow("gpt-5.6-sol-mini-2026-01-31", ["gpt-5.6"]), "ambiguous");
  assert.equal(classifyModelRow("text-embedding-3-large", ["gpt-5.6-sol"]), "other");
});

test("a model id we cannot attribute is unmeasurable, never silently skipped", async () => {
  // Skipping it would UNDER-count, and an under-read delta renders as plan-covered, which
  // is precisely the failure this whole module exists to prevent.
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [{ results: [{ model: "gpt-5.6-solar", output_tokens: 900 }] }] }),
  });
  assert.equal(
    await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["gpt-5.6-sol"], fetchImpl }),
    null
  );
});

test("a newline in a vendor error cannot open a workflow command from the plain log line", async () => {
  const lines = [];
  const original = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const throws = async () => {
      throw new Error("boom\n::error::forged");
    };
    await openaiMeteredOutputTokens({ adminKey: "k", sinceEpoch: 1, models: ["m"], fetchImpl: throws });
  } finally {
    console.log = original;
  }
  const forged = lines.filter((l) => l.split("\n").some((seg, i) => i > 0 && seg.startsWith("::")));
  assert.deepEqual(forged, [], "no emitted line may contain a newline followed by a workflow command");
});

test("classifyModelRow accepts Anthropic's undashed date suffix, not only OpenAI's shapes", () => {
  // The suffix test allowed `-2026-01-31` and `-0613` and nothing else, while MODEL_RATES
  // already carried `claude-haiku-4-5-20251001` — the undashed 8-digit form. A row in that
  // shape prefix-matched, failed the suffix test, and returned "ambiguous", which
  // meteredOutputTokens turns into unmeasurable for the WHOLE read. The verdict then says
  // "unverified" forever, which suppresses exactly the BILLED alarm this module exists to
  // raise. Fails safe, and a permanently silent control is still a broken one.
  const models = ["claude-opus-5", "gpt-5.6-sol"];
  assert.equal(classifyModelRow("claude-opus-5-20260101", models), "ours");
  assert.equal(classifyModelRow("claude-opus-5-2026-01-31", models), "ours");
  assert.equal(classifyModelRow("gpt-5.6-sol-0613", models), "ours");
  assert.equal(classifyModelRow("claude-opus-5", models), "ours");
  // Still ambiguous, and must stay so: a suffix that is not a date is a different model.
  assert.equal(classifyModelRow("claude-opus-5-turbo", models), "ambiguous");
  assert.equal(classifyModelRow("claude-opus-5-202601", models), "ambiguous");
  assert.equal(classifyModelRow("claude-sonnet-4-6", models), "other");
});
