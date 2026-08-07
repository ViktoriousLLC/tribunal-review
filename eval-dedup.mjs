import { appendFileSync } from "node:fs";
import { isDirectInvocation, reportMisidentifiedEntrypoint } from "./entrypoint.mjs";
import { pathToFileURL } from "node:url";
import { extractEvalData, isOurEvalComment, PANEL_LEG_KEYS } from "./eval-reviewer.mjs";

// A recorded review only counts as "this commit has been reviewed" if EVERY leg in it
// succeeded. The only thing this dedup may ever refuse is a second IDENTICAL review of
// IDENTICAL code by a FULLY WORKING panel. A run where a leg was skipped or errored — a
// rotated credential, a rate limit, a dropped call — reviewed that commit with fewer eyes
// than it should have, so the next request must run it again rather than inherit a partial
// verdict as if it were a clean one.
//
// EXPECTED keys, not present ones. Inspecting only what happens to be in the record let a
// leg that never ran at all pass as a complete panel: three ok legs and no entry for the
// fourth read as full strength. Cannot-tell is FALSE here — no perModel block, an empty
// one, or a leg missing its flag all mean re-review.
export function everyLegOk(data, expectedKeys = PANEL_LEG_KEYS) {
  const perModel = data?.perModel;
  if (!perModel || typeof perModel !== "object" || Array.isArray(perModel)) return false;
  if (!Array.isArray(expectedKeys) || expectedKeys.length === 0) return false;
  return expectedKeys.every((key) => perModel[key] && perModel[key].ok === true);
}

export function reviewedShaFromComments(comments) {
  if (!Array.isArray(comments)) return null;
  try {
    let latest = null;
    for (const comment of comments) {
      if (isOurEvalComment(comment)) latest = comment;
    }
    const data = latest ? extractEvalData(latest.body) : null;
    if (!everyLegOk(data)) return null;
    const headSha = data?.head_sha;
    return typeof headSha === "string" && headSha.trim() ? headSha : null;
  } catch {
    return null;
  }
}

export function dedupDecision({ headSha, reviewedSha, force }) {
  if (force === true) return { skip: false, reason: "force" };
  if (!headSha) return { skip: false, reason: "head-sha-missing" };
  const current = typeof headSha === "string" ? headSha.trim() : "";
  const reviewed = typeof reviewedSha === "string" ? reviewedSha.trim() : "";
  if (current && reviewed && current.toLowerCase() === reviewed.toLowerCase()) {
    return { skip: true, reason: "head-sha-match" };
  }
  return { skip: false, reason: "head-sha-not-reviewed" };
}

export function isPrNumber(value) {
  return /^\d+$/.test(String(value || ""));
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub GET ${path} returned ${res.status}`);
  return res.json();
}

function emitSkip(skip) {
  appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\n`);
}

async function main() {
  try {
    const repo = process.env.GITHUB_REPOSITORY;
    const pr = process.env.PR_NUMBER;
    const token = process.env.GITHUB_TOKEN;
    if (!repo || !pr || !token) throw new Error("missing GitHub repository, PR number, or token");
    // This value is interpolated into a GitHub API path. A non-numeric value must fail
    // toward running the review, never toward skipping it.
    if (!isPrNumber(pr)) throw new Error(`PR_NUMBER is not a number: ${pr}`);

    const pull = await gh(`/repos/${repo}/pulls/${pr}`);
    const comments = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await gh(`/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error("comments response was not an array");
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    const reviewedSha = reviewedShaFromComments(comments);
    const decision = dedupDecision({
      headSha: pull?.head?.sha,
      reviewedSha,
      force: process.env.EVAL_FORCE === "true",
    });
    console.log(`Eval dedup: ${decision.skip ? "skipping" : "running"} review (${decision.reason}).`);
    emitSkip(decision.skip);
  } catch (error) {
    console.warn(`Eval dedup warning, running review: ${String(error?.message || error)}`);
    try {
      emitSkip(false);
    } catch (outputError) {
      console.warn(`Eval dedup warning, could not write output: ${String(outputError?.message || outputError)}`);
    }
  }
}

// Real-path comparison, shared with the other two entry points — see entrypoint.mjs.
if (isDirectInvocation(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.warn(`Eval dedup warning, running review: ${String(error?.message || error)}`);
  });
} else if (reportMisidentifiedEntrypoint(process.argv[1], import.meta.url, "eval-dedup.mjs")) {
  // This one decides whether a review is SKIPPED, so a silent no-op here is the safe
  // direction (the review runs). It still must not be silent.
  process.exit(1);
}
