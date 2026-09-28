// A flat pin undercounts vendors that re-rate the WHOLE request above a prompt-size threshold.
// The fixture uses $2/$12 up to 200k prompt tokens and $4/$18 above; tierAt must switch both
// input and output rates for the entire over-threshold request.
import test from "node:test";
import assert from "node:assert/strict";
import { geminiCostUSD } from "./legRunner.mjs";

const PIN = { "gemini-3.1-pro-preview": { in: 2, out: 12, tierAt: 200000, tierIn: 4, tierOut: 18 } };

test("above tierAt the WHOLE request re-rates to the tier prices", () => {
  const usd = geminiCostUSD("gemini-3.1-pro-preview", { tokensIn: 250000, tokensOut: 10000 }, PIN);
  assert.equal(usd, (250000 * 4 + 10000 * 18) / 1e6);
});

test("at or below tierAt the base prices apply", () => {
  const usd = geminiCostUSD("gemini-3.1-pro-preview", { tokensIn: 200000, tokensOut: 10000 }, PIN);
  assert.equal(usd, (200000 * 2 + 10000 * 12) / 1e6);
});

test("a tiered pin with a non-finite tier rate refuses to price an over-threshold call", () => {
  const bad = { m: { in: 2, out: 12, tierAt: 200000, tierIn: NaN, tierOut: 18 } };
  assert.equal(geminiCostUSD("m", { tokensIn: 250000, tokensOut: 1 }, bad), null);
});

test("a flat pin without tierAt behaves exactly as before", () => {
  assert.equal(geminiCostUSD("m", { tokensIn: 100, tokensOut: 100 }, { m: { in: 1, out: 2 } }), (100 * 1 + 100 * 2) / 1e6);
});
