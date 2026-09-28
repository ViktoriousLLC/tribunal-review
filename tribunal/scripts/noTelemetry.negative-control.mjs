// The network fixture must detect contacts even if production code swallows their errors.
// Mutate only disposable runner copies under OS temp; never edit the working tree.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "tribunal-network-negative-"));
try {
  const source = readFileSync(new URL("./run.mjs", import.meta.url), "utf8")
    .replace(/from "(\.\/[^"\n]+)"/g, (_, relative) => `from ${JSON.stringify(new URL(relative, import.meta.url).href)}`);
  const anchor = "  const policy = resolvePolicy(process.cwd(), policyOptions);";
  assert.equal(source.split(anchor).length, 2, "mutation anchor must identify main exactly once");
  const mutations = [
    ["off-vendor fetch", 'try { await fetch("https://telemetry.invalid/event"); } catch {}'],
    ["loopback fetch", 'try { await fetch("http://127.0.0.1:9/chat/completions"); } catch {}'],
    ["unexpected process", 'try { spawnSync("curl", ["https://telemetry.invalid/event"]); } catch {}'],
    ["unrequested GitHub", 'try { spawnSync("gh", ["api", "user"]); } catch {}'],
  ];
  for (const [name, mutation] of mutations) {
    const runner = join(root, "run.mjs");
    writeFileSync(runner, source.replace(anchor, `${mutation}\n${anchor}`));
    const env = { ...process.env, TRIBUNAL_TEST_RUNNER_URL: pathToFileURL(runner).href };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath,
      ["--test", "--test-reporter=tap", fileURLToPath(new URL("./noTelemetry.test.mjs", import.meta.url))],
      { env, encoding: "utf8", timeout: 30_000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, `${name} must make the fixture fail:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /unexpected network\/process contact, even if its error was swallowed/,
      `${name} must fail on the contact assertion, not an unrelated error:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# fail 1\b/);
    console.log(`negative control: ${name} detected (1 expected fixture failure)`);
  }
} finally {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  rmSync(root, { recursive: true, force: true });
}
