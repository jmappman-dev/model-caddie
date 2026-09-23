// Filename and path stripping, shared by the router (before matching) and the
// config validator (so no alias is accepted that stripping would erase).
//
// Keyword matchers misread words inside filenames as task signals ("fix the
// typo in production-deploy.go" is not a production deploy). Path-like tokens
// only: a single slash between plain words ("and/or", "design/architecture") is
// prose and keeps its signal. A slash token is stripped only when it is prefixed
// like a path, has 2+ separators, or ends in a file extension. The lookbehinds
// let a match start only at the beginning of a token, which keeps every pattern
// linear on long runs of word characters.

// Executable source only. Data, config and markup extensions (json, yml, ini,
// cfg, html, css) are deliberately EXCLUDED: a Codex pass showed they made
// data exports and translation copy read as code work ("export billing records
// to invoices.json", "fix the spelling in translations.yml"). When editing a
// config file really is code work the task almost always carries a code signal
// of its own ("fix the schema in config.json"), which is matched separately.
const SOURCE_EXT = 'js|mjs|cjs|ts|tsx|jsx|py|ps1|psm1|sh|bash|bat|sql|go|rs|rb|java|c|cpp|cc|h|hpp|cs|php|swift|kt|scala|lua|vue|svelte|gradle';

// Extensions that stripFilenames removes: every source extension above, plus the
// prose, data and config ones that are not code. These MUST stay a superset of
// SOURCE_EXT. When they drifted apart, a newly recognised source extension was
// detected by hasSourceFile but NOT stripped, so its filename words leaked into
// lane and tier selection: "fix the bug in latest.jsx" routed to the research
// lane because "latest" survived as a live-fact signal.
const STRIP_EXT = `${SOURCE_EXT}|json|jsonl|md|txt|csv|html|css|scss|yml|yaml|toml|ini|cfg|pdf|xlsx|docx|log|env`;

// The trailing guard must reject a FURTHER extension segment ("retry.js.md" is
// Markdown, not JavaScript) while still accepting ordinary sentence punctuation.
// A blanket (?![\w.-]) did the first and broke the second: "Implement the retry
// backoff in worker.ts." stopped being recognised as source because of the full
// stop, which a blind holdout set exposed as 8 false negatives in one slice.
// W is a Unicode-aware stand-in for \w. Plain \w is ASCII, so a source file
// named in any non-Latin script was invisible to this check and the task
// required no review at all. That failed in the DANGEROUS direction, unlike the
// rest of this file's errors, which is why it is worth the extra complexity.
// Character-class CONTENTS, without brackets, so it can be interpolated inside
// a class as [${W}.-] and outside one as [${W}].
const W = String.raw`\p{L}\p{N}_`;

const SOURCE_FILE_RX = new RegExp(String.raw`(?<![${W}.-])[${W}-]+(?:\.[${W}-]+)*\.(?:${SOURCE_EXT})(?![${W}-])(?!\.[${W}])`, 'iu');

// A conventional source directory. The leaf is captured so its extension can be
// checked: "src/README.md" is a prose file that happens to live in src, and the
// earlier version accepted any leaf at all.
const SOURCE_DIR_RX = new RegExp(
  String.raw`(?<![${W}.-])(?:src|lib|bin|tests?|spec|app|pkg|cmd|internal|scripts?|components?|modules?|packages?)[\\/](?:[${W}.-]+[\\/])*([${W}.-]+)(?![${W}.-])`,
  'iu',
);

const SOURCE_EXT_ONLY_RX = new RegExp(String.raw`\.(?:${SOURCE_EXT})$`, 'i');

// Does the task name an actual source file or a source directory path?
//
// This must run on the RAW text, BEFORE stripFilenames, which is the entire
// point: stripping removes the path and extension that prove a task is code
// work, and no keyword list can recover it afterwards. "fix the bug in
// src/retry.js" had no surviving code signal once stripped, so it required no
// review pass at all, a worse failure than the false positives that keyword
// tightening was meant to solve.
export function hasSourceFile(text) {
  const t = String(text ?? '');
  if (SOURCE_FILE_RX.test(t)) return true;
  // EVERY source-directory candidate, not just the first. Checking only one let
  // an excluded prose path mask a valid one after it: "fix the bug in
  // src/README.md and lib/backoff" read as not-source because src/README.md
  // matched first and was correctly rejected, ending the check.
  // Flags must include 'u', or the \p{...} classes in the source silently stop
  // meaning anything and every non-ASCII path stops matching.
  const rx = new RegExp(SOURCE_DIR_RX.source, 'giu');
  for (const m of t.matchAll(rx)) {
    const leaf = m[1] || '';
    // An extensionless leaf is a directory or a module path, which counts. A
    // leaf WITH an extension only counts when that extension is a source one.
    if (!leaf.includes('.') || SOURCE_EXT_ONLY_RX.test(leaf)) return true;
  }
  return false;
}

const STRIP_FILE_RX = new RegExp(String.raw`(?<![\w.-])[\w-]+(?:\.[\w-]+)*\.(?:${STRIP_EXT})\b`, 'gi');

