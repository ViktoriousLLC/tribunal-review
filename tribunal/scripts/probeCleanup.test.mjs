// RED-FIRST mutations: omit the per-call finally cleanup; omit canary cleanup on setup
// failure; remove isOurTempDir before rm; re-resolve the CLI after capturing its binding.
// Cover both per-call cleanup and orchestration failures so no scratch directory survives.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as probe from "./isolationProbe.mjs";
import { isOurTempDir } from "./legRunner.mjs";

const TOKEN = "TRIBUNAL-CANARY-0123456789abcdef0123456789abcdef";
const legs = [
  { leg: "claude", id: "test-claude", runner: "claude-cli", envKeys: [], enabled: true },
  { leg: "codex", id: "test-codex", runner: "codex-cli", envKeys: [], enabled: true },
];

function childWithReply(args, token = TOKEN) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => child.emit("close", null);
  const control = args.includes("--dangerously-skip-permissions")
    || args.includes("--dangerously-bypass-approvals-and-sandbox");
  setImmediate(() => {
    child.stdout.emit("data", control ? token : "CANNOT-READ");
    child.emit("close", 0);
  });
  return child;
}

async function removeCreated(dirs) {
  for (const dir of dirs) {
    assert.equal(isOurTempDir(dir), true, `refuse unsafe fixture cleanup: ${dir}`);
    await rm(dir, { recursive: true, force: true });
  }
}

for (const [index, fn] of [[0, probe.probeClaude], [1, probe.probeCodex]]) {
  for (const broken of [false, true]) {
    test(`${legs[index].runner} removes each scratch cwd after ${broken ? "spawn failure" : "measurement"}`, async () => {
      const dirs = [];
      try {
        await fn("ask", "injection", TOKEN, legs[index], { spawnFn: (_file, args, options) => {
          dirs.push(options.cwd);
          if (broken) throw new Error("stubbed spawn failure");
          return childWithReply(args);
        } });
        assert.equal(dirs.length, 3);
        assert.equal(new Set(dirs).size, 3, "all three observations start in fresh directories");
        for (const dir of dirs) assert.equal(existsSync(dir), false, `scratch directory leaked: ${dir}`);
      } finally {
        await removeCreated(dirs);
      }
    });
  }
}

test("probe cleanup preserves a caller's cwd that is not one of our temp directories", async (t) => {
  const survivor = await mkdtemp(join(tmpdir(), "tribunal-probe-survivor-"));
  t.after(() => rm(survivor, { recursive: true, force: true }));
  for (const [index, fn] of [[0, probe.probeClaude], [1, probe.probeCodex]]) {
    await fn("ask", "injection", TOKEN, legs[index], {
      spawnFn: (_file, args) => childWithReply(args), mkTemp: async () => survivor,
    });
    assert.equal(existsSync(survivor), true);
  }
});

test("a stubbed full probe removes every canary and per-call directory and pins measured executable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tribunal-probe-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = { repoRoot: root, modelsFile: join(root, "models.json"),
    probeRecord: join(root, "ledger", "isolation-probe.md"), registry: legs };
  const created = [], calls = [], versions = [];
  // Give this run a unique probe prefix so tests running in another process cannot race
  // the temp-root assertion. Production still chooses the canary/cwd prefix and guard.
  const testPrefix = `tribunal-leg-probe-${basename(root)}-`;
  try {
    const result = await probe.runProbe(policy, {
      createTemp: async (prefix) => {
        assert.ok(basename(prefix).startsWith("tribunal-leg-probe-"));
        const dir = await mkdtemp(join(tmpdir(), testPrefix + basename(prefix)));
        created.push(dir); return dir;
      },
      resolveExecutable: (cmd) => ({ file: join(root, `${cmd}.exe`), prefix: [], found: true }),
      spawnVersion: (file, args) => { versions.push({ file, args }); return { status: 0, stdout: "test CLI 1.0\n", stderr: "" }; },
      spawnFn: (file, args, options) => {
        calls.push({ file, args, cwd: options.cwd });
        assert.equal(existsSync(options.cwd), true);
        const canary = created.find((dir) => existsSync(join(dir, "review-config.json")));
        assert.ok(canary, "the canary must remain present throughout all measurements");
        const token = JSON.parse(readFileSync(join(canary, "review-config.json"), "utf8")).token;
        return childWithReply(args, token);
      },
    });
    assert.equal(result.recorded.verdict, "PASS");
    assert.equal(versions.length, 2);
    assert.equal(calls.length, 6);
    assert.equal(created.length, 7, "one canary and six separate invocation directories");
    assert.equal(new Set(calls.map((call) => call.cwd)).size, 6);
    for (const call of calls) assert.ok(versions.some((version) => version.file === call.file));
    for (const version of versions) assert.deepEqual(version.args, ["--version"]);
    for (const dir of created) assert.equal(existsSync(dir), false, `scratch directory leaked: ${dir}`);
    assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith(testPrefix)), []);
  } finally {
    await removeCreated(created);
  }
});

test("canary cleanup still runs when creating an invocation directory fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tribunal-probe-setup-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = { repoRoot: root, modelsFile: join(root, "models.json"),
    probeRecord: join(root, "isolation-probe.md"), registry: [legs[0]] };
  const created = [];
  try {
    await assert.rejects(() => probe.runProbe(policy, {
      createTemp: async (prefix) => {
        if (created.length) throw new Error("stubbed temp failure");
        const dir = await mkdtemp(prefix); created.push(dir); return dir;
      },
      resolveExecutable: () => ({ file: join(root, "claude.exe"), prefix: [], found: true }),
      spawnVersion: () => ({ status: 0, stdout: "test 1.0", stderr: "" }),
      spawnFn: () => { throw new Error("must not spawn after temp failure"); },
    }), /stubbed temp failure/);
    assert.equal(created.length, 1);
    assert.equal(existsSync(created[0]), false, "the canary survives neither setup nor invocation errors");
  } finally {
    await removeCreated(created);
  }
});
