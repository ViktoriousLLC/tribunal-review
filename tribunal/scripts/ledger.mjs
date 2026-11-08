// Artifact identity ignores content: fixes stay in the same review history.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function artifactKey(artifact) {
  return artifact.prNumber != null ? `pr:${artifact.prNumber}` : `${artifact.kind}:${artifact.source}`;
}

export function artifactHistory(artifact, ledgerHome) {
  let files;
  try { files = readdirSync(ledgerHome).filter((f) => /^\d{4}-\d{2}\.ndjson$/.test(f)).sort(); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const rows = [];
  for (const file of files) {
    for (const line of readFileSync(join(ledgerHome, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.artifact && artifactKey(row.artifact) === artifactKey(artifact)) rows.push(row);
      } catch { /* Tolerate a half-written final ledger line. */ }
    }
  }
  return rows;
}
