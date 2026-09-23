# Configuration reference

This documents the config shape as enforced by `validateConfig` in `src/config.js`. Anything not described here either has a default applied by that function or is rejected outright with a `ConfigError`.

## Top level

A config is a plain JSON object with these top-level keys: `lanes` (required), `aliases`, `review`, `signals`, `log`. `name` and `_about` are conventional metadata fields the bundled profiles use for documentation; the validator does not require or inspect them.

## Lanes

`lanes` is an object whose keys must be drawn from exactly four lane ids: `primary`, `research`, `large-context`, `reviewer`. Any other key is rejected as an unknown lane.

The `primary` lane is required. It is always available: `validateConfig` refuses a config where `lanes.primary.enabled` is `false`, and it refuses a `primary` lane with a non-empty `requiresEnv`. This is enforced, not a convention, because every rule in the router ultimately falls back to the primary lane when something else is unavailable; if the primary lane itself could be unreachable, that fallback would have nothing to land on.

Every lane, including `primary`, must have:

- **`provider`** (string, required): a label naming who serves this lane. It shows up in dispatch strings and in the review pass's descriptions of who reviewed what. It is not checked against a fixed list of providers, but it is restricted to a plain character set (letters, digits, `. : / @ + - _`, starting with a letter or digit, max 80 characters) because it reaches stdout and the calling agent verbatim; spaces, quotes, and shell metacharacters are rejected.
- **`models`** (object, required): one entry per tier this lane supports. The primary lane needs all four: `light`, `standard`, `strong`, `frontier`. `research` needs `quick` and `deep`. `large-context` needs `fast` and `reasoning`. `reviewer` needs `review`. A missing tier, or a tier name outside that lane's fixed set, is rejected. Each model ID is restricted to the same plain character set as `provider`, for the same reason.
- **`requiresEnv`** (array of strings): the environment variable **names** (never values) that must be set and non-empty before this lane counts as available. Each name must look like a shell environment variable (uppercase letters, digits, and underscores, starting with a letter or underscore). Putting an actual key value here, instead of the variable's name, is rejected. It defaults to `[]` only for the `primary` lane. Every other lane must list `requiresEnv` explicitly, even if the list is empty (an empty list is how you tell the validator a lane genuinely needs no key, for example a CLI that handles its own login); leaving it out entirely is rejected. `--check-config` reports a lane with an explicit empty list as "assumed available (no env check)" rather than "available", so it stays visually distinct from a lane whose keys were actually checked.
- **`enabled`** (boolean, optional, defaults to `true`): set to `false` to turn a lane off entirely, as if it were never configured. A non-boolean value (`"false"`, `0`, and so on) is rejected rather than coerced.
- **`dispatch`** (string, optional): display text describing how to invoke this lane once the router has picked it. See placeholders below. If omitted, it defaults to `"{provider}: {model}"`. It must be a single line, at most 300 characters, using only letters, digits, spaces, and `. , : ' / @ + _ -`, plus the four placeholders. Quotes, backslashes, dollar signs, backticks, semicolons, pipes, ampersands, angle brackets, parentheses, and any other braces are rejected, because agents read this line and may act on it, so it must not be able to carry shell syntax (PowerShell, for one, evaluates a parenthesized command).

### Dispatch template placeholders

A lane's `dispatch` string may use any of these placeholders, substituted at decision time:

- `{provider}`: the lane's `provider` value
- `{model}`: the specific model id chosen for the resolved tier
- `{tier}`: the tier name that was resolved (`light`, `quick`, `fast`, `review`, and so on)
- `{lane}`: the lane id itself (`primary`, `research`, `large-context`, `reviewer`)

For example, the bundled `anthropic` profile's primary lane uses `"{provider} {model}, in Claude Code use the Agent tool with the matching model override"` to remind whoever reads a decision how to actually dispatch it inside that specific tool.

## Aliases

`aliases` is an optional object (defaults to `{}`) mapping a word a user might type to a lane or a specific primary tier. Each key must be a lowercase word of letters, digits, `.`, `+`, or `-`, at most 40 characters, and must start and end with a letter or digit (a trailing or leading `.`, `+`, or `-` is rejected, so the word-boundary anchors the override grammar relies on can always match it). An alias that looks like a filename (`notes.md`, `a.js`) is also rejected, because filenames are removed from task text before matching and such an alias could never be heard. Version-style aliases such as `gpt-4.1` are fine. Each value must be either a bare lane id (`"research"`, `"large-context"`, `"reviewer"`, or `"primary"`) or `"primary:<tier>"` naming one of the four primary tiers (for example `"primary:strong"`). Only the primary lane has named tiers; writing `"research:quick"` as an alias target is rejected. An alias pointing at a lane that is not configured at all is also rejected.

These are the words the override grammar recognizes in a task description ("use opus", "ask gemini"). The bundled `anthropic` profile aliases `claude` to the bare primary lane, `haiku`/`sonnet`/`opus`/`fable` to the four primary tiers, and `perplexity`/`gemini`/`codex` to the three outside lanes.

## Review

`review` is an optional object (defaults to `{}`, then filled with defaults). Its fields:

