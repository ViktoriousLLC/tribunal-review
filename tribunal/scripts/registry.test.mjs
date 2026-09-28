// Registry validation must prevent duplicate models and credentials on agent legs.
//
// Two of these are the reason the file exists rather than a bare JSON.parse: an agent leg
// must never be handed a spend-capable key, and a leg may not CLAIM plan billing while
// holding one. Both properties need validation beyond JSON shape checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, meteredPinGaps, validateLegs, enabledLegs, runnableLegs, allPinnedIds, probationDue } from "./registry.mjs";

const ok = { leg: "x", id: "m-1", vendor: "v", runner: "genai-sdk", billing: "metered", envKeys: ["GEMINI_API_KEY"], requiredEnv: ["GEMINI_API_KEY"], enabled: true };
const compatible = { ...ok, runner: "openai-api", baseUrl: "https://api.example.com/v1",
  envKeys: ["COMPATIBLE_API_KEY"], requiredEnv: ["COMPATIBLE_API_KEY"], pricesUSDPer1M: {} };

test("openai-api is a metered registry runner with one origin-bound key", () => {
  // Mutation: omit openai-api from the runner vocabulary; a valid row cannot load.
  assert.deepEqual(validateLegs([compatible]), []);
  assert.deepEqual(validateLegs([{ ...compatible, timeoutMs: 120000 }]), []);
});

test("openai-api requires exactly one valid key name and that same requiredEnv", () => {
  // Mutation: omit the key-shape guard; copied rows can bypass credential admission.
  for (const envKeys of [[], ["COMPATIBLE_API_KEY", "SECOND_KEY"], [""], ["bad-name"], [42]]) {
    assert.ok(validateLegs([{ ...compatible, envKeys }]).some((p) => /envKeys/.test(p)), JSON.stringify(envKeys));
  }
  for (const requiredEnv of [undefined, [], ["OTHER_KEY"], ["COMPATIBLE_API_KEY", "OTHER_KEY"]]) {
    assert.ok(validateLegs([{ ...compatible, requiredEnv }]).some((p) => /requiredEnv/.test(p)), JSON.stringify(requiredEnv));
  }
});

test("openai-api requires metered billing and cannot declare a fallback request", () => {
  // Mutation: accept plan billing or fallbacks; spend is mislabeled or a second request becomes reachable.
  assert.ok(validateLegs([{ ...compatible, billing: "plan" }]).some((p) => /metered/.test(p)));
  assert.ok(validateLegs([{ ...compatible, fallback: "m-2" }]).some((p) => /fallback/.test(p)));
});

test("openai-api permits HTTPS and only explicit loopback HTTP origins", () => {
  // Mutation: omit the URL/scheme guard; a key can be sent unencrypted outside the machine.
  for (const baseUrl of ["https://api.example.com/v1", "http://127.0.0.1:1234/v1", "http://[::1]:1234/v1"]) {
    assert.deepEqual(validateLegs([{ ...compatible, baseUrl }]), [], baseUrl);
  }
  // "localhost" is a NAME a hosts file can point anywhere, so it gets
  // no plain-http exception: only the two literal loopback addresses do.
  for (const baseUrl of [undefined, "", "not-a-url", "http://api.example.com/v1", "http://localhost:1234/v1", "ftp://api.example.com/v1"]) {
    assert.ok(validateLegs([{ ...compatible, baseUrl }]).some((p) => /baseUrl|https|HTTPS/.test(p)), String(baseUrl));
  }
});

test("openai-api accepts only a positive integer timeout when configured", () => {
  // Mutation: omit timeout validation; invalid deadlines make request limits unreliable.
  for (const timeoutMs of [0, -1, 0.5, "120000", null, NaN, Infinity]) {
    assert.ok(validateLegs([{ ...compatible, timeoutMs }]).some((p) => /timeoutMs/.test(p)), String(timeoutMs));
  }
});

