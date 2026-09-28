// The credential boundary for configurable API origins. Never accept a trust path from
// repository policy or from a leg's environment; only the user's home owns this decision.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENAI_API_TIMEOUT_MS = 120_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AMBIENT_NETWORK_ENV = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  "SSL_CERT_DIR", "NODE_USE_ENV_PROXY", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED",
]);
// Literal loopback ADDRESSES only. "localhost" is a name a hosts file or resolver can point
// anywhere, so a plain-http exception keyed on it could carry the key off the machine.
const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);

function apiUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//.test(value)) {
    throw new Error("baseUrl must be an absolute https URL (http is allowed only on loopback)");
  }
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("baseUrl must contain only an origin and path prefix, without credentials, query or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("baseUrl requires https; http is allowed only on the loopback addresses 127.0.0.1 and ::1 (never a name, not even localhost)");
  }
  return url;
}

/** Also enforced on direct runner calls, which need not have passed through the registry. */
export function openaiApiRowProblems(leg) {
  const problems = [];
  if (!Array.isArray(leg.envKeys) || leg.envKeys.length !== 1
    || typeof leg.envKeys[0] !== "string" || !ENV_NAME.test(leg.envKeys[0])
    || AMBIENT_NETWORK_ENV.has(leg.envKeys[0].toUpperCase())) {
    problems.push("openai-api envKeys must name exactly one key variable, never a proxy or TLS environment setting");
  }
  if (!Array.isArray(leg.requiredEnv) || leg.requiredEnv.length !== 1
    || leg.requiredEnv[0] !== leg.envKeys?.[0]) {
    problems.push("openai-api requiredEnv must list exactly the same one variable as envKeys");
  }
  if (leg.billing !== "metered") problems.push('openai-api billing must be "metered"');
  if (leg.fallback !== undefined) problems.push("openai-api has no fallback: exactly one request per leg");
  if (leg.timeoutMs !== undefined && (!Number.isSafeInteger(leg.timeoutMs) || leg.timeoutMs <= 0
    || leg.timeoutMs > 2_147_483_647)) problems.push("openai-api timeoutMs must be a positive integer no greater than 2147483647");
  try { apiUrl(leg.baseUrl); }
  catch (error) { problems.push(`openai-api ${error.message}`); }
  return problems;
}

/** Refusal is returned before ANY lookup in source, including checking whether the key exists. */
export function openaiApiEnvironment(leg, source = process.env) {
  const problems = openaiApiRowProblems(leg);
  if (problems.length) return { env: {}, missing: [], refusal: problems.join("; ") };
  const url = apiUrl(leg.baseUrl);
  const name = leg.envKeys[0];
  const trustFile = join(homedir(), ".tribunal", "trust.json");
  let trusted = false;
  try {
    const trust = JSON.parse(readFileSync(trustFile, "utf8"));
    trusted = Array.isArray(trust?.bindings) && trust.bindings.some((entry) =>
      entry?.env === name && entry.origin === url.origin);
  } catch { /* Missing, unreadable or malformed trust is never authorization. */ }
  if (!trusted) {
    const binding = JSON.stringify({ env: name, origin: url.origin });
    return { env: {}, missing: [], refusal:
      `Refused: ${leg.leg} (${leg.id}) would send the value of ${name} as an Authorization: Bearer header ` +
      `and the review text to ${url.origin} (${url.href.replace(/\/+$/, "")}/chat/completions). ` +
      `This variable/origin pair is not authorized in ${trustFile}. ` +
      `The exact JSON entry in its "bindings" array would be: ${binding}. ` +
      "This refusal is the moment to stop and think: a copied config is how a key is stolen." };
  }
  const key = source[name];
  return { env: key ? { [name]: key } : {}, missing: key ? [] : [name], refusal: null };
}

export function openaiApiEndpoint(leg) {
  return `${apiUrl(leg.baseUrl).href.replace(/\/+$/, "")}/chat/completions`;
}
