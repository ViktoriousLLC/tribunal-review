// Define what counts as a finding, what counts as a quiet round, and when the loop stops.
// Pure functions keep these decisions testable without running model reviews.
//
// Three properties govern the loop:
//
// 1. A DEAD LEG IS NEVER A QUIET ROUND. If the exit condition checks only for actionable
//    findings, a missing reply can look quiet. Every expected leg must actually answer.
//
// 2. THE LOOP STOPS ON QUIET. The round ceiling guards against runaway work; reaching it
//    with outstanding findings does not establish that the artifact is clean.
//
// 3. VERIFY THE LAST FIX BEFORE A NEW ROUND. Findings still present after an attempted fix
//    require finishing that fix before requesting another review.

/** Categories where a defect can hurt someone. Everything else is advice. */
export const ACTIONABLE_CATEGORIES = new Set(["correctness", "security", "money", "data-loss", "pii"]);

export const CEILING = 10;

/**
 * Is this finding worth another round?
 *
 * A BLOCKER in an actionable category always is. A SUGGESTION is only actionable when two or
 * more legs found it independently, because a lone suggestion is the shape both a real insight
 * and a hallucination can take.
 */
export function isActionable(finding) {
  if (!finding || !ACTIONABLE_CATEGORIES.has(finding.category)) return false;
  const sev = String(finding.severity || "").toUpperCase();
  if (sev === "BLOCKER") return true;
  if (sev === "SUGGESTION") return (finding.foundBy?.length ?? 0) >= 2;
  return false;
}

/**
 * The state of one round.
 *
 * `legs` is every ENABLED leg's outcome: { leg, answered, error }. A leg that is disabled in
 * models.json is not here at all — it was never expected, so it cannot make a round partial.
 * A leg that was expected and did not answer makes the round PARTIAL, which is not quiet.
 */
export function summariseRound({ legs = [], findings = [] } = {}) {
  const missing = legs.filter((l) => !l.answered).map((l) => ({ leg: l.leg, error: l.error || "no output" }));
  const actionable = findings.filter(isActionable);

  // A leg that replies in prose instead of JSON is `answered: true` with a parse error, which
  // is right — treating a talking leg as a dead one would stop the loop for the wrong reason.
  // But it contributes ZERO findings, so if EVERY leg does that, the round is "complete" with
  // nothing actionable. Track readability separately so a panel-wide parse failure cannot
  // be mistaken for a quiet round.
  const unreadable = legs.filter((l) => l.answered && l.parseFailed).map((l) => ({ leg: l.leg, error: l.error || "unparseable reply" }));
  const readable = legs.filter((l) => l.answered && !l.parseFailed);
  const noneReadable = legs.length > 0 && readable.length === 0;

  return {
    complete: legs.length > 0 && missing.length === 0,
    missing,
    unreadable,
    noneReadable,
    actionable,
    actionableCount: actionable.length,
    // "quiet" is a claim about the SYSTEM, and neither a partial panel nor a panel nobody
    // could read is entitled to make it. This is the most important line in the file.
    quiet: legs.length > 0 && missing.length === 0 && !noneReadable && actionable.length === 0,
  };
}

/**
 * What the loop does next.
 *
 * `previousActionable` are last round's actionable findings, and `stillPresent` is the subset
 * a re-check found still in the code. A fix that did not land is not a reason to start a new
 * round; it is a reason to finish the old one.
 */
export function loopDecision({ round, summary, previousActionable = [], stillPresent = [] }) {
  if (!summary) throw new Error("loopDecision needs a round summary");

  if (!summary.complete) {
    const names = summary.missing.map((m) => `${m.leg} (${m.error})`).join(", ");
    return {
      action: "STOP",
      reason: "PARTIAL",
      why: `the panel was incomplete: ${names}. A round with a lost leg is not a verdict, and it is never a quiet round. Fix the leg and re-run this round.`,
    };
  }

  if (summary.noneReadable) {
    const names = (summary.unreadable || []).map((m) => `${m.leg} (${m.error})`).join(", ");
    return {
      action: "STOP",
      reason: "UNREADABLE",
      why: `every leg answered and NONE of them could be parsed: ${names}. Zero findings here means the contract or the parser is broken, not that the artifact is clean.`,
    };
  }

  if (previousActionable.length > 0 && stillPresent.length > 0) {
    return {
      action: "REDO",
      reason: "FIX_DID_NOT_LAND",
      why: `${stillPresent.length} of the previous round's ${previousActionable.length} findings are still present. Re-verify before spending a new round.`,
      stillPresent,
    };
  }

  if (summary.quiet) {
    return { action: "STOP", reason: "QUIET", why: "a complete panel returned no actionable finding. This is the exit condition." };
  }

  if (round >= CEILING) {
    return {
      action: "STOP",
      reason: "CEILING",
      why: `round ${round} hit the ceiling of ${CEILING} while still producing ${summary.actionableCount} actionable finding(s). That is a signal about the artifact, not a clean bill: hand it back rather than declaring it done.`,
    };
  }

  return { action: "CONTINUE", reason: "ACTIONABLE", why: `${summary.actionableCount} actionable finding(s) to fix, then round ${round + 1}.` };
}

