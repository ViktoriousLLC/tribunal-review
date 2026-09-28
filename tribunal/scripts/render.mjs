// Put the verdict and missing reviewers first so readers see what needs action.
//
// A model roster, repeated billing banners and synthesis can push findings below the fold.
// Keep routine metadata in the footer so it does not obscure actionable review results.
//
//   FIRST LINE ANSWERS "DO I HAVE TO DO ANYTHING?" and nothing else.
//   A LOST LEG IS ABOVE THE FOLD, because a missing reviewer changes what the rest is worth.
//   A SECTION WITH NO CONTENT IS OMITTED, never rendered empty.
//   NOTHING THAT IS THE SAME ON EVERY RUN, because a banner that always appears trains the
//   reader to skip it, and then it is not there when it matters.

const ICON = { BLOCKER: "⛔", SUGGESTION: "•", NIT: "·" };

export function verdictLine(clusters, actionableCount) {
  const n = (s) => clusters.filter((c) => c.severity === s).length;
  const parts = [`${n("SUGGESTION")} suggestions`, `${n("NIT")} nits`];
  return actionableCount > 0
    ? `⛔ ${actionableCount} to act on · ${parts.join(" · ")}`
    : `✅ Nothing to act on · ${parts.join(" · ")}`;
}

function findingBlock(c) {
  const where = c.file ? ` — \`${c.file}${c.line ? `:${c.line}` : ""}\`` : "";
  const who = c.foundBy.length > 1 ? `${c.foundBy.length} legs: ${c.foundBy.join(", ")}` : `only ${c.foundBy[0]}`;
  return [
    `${ICON[c.severity] || "·"} **${c.title}**${where}  _(${who})_`,
    c.why ? `  ${c.why}` : "",
    c.check ? `  _Check:_ ${c.check}` : "",
  ].filter(Boolean).join("\n");
}

export function render({ artifact, clusters, summary, decision, legs, round, elapsedMs, disabled = [], metered = null }) {
  const out = [];
  out.push(`## 🧑‍⚖️ Tribunal — ${artifact.title || artifact.source || "artifact"} (round ${round})`);
  out.push("");
  out.push(verdictLine(clusters, summary.actionableCount));
  out.push("");

  // ABOVE THE FOLD, always, when it happened. A lost leg changes how much the rest is worth,
  // and this is the line that stops a thin panel reading as a clean one.
  if (summary.missing.length) {
    out.push(`> **${summary.missing.length} leg(s) did not answer, so this is NOT a verdict on the whole artifact.**`);
    for (const m of summary.missing) out.push(`> - \`${m.leg}\`: ${m.error}`);
    out.push("");
  }
  // An unreadable leg is not a lost leg, but it contributed nothing, so the reader has to know
  // before believing a short finding list.
  if (summary.unreadable && summary.unreadable.length) {
    out.push(`> **${summary.unreadable.length} leg(s) answered but could not be parsed, so they contributed no findings.**`);
    for (const u of summary.unreadable) out.push(`> - \`${u.leg}\`: ${u.error}`);
    out.push("");
  }
  if (disabled.length) {
    out.push(`_Not run, so not counted as missing: ${disabled.join(", ")}._`);
    out.push("");
  }

  const bySev = (s) => clusters.filter((c) => c.severity === s);
  for (const [heading, list] of [["Blockers", bySev("BLOCKER")], ["Suggestions", bySev("SUGGESTION")]]) {
    if (!list.length) continue; // a section with no content is omitted, never rendered empty
    out.push(`### ${heading}`);
    for (const c of list) out.push(findingBlock(c), "");
  }

  const sole = clusters.filter((c) => c.foundBy.length === 1 && c.severity !== "NIT");
  if (sole.length) {
    out.push("### What only one model saw");
    out.push("_The reason to run a panel rather than one model. Also the shape a hallucination takes, so each is a hypothesis until checked._");
    for (const c of sole) out.push(`- ${ICON[c.severity]} **${c.title}** _(${c.foundBy[0]})_`);
    out.push("");
  }

  const nits = bySev("NIT");
  if (nits.length) {
    out.push(`<details><summary>${nits.length} nits</summary>`, "");
    for (const c of nits) out.push(`- ${c.title}${c.file ? ` — \`${c.file}\`` : ""}`);
    out.push("", "</details>", "");
  }

  out.push(`**Next:** ${decision.action} — ${decision.why}`);
  out.push("");
  const answered = legs.filter((l) => l.answered).map((l) => `${l.leg} (${l.model})`).join(", ");
  out.push(`_${legs.length} legs, ${(elapsedMs / 1000).toFixed(0)}s: ${answered || "none answered"}. ${costLine(metered)}_`);
  return out.join("\n");
}

/**
 * The cost line, MEASURED rather than asserted.
 *
 * Metered legs must report their measured cost rather than inherit the plan-covered $0 label.
 * A leg whose runner reports no usage renders as "not reported", never as zero, because
 * silence must not read as free.
 */
export function costLine(metered) {
  if (!metered || !Array.isArray(metered.rows) || metered.rows.length === 0) return "Cost: not reported.";
  const unmeasured = metered.unmeasured || [];
  const allPlan = metered.rows.every((r) => r.usd === 0 && /^plan/.test(r.basis || ""));
  if (allPlan) return "All legs plan-covered; $0 metered this round.";
  const total = `$${(metered.totalUsd ?? 0).toFixed(4)} metered`;
  return unmeasured.length
    ? `${metered.totalUsd > 0 ? `${total} measured; ` : ""}${unmeasured.join(", ")} cost is unknown (usage or model price missing) — UNPRICED: "not reported", not $0.`
    : `${total} this round.`;
}