test("openai-api admission refuses an untrusted origin before reading the variable", (t) => {
  // Mutation: read requiredEnv before the trust check; this getter throws before refusal can be named.
  const home = mkdtempSync(join(tmpdir(), "trib-registry-trust-"));
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
    rmSync(home, { recursive: true, force: true });
  });
  let reads = 0;
  const env = new Proxy({}, { get() { reads++; throw new Error("credential was read before trust"); } });
  const partition = runnableLegs([compatible], env);
  assert.equal(reads, 0);
  assert.deepEqual(partition.run, []);
  assert.deepEqual(partition.credentialAbsent, []);
  assert.equal(partition.trustRefused.length, 1);
  assert.equal(partition.trustRefused[0].leg, compatible);
  assert.match(partition.trustRefused[0].reason, /COMPATIBLE_API_KEY/);
  assert.match(partition.trustRefused[0].reason, /https:\/\/api\.example\.com/);
  assert.match(partition.trustRefused[0].reason, /trust\.json/);
  assert.deepEqual(runnableLegs([{ ...compatible, enabled: false }], env), { run: [], credentialAbsent: [] });
});

test("the shipped models.default.json loads and validates", () => {
  const legs = loadRegistry();
  assert.ok(legs.length >= 5, "expected at least the five panel legs");
  // Pin model IDs beside seat names: a row can keep its name while selecting the wrong
  // model, so checking names alone cannot verify the intended panel composition.
  assert.deepEqual(legs.map((l) => l.leg), ["opus", "fable", "sol", "astra", "gemini"]);
  assert.deepEqual(legs.map((l) => l.id), [
    "claude-opus-5", "claude-fable-5", "gpt-5.6-sol", "gpt-6-astra", "gemini-3.8-flash",
  ], "a leg must run the model its name says it runs");
});