/** Every fifth round, a line about whether severity is falling — visible without being asked. */
export function trendLine(history) {
  if (!Array.isArray(history) || history.length < 5 || history.length % 5 !== 0) return null;
  const firstHalf = history.slice(0, Math.floor(history.length / 2));
  const secondHalf = history.slice(Math.floor(history.length / 2));
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const early = avg(firstHalf), late = avg(secondHalf);
  const dir = late < early ? "falling" : late > early ? "RISING" : "flat";
  return `Round ${history.length}: actionable findings per round is ${dir} (${early.toFixed(1)} early, ${late.toFixed(1)} late). ${
    dir === "RISING" ? "A rising rate usually means the artifact is still changing under the review, not that it is getting worse." : ""
  }`.trim();
}

/**
 * Merge the legs' separate finding lists into clusters, so "three models said the same thing"
 * reads as one finding found by three rather than three findings.
 *
 * Deliberately mechanical and deliberately conservative. Two findings are the same issue when
 * they name the same file AND their titles share enough words. Over-merging is the dangerous
 * direction: it would hide a distinct defect behind a similar-sounding one and inflate the
 * agreement count, which is what promotes a suggestion to actionable. Under-merging only costs
 * a duplicate line in the output.
 */
const STOPWORDS = new Set(["the", "a", "an", "is", "are", "in", "on", "of", "to", "and", "or", "for", "not", "with", "this", "that", "it", "be", "by", "from", "at", "as"]);

export function tokens(s) {
  return new Set(
    String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / (A.size + B.size - shared);
}

const SEVERITY_RANK = { BLOCKER: 3, SUGGESTION: 2, NIT: 1 };

export function sameIssue(a, b, threshold = 0.5) {
  const fa = (a.file || "").trim(), fb = (b.file || "").trim();
  // Different named files are different issues, full stop. Two legs naming DIFFERENT files
  // have not corroborated each other, however similar the wording.
  if (fa && fb && fa !== fb) return false;
  return similarity(a.title, b.title) >= threshold;
}

export function clusterFindings(perLeg, { threshold = 0.5 } = {}) {
  const clusters = [];
  for (const { leg, findings } of perLeg) {
    for (const f of findings || []) {
      if (!f || !f.title) continue;
      const hit = clusters.find((c) => sameIssue(c, f, threshold) && !c.foundBy.includes(leg));
      if (hit) {
        hit.foundBy.push(leg);
        // Keep the WORST severity any leg assigned. A finding one model calls a blocker is a
        // blocker; letting a milder duplicate downgrade it would quietly disarm the loop.
        if ((SEVERITY_RANK[String(f.severity).toUpperCase()] || 0) > (SEVERITY_RANK[hit.severity] || 0)) {
          hit.severity = String(f.severity).toUpperCase();
        }
        if (!hit.file && f.file) hit.file = f.file;
        hit.alsoSaid.push({ leg, title: f.title, why: f.why });
      } else {
        clusters.push({
          title: f.title,
          severity: String(f.severity || "NIT").toUpperCase(),
          category: String(f.category || "").toLowerCase(),
          file: f.file || null,
          line: f.line ?? null,
          why: f.why || "",
          check: f.check || "",
          foundBy: [leg],
          alsoSaid: [],
        });
      }
    }
  }
  return clusters.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) || b.foundBy.length - a.foundBy.length);
}

/** Which legs found something nobody else did — the reason to run a panel rather than one model. */
export function soleFindsByLeg(findings) {
  const counts = {};
  for (const f of findings) {
    const by = f.foundBy || [];
    if (by.length !== 1) continue;
    counts[by[0]] = (counts[by[0]] || 0) + 1;
  }
  return counts;
}

/**
 * Is this round a PASS that may be recorded as proof on a pull request?
 *
 * Only QUIET. `loopDecision` returns `action: "STOP"` for four different reasons and its own text
 * disqualifies three of them:
 *
 *   PARTIAL    - a leg was lost. "A round with a lost leg is not a verdict."
 *   UNREADABLE - nothing parsed. "The contract or the parser is broken, not that the artifact is clean."
 *   CEILING    - the round limit with findings outstanding. "A signal about the artifact, not a clean bill."
 *   QUIET      - "A complete panel returned no actionable finding. This is the exit condition."
 *
 * A caller that gates on the ACTION posts a reviewed-and-passed proof for a panel that lost a leg.
 * This lives here, exported and tested, rather than as a condition at the call site, because a
 * comment cannot stop someone widening it back.
 */
export function isPassingRound(decision) {
  return Boolean(decision) && decision.action === "STOP" && decision.reason === "QUIET";
}

/**
 * May this round be recorded on a pull request as "this commit was reviewed"?
 *
 * Completion and passing are separate properties. A complete, readable review can be
 * recorded even when it finds actionable issues; requiring QUIET here would prevent
 * recording that the commit was reviewed whenever findings remain.
 *
 * The gate asks whether the commit was reviewed. Whether it PASSED is `isPassingRound`, it is
 * written into the comment body beside the finding count, and it is answered by the person reading.
 *
 * A panel that lost a leg or that nobody could parse is still not a review: those are the same two
 * disqualifiers `loopDecision` names, and they stay.
 */
export function isRecordableRound(summary) {
  return Boolean(summary) && summary.complete === true && summary.noneReadable !== true;
}
