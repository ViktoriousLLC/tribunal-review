// Local files and pasted text need the same protected review boundary as PRs.
//
// An artifact can be a PR diff, a file, or pasted text. Each source is converted to the
// same input shape so all three receive the same review protections.
//
// Everything below is pure except `fromPr`, which shells out to `gh`.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";

export const MAX_CHARS_DEFAULT = 500_000;
export const GH_MISSING_MESSAGE = "`gh` is not on PATH; --pr and proof posting need the GitHub CLI; --file and --stdin do not";

/**
 * Secrets are redacted from the FULL text BEFORE truncation.
 *
 * The order is the point and it is not stylistic: truncate first and a secret straddling the
 * boundary has its tail escape masking.
 */
// NO LEADING \b ON THE PREFIXED PATTERNS. `\b` needs a non-word character before the prefix, so a key
// embedded in a run of word characters — inside a base64 blob, a URL path, a minified line —
// would be left in the clear and then sliced by the truncator. A redactor that only works on
// well-spaced input is a redactor that fails on exactly the inputs worth worrying about.
const REDACTIONS = [
  [/(sk-[A-Za-z0-9_-]{16,})/g, "sk-REDACTED"],
  [/(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "gh-REDACTED"],
  [/(AIza[0-9A-Za-z_-]{30,})/g, "AIza-REDACTED"],
  [/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "jwt-REDACTED"],
  // The value may not contain brackets or parentheses, and it must end at a real terminator. A
  // secret never contains either, and code does: a looser rule rewrites an expression such as
  // `const someToken = [encode(header), ...]` mid-line, and every leg then reports the runner's own
  // edit as a syntax error in the author's code. The lookahead stops the regex from backtracking
  // into the first letters of a call like `getAccessToken(...)`. The replacement names the runner,
  // so a leg that does see one cannot mistake it for the author's text.
  [/((?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*["']?)([^\s"',;()[\]{}<>]{12,})(?![^\s"',;()[\]{}<>]|[([{])/gi, "$1[secret removed by the review runner]"],
];

export function redactSensitive(text) {
  let out = String(text ?? "");
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

/**
 * Authorship trailers are stripped so no leg can infer who wrote the thing it is grading.
 * Model names, vendors and ticket ids SURVIVE: in this repo they are routinely the subject
 * matter under review, and stripping them would blind the panel to what it is looking at.
 */
export function stripAuthorshipSignals(text) {
  return String(text ?? "")
    .replace(/^\s*Co-Authored-By:.*$/gim, "")
    .replace(/^\s*Claude-Session:.*$/gim, "")
    .replace(/^\s*🤖 Generated with \[Claude Code\].*$/gim, "")
    .replace(/^\s*https:\/\/claude\.ai\/code\/session_\S*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Neutralise a block's own boundary TAGS — opening and closing — so crafted content cannot forge
 * the structure it sits inside.
 *
 * The invariant:
 * every character survives byte-identical EXCEPT the two angle brackets of a sequence that is a
 * boundary tag for this block. An artifact that discusses these tag names by name therefore does
 * see those two characters escaped. The insides of a matched tag, whitespace included,
 * are left exactly as they were.
 *
 * Blanket substitution of `<` and `>` with lookalikes U+2039 and U+203A would corrupt
 * source: `status >= 500`, `<<'EOF'`, and `Array<string>` must remain byte-identical.
 * Such corruption can also alter quotations of the defect in review input, so
 * `artifact.test.mjs` exercises the transformation directly and compares code points.
 *
 * `tag` is REQUIRED and a missing one throws rather than returning the text unprotected: a
 * boundary function that silently does nothing is the failure mode worth being loud about.
 */
export function neutralizeTag(text, tag) {
  const name = String(tag ?? "");
  if (!name) throw new Error("neutralizeTag needs the tag it is protecting; refusing to return unprotected text");
  // The tag is interpolated into a RegExp, so it is escaped. Today it is always one of our own
  // literals, and that is exactly the assumption worth not depending on.
  const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Models read whitespace/case/invisible-separator variants as boundaries too. Escape
  // only the angle brackets of boundary openers and closers, leaving their contents and
  // every ordinary source-code character untouched. An entity is clearer than a backslash
  // escape to a model reader. The separator class covers whitespace and Unicode format
  // characters without an ever-growing enumeration of code points.
  //
  // This is defense in depth: attributes and self-closing forms are not matched, and no
  // textual escape is provably inert to a language-model reader. Findings remain data;
  // they never authorize a merge, write or deploy on their own.
  const SEP = "[\\p{White_Space}\\p{Cf}]*";
  return String(text ?? "")
    .replace(new RegExp(`<(${SEP}/${SEP}${safeName}${SEP})>`, "giu"), "&lt;$1&gt;")
    .replace(new RegExp(`<(${SEP}${safeName}${SEP})>`, "giu"), "&lt;$1&gt;");
}

/**
 * Wrap an artifact for a reviewer.
 *
 * Redact, then strip authorship, then neutralise, THEN truncate. A partial read is announced
 * in the text itself, because an empty finding list on a truncated artifact means very little
 * and the reader has no other way to know.
 */
export function buildUserMessage(artifact, { maxChars = MAX_CHARS_DEFAULT } = {}) {
  const kind = artifact.kind || "artifact";
  // Two blocks exist in the assembled message, so no embedded text may emit EITHER closing tag.
  const shield = (text) => neutralizeTag(neutralizeTag(text, kind), `${kind}_title`);
  const safe = shield(stripAuthorshipSignals(redactSensitive(artifact.text)));
  const truncated = safe.length > maxChars;
  const body = truncated ? safe.slice(0, maxChars) : safe;
  const pct = truncated ? Math.floor((maxChars / safe.length) * 100) : 100;
  const header = truncated
    ? `PARTIAL: only the first ${pct}% of this ${kind} is below. An empty finding list covers ONLY the part you were shown.`
    : "";
  return [
    header,
    `<${kind}_title>${shield(artifact.title || basename(artifact.source || "artifact"))}</${kind}_title>`,
    `<${kind}>`,
    body,
    `</${kind}>`,
  ].filter(Boolean).join("\n");
}

/** A local file, hashed from the same bytes supplied for review. */
export function fromFile(path) {
  const bytes = readFileSync(path);
  return {
    kind: "document", source: path, title: basename(path), text: bytes.toString("utf8"),
    contentHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Pasted text, with no file behind it. Same path, so "proof this report" needs no ceremony. */
export function fromText(text, title = "pasted text") {
  const content = String(text);
  return {
    kind: "document", source: null, title, text: content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

/** A pull request, via `gh`. Kept last because it is the only impure one. */
export function fromPr(prNumber, { repo, exec = execFileSync } = {}) {
  const gh = (args, maxBuffer) => {
    try { return exec("gh", args, { encoding: "utf8", maxBuffer }); }
    catch (error) {
      if (error.code === "ENOENT") throw Object.assign(new Error(GH_MISSING_MESSAGE), { code: "GH_NOT_FOUND" });
      throw error;
    }
  };
  const args = ["pr", "view", String(prNumber), "--json", "title,body,headRefOid"];
  if (repo) args.push("--repo", repo);
  const meta = JSON.parse(gh(args, 64 * 1024 * 1024));
  const diffArgs = ["pr", "diff", String(prNumber)];
  if (repo) diffArgs.push("--repo", repo);
  const diff = gh(diffArgs, 64 * 1024 * 1024);

  // Re-read the head AFTER the diff and refuse to certify if it moved.
  //
  // The head and the diff come from two separate `gh` calls, so a push landing between them gives
  // a head from before and a diff from after — and the proof would then certify a commit whose
  // diff the panel never read, which is the one thing the head in that marker is for. A review
  // that raced a push is a review of neither commit.
  //
  // The panel still RUNS and reports on what it read; only `headSha` is withheld, and a null head
  // is exactly what stops `postLocalProof` posting. Withholding the certification is right and
  // refusing the review would not be: the findings are still about real code.
  let headSha = typeof meta.headRefOid === "string" ? meta.headRefOid : null;
  if (headSha) {
    const afterArgs = ["pr", "view", String(prNumber), "--json", "headRefOid"];
    if (repo) afterArgs.push("--repo", repo);
    let after = null;
    try {
      after = JSON.parse(gh(afterArgs, 1024 * 1024));
    } catch (error) {
      if (error.code === "GH_NOT_FOUND") throw error;
      after = null;
    }
    // An unreadable second look is not evidence the head held still, so it withholds too.
    if (!after || after.headRefOid !== headSha) headSha = null;
  }

  return {
    kind: "diff",
    source: `PR #${prNumber}`,
    title: meta.title,
    text: `${meta.body || ""}\n\n${diff}`,
    prNumber,
    headSha,
    // Only a head verified on both sides of the diff identifies the reviewed content.
    contentHash: headSha,
  };
}
