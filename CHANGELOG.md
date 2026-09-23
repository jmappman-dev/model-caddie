# Changelog

## 0.1.0 (2026-09-22)

First public release.

- Deterministic rule ladder (R1 override, R2 consensus, R3 live fact, R3b review, R4 large input, R5 tier ladder), no model call needed to pick a model.
- Capability lanes: primary, research, large-context, reviewer.
- Independent review pass on code, security, and spec reviews, with a configurable reviewer, tie-breaker, and fallback. With no second model available it asks for a manual second pass instead of disappearing.
- Negation-aware overrides: "don't use X" bars that lane for every later rule.
- Provider-agnostic JSON config with bundled profiles: anthropic, openai, google, ollama, claude-code-only.
- Lanes that need an API key fall back to the primary lane, naming the missing env var, when the key is not set.
- Append-only JSONL decision log, with an option to keep task text out of it.
- Hardened before release after an independent Codex review and a security review: the log is confined to a .jsonl file inside the working directory (symlinks included) and never appends to a non-log file; task text is left out of the log by default and always when it looks sensitive; provider, model, and dispatch strings cannot carry shell syntax or control characters; long or hostile task text is capped at 4000 characters and every pattern runs in linear time; unknown CLI flags are errors; the CLI names the config it used on every run.
