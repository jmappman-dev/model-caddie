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

export function stripFilenames(text) {
  return text
    .replace(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/])[\w\\/.-]*/g, ' ')
    .replace(/(?<![\w.-])[\w.-]+(?:[\\/][\w.-]+){2,}\b/g, ' ')
    .replace(/(?<![\w.-])[\w.-]+[\\/][\w.-]+\.[a-z0-9]{1,5}\b/gi, ' ')
    .replace(/(?<![\w.-])[\w-]+(?:\.[\w-]+)*\.(?:js|mjs|cjs|ts|tsx|json|jsonl|md|txt|csv|html|css|py|ps1|psm1|yml|yaml|sql|pdf|xlsx|docx|log|env|toml|sh|bat|go|rs|rb|java|c|cpp|h|cs|php|swift|kt)\b/gi, ' ')
    .replace(/\s+/g, ' ');
}