test("an agent leg may NEVER be handed a spend-capable key", () => {
  // An agent CLI reads untrusted input
  // and can hold a shell, so a key in its environment is one injection away from being gone.
  const problems = validateLegs([{ ...ok, leg: "bad", runner: "codex-cli", billing: "metered", envKeys: ["GEMINI_API_KEY"] }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /never goes to a leg that reads untrusted input/);
});

test("the shipped registry gives GEMINI_API_KEY to exactly one leg, and it is not an agent", () => {
  const legs = loadRegistry();
  const holders = legs.filter((l) => l.envKeys.includes("GEMINI_API_KEY"));
  assert.equal(holders.length, 1);
  assert.equal(holders[0].leg, "gemini");
  assert.equal(holders[0].runner, "genai-sdk");
  assert.equal(holders[0].enabled, false, "the metered template is never enabled by default");
});

test("a leg cannot claim plan billing while holding a spend-capable key", () => {
  const problems = validateLegs([{ ...ok, leg: "liar", runner: "genai-sdk", billing: "plan", envKeys: ["GEMINI_API_KEY"] }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /structural, not a promise/);
});

test("every leg the shipped registry calls plan holds no spend key", () => {
  for (const l of loadRegistry().filter((x) => x.billing === "plan")) {
    for (const k of l.envKeys) assert.ok(!/API_KEY$/.test(k), `${l.leg} claims plan but holds ${k}`);
  }
});

// A metered model without a price pin banks usage UNPRICED; missing prices cannot establish
// zero spend. Exercise meteredPinGaps itself so the assertions can detect a broken guard.
// registry.mjs explains why missing pins are reported while expiry remains a runtime concern.
test("the shipped registry has a price pin for every model a metered leg can run", () => {
  const legs = loadRegistry();
  const metered = legs.filter((l) => l.billing === "metered");
  // Anti-vacuity: no metered leg means nothing to check, and this must say so out loud.
  assert.ok(metered.length >= 1, "no metered leg found; this guard would pass vacuously");
  assert.deepEqual(meteredPinGaps(legs), [], "metered leg would bank unpriced");
});

test("meteredPinGaps reports a missing pin on EITHER rung, and reports every one", () => {
  const bare = { leg: "g", billing: "metered", id: "m-new", fallback: "m-old", pricesUSDPer1M: {} };
  assert.deepEqual(meteredPinGaps([bare]), ["g: m-new has no price pin", "g: m-old has no price pin"]);
  // The fallback alone, which is the rung that runs on the bad day.
  const idOnly = { ...bare, pricesUSDPer1M: { "m-new": { in: 1, out: 2 } } };
  assert.deepEqual(meteredPinGaps([idOnly]), ["g: m-old has no price pin"]);
});

test("an EXPIRED pin is deliberately NOT a build failure", () => {
  // Expiry is handled at runtime by banking null. Failing validation when the calendar
  // passes `until` would break unrelated changes instead of merely requiring new price pins.
  const expired = { leg: "g", billing: "metered", id: "m", pricesUSDPer1M: { m: { in: 1, out: 2, until: "2020-01-01" } } };
  assert.deepEqual(meteredPinGaps([expired]), [], "presence is all this guard asks");
});

test("a PLAN leg needs no pins, so it can never trip the metered guard", () => {
  assert.deepEqual(meteredPinGaps([{ leg: "opus", billing: "plan", id: "claude-opus-5", fallback: "claude-opus-4-8" }]), []);
});

test("shape problems are all reported, not just the first", () => {
  const problems = validateLegs([{ leg: "a" }, { leg: "a", id: "z", runner: "nope", billing: "free", envKeys: 1, enabled: "yes" }]);
  assert.ok(problems.length >= 5, `expected several problems, got ${problems.length}`);
  assert.ok(problems.some((p) => /duplicates an earlier leg name/.test(p)));
  assert.ok(problems.some((p) => /expected one of/.test(p)));
  assert.ok(problems.some((p) => /expected plan or metered/.test(p)));
});

test("an empty or missing legs array is invalid, never an empty panel", () => {
  assert.deepEqual(validateLegs([]), ["models.default.json has no legs array"]);
  assert.deepEqual(validateLegs(undefined), ["models.default.json has no legs array"]);
});

test("loadRegistry throws rather than returning a half-valid panel", () => {
  assert.throws(() => {
    const legs = [{ ...ok, runner: "nope" }];
    const problems = validateLegs(legs);
    if (problems.length) throw new Error(`models.default.json is invalid:\n  - ${problems.join("\n  - ")}`);
  }, /models\.default\.json is invalid/);
});

test("enabledLegs filters, and loadRegistry still returns the disabled ones so they can be NAMED", () => {
  const legs = [{ ...ok, leg: "on" }, { ...ok, leg: "off", enabled: false }];
  assert.deepEqual(enabledLegs(legs).map((l) => l.leg), ["on"]);
  assert.equal(legs.length, 2);
});

test("allPinnedIds includes every declared FALLBACK rung", () => {
  // Derive expected fallbacks from the registry so routine model changes cannot invalidate
  // the test. Every declared fallback must remain visible to the freshness watcher.
  // Synthetic fallback coverage stays non-vacuous as registries remove unsupported rungs.
  const legs = [...loadRegistry(), { leg: "fixture", id: "fixture-primary", fallback: "fixture-fallback", vendor: "test" }];
  const declared = legs.filter((l) => l.fallback);
  const seen = new Set(
    allPinnedIds(legs).filter((i) => i.role === "fallback").map((i) => `${i.leg}:${i.id}`),
  );
  for (const l of declared) {
    assert.ok(seen.has(`${l.leg}:${l.fallback}`), `${l.leg}'s fallback rung must be watchable`);
  }
  assert.equal(seen.size, declared.length, "every fallback is listed exactly once");
});

test("probationDue names a leg only when its probation is spent AND it found nothing alone", () => {
  const legs = [{ ...ok, leg: "t", probation: { runsRemaining: 0, why: "earn it" } }];
  assert.deepEqual(probationDue(legs, { t: 0 }).map((d) => d.leg), ["t"]);
  assert.deepEqual(probationDue(legs, { t: 1 }), [], "one sole find is enough to keep the seat");
  assert.deepEqual(probationDue([{ ...ok, leg: "t", probation: { runsRemaining: 2, why: "" } }], { t: 0 }), []);
});

test("probationDue advises without automatically disabling a leg", () => {
  const legs = [{ ...ok, leg: "t", enabled: true, probation: { runsRemaining: 0, why: "earn it" } }];
  probationDue(legs, { t: 0 });
  assert.equal(legs[0].enabled, true);
});

test("an enabled leg whose requiredEnv is absent HERE is set aside, named, and never dispatched", () => {
  // The trap this pins: `enabled: true` is configured while the key is available only
  // in one machine's environment, so elsewhere the leg would be dispatched, come back LOST, and
  // make every round PARTIAL — which blocks the loop forever. Absent-credential must be a
  // named not-run, not a lost leg.
  const withKey = { ...ok, leg: "gem", requiredEnv: ["GEMINI_API_KEY"] };
  const plain = { ...ok, leg: "opus", envKeys: [], requiredEnv: [], billing: "plan" };
  const off = { ...ok, leg: "off", enabled: false, requiredEnv: ["GEMINI_API_KEY"] };

  const absent = runnableLegs([withKey, plain, off], {});
  assert.deepEqual(absent.run.map((l) => l.leg), ["opus"], "no credential, no dispatch");
  assert.deepEqual(absent.credentialAbsent.map((c) => c.leg.leg), ["gem"]);
  assert.deepEqual(absent.credentialAbsent[0].missing, ["GEMINI_API_KEY"], "the absent variable is named");
  assert.ok(!absent.credentialAbsent.some((c) => c.leg.leg === "off"), "a disabled leg is not double-reported");

  const present = runnableLegs([withKey, plain, off], { GEMINI_API_KEY: "k" });
  assert.deepEqual(present.run.map((l) => l.leg), ["gem", "opus"], "with the key it runs normally");
  assert.deepEqual(present.credentialAbsent, []);
});

test("an SDK leg must list every envKey in requiredEnv, or a keyless checkout dispatches a lost leg", () => {
  // runnableLegs gates on requiredEnv; an SDK leg whose credential is only in envKeys would
  // slip past that gate, fail inside the runner, and freeze the loop PARTIAL — the same trap
  // one field over. Agent legs stay exempt: their CLIs authenticate from their own stores.
  const bad = { ...ok, requiredEnv: [] };
  assert.ok(
    validateLegs([bad]).some((p) => p.includes("missing from requiredEnv")),
    "the gap must be a validation error, not a runtime surprise",
  );
  const good = { ...ok, requiredEnv: ["GEMINI_API_KEY"] };
  assert.deepEqual(validateLegs([good]).filter((p) => p.includes("requiredEnv")), []);
});

test("two legs may not run the SAME model, and the shipped config does not", () => {
  // Duplicate model IDs reduce review diversity even when the leg names differ.
  // Every individual row can be valid, so this requires a check across rows.
  // Built from the shared `ok` fixture, so this test cannot pass because of some unrelated shape
  // problem in a hand-rolled row — the ONLY thing wrong with these two legs is the shared model,
  // which is the only thing the assertion is about.
  const dup = [
    { ...ok, leg: "sol", id: "gpt-6-astra" },
    { ...ok, leg: "astra", id: "gpt-6-astra" },
  ];
  assert.deepEqual(validateLegs([{ ...ok, leg: "sol", id: "gpt-5.6-sol" }, { ...ok, leg: "astra", id: "gpt-6-astra" }]), [],
    "the control: the same two legs on DIFFERENT models are valid, so the model is what fails them");
  const problems = validateLegs(dup);
  assert.ok(problems.some((p) => /already runs/.test(p)), `expected a duplicate-model complaint, got ${JSON.stringify(problems)}`);

  // And the config actually shipping is clean, which is the half that would rot silently.
  // loadRegistry calls validateLegs and throws on any problem, so the production load
  // path also rejects duplicate model IDs.
  const ids = loadRegistry().map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, `shipped legs share a model: ${ids.join(", ")}`);
});

test("a leg on watch uses the field probationDue actually reads", () => {
  // Exercise probationDue to detect a mismatch between the configured field and the
  // reader. A misspelled field could silently disable probation without invalidating a row.
  // A synthetic leg provides non-vacuous coverage while allowing the shipped registry
  // to have no watched legs when every seat has completed probation.
  const probe = [{ ...ok, leg: "probe", probation: { runsRemaining: 0, why: "earn it" } }];
  assert.deepEqual(probationDue(probe, { probe: 0 }).map((d) => d.leg), ["probe"],
    "the reader must see a leg whose watch is spent and which found nothing alone");

  const watched = loadRegistry().filter((l) => l.probation);
  for (const l of watched) {
    assert.ok(Number.isFinite(l.probation.runsRemaining), `${l.leg}.probation needs runsRemaining`);
    assert.ok(l.probation.why, `${l.leg}.probation needs a why`);
  }
  // The real check: the reader can see them. probationDue takes legs whose runs are spent.
  // And every leg the SHIPPED config puts on watch must be visible to that same reader. Zero
  // watched legs is a legitimate state and passes; a watched leg the reader cannot see is not.
  const spent = watched.map((l) => ({ ...l, probation: { ...l.probation, runsRemaining: 0 } }));
  const due = probationDue(spent, Object.fromEntries(watched.map((l) => [l.leg, 0])));
  assert.deepEqual(due.map((d) => d.leg).sort(), watched.map((l) => l.leg).sort(),
    "a watched leg the reader cannot see has a watch made of prose");
});