// High-risk surfaces, matched by PATH and FILENAME only.
//
// Why this exists. The text classifier misses a large share of review-worthy
// tasks on a blind set, and the misses are dominated by phrasing it has never
// seen. A path is a far stronger and far more stable signal than prose:
// "migrations/002_add_users.sql" means the same thing however the sentence
// around it is worded, and it survives paraphrase, terse tickets and complaints.
//
// THE DESIGN RULE. Match paths and filenames, NEVER bare prose words. "the auth
// migration milestone" is a project-management sentence and must not fire.
// "src/auth/session.ts" is a risk surface and must. The moment this matcher
// starts firing on bare words it has become the same fragile text classifier it
// exists to bypass, and it will fire on release notes and meeting agendas.
// Every pattern below therefore requires a path separator, a file extension, or
// a known exact filename.
const SEP = String.raw`[\\/]`;
// A risk token may start at the beginning of the text, after whitespace or an
// opening quote or bracket, OR after a path separator. Omitting the separator
// meant "app/middleware/auth.js", "infra/main.tf" and "config/credentials.yml"
// never matched, because the risk token was the basename rather than a directory.
const B = String.raw`(?:^|[\s"'(\[]|[\\/])`;
const RISK_SURFACES = [
  ['database migration', new RegExp(String.raw`${B}(?:[\w.-]+${SEP})*(?:migrations?|migrate|alembic|flyway|liquibase)${SEP}[\w.-]+`, 'i')],
  // Directory form ONLY. A bare "auth.ts" or "session.js" is dropped on purpose:
  // filenames appear inside ordinary prose all the time ("the essay Who owns
  // auth.py?", "the vendor called the line item auth.ts migration"), and a blind
  // set showed every one of those firing. Requiring a separator keeps the stated
  // design rule honest, that this matches PATHS and not prose.
  // Two accepted forms, both requiring a real path. Either the risk word is a
  // DIRECTORY ("src/auth/session.ts"), or it is a filename WITH a path prefix
  // ("app/middleware/auth.js"). A bare "auth.ts" with no prefix is rejected,
  // because filenames appear inside ordinary prose constantly ("the essay Who
  // owns auth.py?", "the vendor called the line item auth.ts migration") and a
  // blind set showed every one of those firing.
  ['authentication or authorization', new RegExp(
    String.raw`${B}(?:[\w.-]+${SEP})*(?:auth|authn|authz|authentication|authorization|session|sessions|login|oauth|jwt|rbac|acl|permissions?)${SEP}[\w.-]+`
    + String.raw`|${B}(?:[\w.-]+${SEP})+(?:auth|authn|authz|authentication|authorization|session|login|oauth|jwt|rbac|acl)\.[a-z0-9]{1,5}\b`,
    'i')],
  ['dependency manifest', new RegExp(String.raw`${B}(?:package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Pipfile(?:\.lock)?|poetry\.lock|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|composer\.(?:json|lock))\b`, 'i')],
  ['CI or deployment pipeline', new RegExp(String.raw`${B}(?:\.github${SEP}workflows|\.gitlab-ci\.yml|\.circleci|azure-pipelines\.yml|Jenkinsfile|\.buildkite)`, 'i')],
  // A bare "main.tf" is dropped for the same reason as bare auth filenames: it
  // appeared inside a request to summarise a migration diary. Terraform files
  // still match through their directory form, or as an explicit .tfvars.
  ['container or infrastructure definition', new RegExp(String.raw`${B}(?:Dockerfile|docker-compose[\w.-]*\.ya?ml|(?:[\w.-]+${SEP})+[\w.-]+\.tf|[\w.-]+\.tfvars|(?:terraform|k8s|kubernetes|helm|charts)${SEP}[\w.-]+|nginx\.conf|[\w.-]*\.nomad)\b`, 'i')],
  ['secret or credential store', new RegExp(String.raw`${B}(?:\.env(?:\.[\w-]+)?|(?:secrets?|credentials?|keystore|vault)${SEP}[\w.-]+|credentials\.(?:yml|yaml|json)|[\w.-]*\.(?:pem|p12|pfx|jks|keystore))\b`, 'i')],
];

// Surfaces where the SCOPE is inherently security, because the surface itself
// concerns access, secrets, stored data or the supply chain. The others force a
// review but let the scope be judged from the text: reshuffling CI jobs in a
// workflow file is a correctness change, and pinning every surface to security
// measurably cost scope accuracy on a blind set.
const ALWAYS_SECURITY = new Set([
  'authentication or authorization',
  'secret or credential store',
  'dependency manifest',
  'database migration',
]);

export function riskSurfaceIsSecurity(name) {
  return ALWAYS_SECURITY.has(name);
}

// Returns the NAME of the matched surface, or null. The name goes into the
// decision's notes so a forced review can be traced to the thing that forced it.
export function riskSurface(text) {
  const t = String(text ?? '');
  for (const [name, rx] of RISK_SURFACES) if (rx.test(t)) return name;
  return null;
}

export function stripFilenames(text) {
  return text
    .replace(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/])[\w\\/.-]*/g, ' ')
    .replace(/(?<![\w.-])[\w.-]+(?:[\\/][\w.-]+){2,}\b/g, ' ')
    .replace(/(?<![\w.-])[\w.-]+[\\/][\w.-]+\.[a-z0-9]{1,5}\b/gi, ' ')
    .replace(STRIP_FILE_RX, ' ')
    .replace(/\s+/g, ' ');
}