- **`enabled`** (boolean, defaults to `true`): turns the entire review-pass mechanism on or off. When `false`, no task ever gets a `reviewPass`, even a genuine code review. A non-boolean value is rejected rather than coerced.
- **`reviewer`**: the lane that reviews the primary lane's work on a review-shaped task. Must be `null` or one of the three non-primary lane ids (`research`, `large-context`, `reviewer`). The primary lane cannot review itself.
- **`tieBreaker`**: the lane that arbitrates when the reviewer and something else disagree. Same constraint as `reviewer`.
- **`fallback`**: the lane to try if `reviewer` turns out to be declined or unavailable at routing time. Same constraint as `reviewer`.

All three default to `null` if omitted, which is a valid, fully-supported configuration: it means a review-shaped task still gets flagged as needing a second pass, but the router tells you no automated second model is configured and to run that pass by hand. See `docs/REVIEW-PASS.md` for exactly how these three fields interact at routing time.

## Signals

`signals` is an optional object, merged over these defaults:

```json
{
  "sensitiveTerms": ["client", "clients", "customer", "customers", "patient", "patients", "contract", "contracts"],
  "contentTerms": ["newsletter", "blog", "caption", "copy", "brochure", "flyer", "invitation", "press release", "listing", "listings", "marketing email", "contract", "disclosure"]
}
```

Both `sensitiveTerms` and `contentTerms` must be arrays of plain words or short phrases (letters, digits, spaces, `.`, `+`, `'`, `-`, at most 60 characters each). `sensitiveTerms` drives an advisory-only note when a task mentions client, customer, or patient data (plus email-address and phone-number patterns); it never changes routing. `contentTerms` feeds the review pass's content guard, which keeps ordinary content-review tasks ("review the listing copy") from being mistaken for a code review just because the word "review" appears.

## Log

`log` is an optional object, merged over `{ path: '.model-router/decisions.jsonl', taskText: 'omit' }`:

- **`path`** (string): where `--log` appends decisions, resolved relative to the current working directory. It must be a relative path with no control characters, must stay inside the working directory (no `..` segment, and not absolute on POSIX or Windows), and must end in `.jsonl`. This is enforced so a config from someone else can never point the log at a file outside the project, such as a shell profile. `appendLog` (in `src/log.js`) enforces the same working-directory confinement again at write time, independent of config validation, and additionally refuses to append to a file that already exists but is not itself a JSONL log (its first line does not parse as JSON), so a mistaken or malicious path can never add lines to an existing script.
- **`taskText`**: either `"omit"` (the default: the task text is left out of the log entirely, as `null`) or `"truncate"` (opt in: the logged task text is cut to 140 characters plus an ellipsis). Any other value is rejected. Either way, the task text is also dropped and replaced with `null` (with `taskRedacted: true` on the entry) whenever the router's own sensitive-data signal fires on that task, regardless of which `taskText` mode is configured; `"truncate"` only controls what happens on an ordinary, non-sensitive task.

## Config resolution order

`resolveConfig` (in `src/config.js`) picks a config source in this order, using the first one that applies:

1. An explicit `--config <path>` flag.
2. The `MODEL_ROUTER_CONFIG` environment variable, treated as a path.
3. A `model-router.config.json` file in the current working directory, if one exists.
4. A bundled profile, chosen by `--profile <name>` or defaulting to `anthropic` if no flag is given.

Whichever source wins, the raw JSON is then run through `validateConfig`, which fills in the defaults described above and rejects anything malformed with a `ConfigError` naming exactly what is wrong.

If the config file itself is not valid JSON, the error reports only the character position of the parse failure (for example "error near character 42"), never the file's content. This is deliberate: `--config` can be pointed at the wrong file by mistake, and that file might hold something like an API key or token rather than a router config, so the error path is not allowed to echo any of it back.

## Writing your own profile

A minimal profile only needs a `primary` lane:

```json
{
  "name": "my-profile",
  "lanes": {
    "primary": {
      "provider": "my-provider",
      "models": {
        "light": "small-model-id",
        "standard": "medium-model-id",
        "strong": "large-model-id",
        "frontier": "large-model-id"
      }
    }
  }
}
```

This alone validates and routes every task; every rule that would reach for research, large-context, or reviewer lanes simply falls back to the primary lane, because those lanes are not configured at all. From there, add the lanes you actually have access to, one at a time:

- Add a `research` lane with `requiresEnv` naming the API key it needs, and give it `quick` and `deep` models.
- Add a `large-context` lane the same way, with `fast` and `reasoning` models.
- Add a `reviewer` lane, then set `review.reviewer` to point at it so review-shaped tasks pick up an independent pass.
- Add aliases for any of these so a task can name them directly ("use gemini").

Run `node bin/model-router.js --check-config --config ./my-profile.json` after each addition to confirm the lane validates and to see whether it currently resolves as available given your actual environment variables.

## How lanes become unavailable, and what routing does then

A configured lane can still fail to be usable at routing time, for three separate reasons: it is `enabled: false`, one of its `requiresEnv` variables is missing or empty in the current environment, or the task itself declined it by name (see the negation grammar in `docs/HOW-IT-WORKS.md`).

Whenever a rule would have routed to a lane that turns out unavailable for any of these reasons, the router does not error out. It falls back to the primary lane, resolves a tier for the task as if the ladder rules applied normally, and adds a note explaining which lane was skipped and why (naming the missing environment variable, if that was the reason, but never its value). A consensus fan-out (R2) drops each unavailable leg individually rather than failing the whole request, and the review pass falls back through `reviewer` then `fallback` before finally admitting no second model is available.
