#!/usr/bin/env node
// Pre-publish deny-list scan. Dependency-free, deterministic, exit 1 on any hit.
//
// This runs against the STAGING FOLDER before `git init` ever happens. Once a
// commit exists and is pushed, nothing here can help: GitHub retains objects,
// forks keep copies, and public event archives capture pushes as they happen.
// So this is the gate, and it runs before the repo exists.
//
// It self-excludes only its own file (the pattern list necessarily contains the
// strings it looks for). Every other file, including the README, is scanned.
//
// Usage: node scripts/scan.mjs [rootDir]

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(SELF), ".."));

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

// Each rule: { id, re, note }. Keep them narrow enough to be actionable.
const RULES = [
  // Allowed: RFC-reserved example domains, and vendor domains that appear in
  // redaction fixtures. Anything else that looks like an address is a hit.
  // Match every address, then allow only the ones that cannot belong to a real person:
  // RFC 2606/6761 reserved names, and the vendor domains that appear in fixtures.
  // Doing the allow-check in code rather than as a lookahead keeps it readable and
  // makes "why was this allowed" answerable by reading four lines.
  { id: "personal-email", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
    note: "an address that is not an RFC-reserved example name or a named vendor domain",
    allow: (m) => {
      const domain = m.split("@")[1].toLowerCase();
      if (/\.(example|test|invalid|localhost)$/.test(domain)) return true;      // RFC-reserved TLDs
      if (/^(.+\.)?example\.(com|org|net)$/.test(domain)) return true;          // RFC-reserved names
      return ["resend.com", "github.com", "anthropic.com"].some(
        (v) => domain === v || domain.endsWith("." + v));                       // vendors used in fixtures
    } },
  // AUTHORSHIP IS NOT A LEAK, but it is only authorship in two files. The copyright
  // line and the package metadata are supposed to name a human and a company; a name
  // appearing in source, comments, tests, the README, or the workflow is not.
  { id: "owner-name", re: /\bvik(?:rant)?\b/gi, note: "author's name outside the authorship files",
    exempt: ["LICENSE", "package.json"] },
  { id: "private-org", re: /viktorious/gi, note: "organisation name outside the authorship files",
    exempt: ["LICENSE", "package.json"] },
  { id: "private-repo", re: /NewJobAlertTool|\bNJAT\b/g, note: "private repository name" },
  { id: "private-domain", re: /newpmjobs/gi, note: "product domain" },
  // /home/runner is the GitHub Actions runner's own home and is legitimate here.
  { id: "windows-path", re: /[A-Z]:\\Users\\|Desktop[\\/]AI Projects|\/home\/(?!runner\b)[a-z]+\b/gi, note: "machine-specific path" },
  { id: "ruleset-id", re: /\b16381419\b/g, note: "GitHub ruleset id" },
  { id: "credential-shape", re: /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|sbp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
    note: "looks like a real credential" },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./g, note: "looks like a JWT" },
  // Unfilled placeholders. npm publish will happily ship these, and an MIT licence whose
  // copyright holder is a template string grants attribution to nobody. Blocking, so the
  // decision has to be made rather than remembered.
  { id: "unfilled-placeholder", re: /<(?:COPYRIGHT HOLDER|AUTHOR|OWNER|REPO)>/g,
    note: "a placeholder that must be filled in before publishing" },
];

// Advisory only: reported, never fatal. A ticket id from the origin repo resolves
// to nothing public and leaks nothing, and the comments that carry them are the
// design rationale. Strip them if you prefer a cleaner read; it is a cosmetic call.
const ADVISORY = [
  { id: "tracker-prefix", re: /\b[A-Z]{2,10}-\d+\b/g, note: "ticket id from the origin repo (advisory)" },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function scanFile(file, rules) {
  const base = path.basename(file);
  const hits = [];
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return hits; }
  const lines = text.split("\n");
  for (const rule of rules) {
    if (rule.exempt && rule.exempt.includes(base)) continue;
    for (let i = 0; i < lines.length; i++) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(lines[i])) !== null) {
        if (!(rule.allow && rule.allow(m[0]))) {
          hits.push({ file, line: i + 1, rule: rule.id, match: m[0], note: rule.note });
        }
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
      }
    }
  }
  return hits;
}

const files = walk(ROOT).filter((f) => f !== SELF);
const hits = files.flatMap((f) => scanFile(f, RULES));
const advisories = files.flatMap((f) => scanFile(f, ADVISORY));

function advisoryLine() {
  if (advisories.length === 0) return "";
  const byId = new Map();
  for (const a of advisories) byId.set(a.rule, (byId.get(a.rule) || 0) + 1);
  return [...byId].map(([id, n]) => `  advisory: ${n} × ${id}`).join("\n");
}

if (hits.length === 0) {
  console.log(`✓ deny-list scan clean over ${files.length} files in ${ROOT}`);
  const adv = advisoryLine();
  if (adv) console.log(adv);
  process.exit(0);
}

const byRule = new Map();
for (const h of hits) {
  if (!byRule.has(h.rule)) byRule.set(h.rule, []);
  byRule.get(h.rule).push(h);
}

console.log(`✖ ${hits.length} hit(s) across ${new Set(hits.map((h) => h.file)).size} file(s) in ${ROOT}\n`);
for (const [rule, list] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${rule}  (${list.length})  — ${list[0].note}`);
  const shown = list.slice(0, 12);
  for (const h of shown) {
    console.log(`    ${path.relative(ROOT, h.file)}:${h.line}  ${JSON.stringify(h.match).slice(0, 70)}`);
  }
  if (list.length > shown.length) console.log(`    … ${list.length - shown.length} more`);
  console.log("");
}
process.exit(1);
