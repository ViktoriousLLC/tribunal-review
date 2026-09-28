// Started only by the authorized parent runner, with exactly the bound key in env.
// A separate Node process keeps proxy, CA, NODE_OPTIONS and TLS settings in the parent
// from affecting fetch. Credentials and review text never appear in process arguments.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function requestCompletion({ endpoint, model, content, keyName, timeoutMs = 120_000 }, sourceEnv = process.env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sourceEnv[keyName]}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
    });
    return { status: response.status, body: await response.text() };
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const request = JSON.parse(readFileSync(0, "utf8"));
    console.log(JSON.stringify(await requestCompletion(request)));
  } catch (error) {
    // The parent redacts this private pipe before returning or banking any failure.
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
