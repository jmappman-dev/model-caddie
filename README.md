# model-caddie

**The right club for every shot, and an honest second read before you putt.**

A good caddie hands you the club the shot calls for, not the most expensive one in the bag, and tells you when to get a second read on the green. model-caddie does the same for AI work: it picks the cheapest model that can handle each task, sends it to the right kind of model, and requires a different model to check any code, security, or spec review.

A deterministic router that reads a plain-language task description and picks which model and lane should handle it (a light model for a typo fix, a research lane for a live fact, a large-context lane for a whole repo). It never calls a model to make that decision. Routing is a set of rules run over text, so it is free, instant, and the same input always produces the same output.

## Why deterministic

Most "smart routing" schemes call a model to decide which model to call, which adds latency, cost, and a second source of hallucination to every single dispatch. This router has no network call and no model call in its decision path. It compiles a config into a set of regular expressions once, then matches your task text against them. That gets you four things a model-based classifier cannot promise:

- **Free.** Classifying a task costs nothing beyond the classification code itself.
- **Instant.** Routing decisions run in well under a millisecond.
- **Reproducible.** The same task text, with the same config and the same environment variables set, always resolves to the same lane, tier, and model.
- **Auditable.** Every decision names the exact rule and criterion that fired, so a routing mistake can be traced back to a specific line of logic instead of an opaque model judgment.

## What sets it apart

**Capability lanes, not just a cheap-to-expensive ladder.** Most routers only escalate up a single ladder from a small model to a large one. This router also recognizes that some tasks need a different *kind* of capability, not just a bigger model. A question about a live fact (today's rate, the current price of something) goes to a research lane that can actually look it up, because no model's training data has today's number in it. A task that hands over an entire repository or a long document goes to a large-context lane sized for that kind of input. The primary ladder (light, standard, strong, frontier) still handles everything else.

**A built-in independent review pass.** It fires on two things, not one: when a task *asks* for a code, security, or spec review, and when a task *changes code* even though its text never says "review". That second trigger matters, because a bug fix or a new script produces exactly the code an outside pass exists for, and keying only on the word "review" left the requirement resting on whoever remembered it. The pass also carries a **scope**, `security` or `correctness`, because a correctness-scoped prompt reliably misses credential leakage, fail-open authorization and injection.

**How well does it actually decide?** Measured, not asserted, and the honest
answer is "usefully, not reliably".

On an externally authored 80-case challenge set that was not used for tuning, the
router detected **22 of 40** review-required tasks, 55% recall, and missed 18. Of
32 review requests it made, 22 were warranted, 69% precision. End to end, counting
both the request and the correct security-or-correctness scope, **16 of 40, 40%**.
A nominal 95% Wilson interval on that recall runs about 40% to 69%. These figures
describe this challenge set, not a representative production sample.

On the maintainer's own tuned corpus it scores 100%. The gap between those two
numbers is the most useful fact in this README.

Three separate blind sets each landed near 60 to 70% precision on first contact,
rose above 90% once they had been used to fix things, and were then replaced by a
fresh set that landed back near 60 to 70%. That is overfitting measured from the
outside. Treat the review pass as **a useful prompt, not a guarantee**: if a change
matters, require the outside review yourself rather than waiting to be told.

On the cleanest set the errors lean toward **missing** reviews (18) more than
over-requesting them (10), which is the direction that costs you something.
[docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) lists every failure class
with a worked example, including what it misses (symptom-only bug reports,
commit-style one-liners, change requests phrased as questions, infrastructure as
code) and what it over-requests. Reproduce any of it with `npm run eval` and
`node eval/evaluate.js --corpus=holdout3.json`.

**Independent means a different provider, not just a different model.** Two models from one vendor share training data, tooling and blind spots, so the router refuses a reviewer lane on the same provider as the lane doing the work, and asks for a manual second pass rather than reporting an independence it did not actually get.

When a task reads as code work, the router does not just pick a stronger model and call it done. It attaches a requirement that a second, different model review the same work independently, plus a tie-breaker lane to arbitrate any point where the two disagree. This requirement cannot silently vanish: if the configured reviewer is unavailable, the router falls back to a configured fallback lane; if every review lane is unavailable, it says so explicitly and tells you to run the second pass by hand. It never quietly returns a decision with no review pass on a review task.

**An append-only decision log with negation-aware overrides.** Every routed decision can be appended as one JSON line to a log file, naming the exact rule that fired (for example `R3-live-web` or `R3b-review-primary`) so routing behavior can be audited later. The override grammar understands rejection, not just requests: "don't use gemini" bars the large-context lane for every later rule in that same task, even a rule several steps down the ladder that would otherwise have reached for it.

## Quick start

```
git clone https://github.com/jmappman-dev/model-caddie.git
cd model-caddie
npm test
node bin/model-caddie.js "code review the scheduler changes"
node bin/model-caddie.js --check-config
```

## Example output

Running the CLI against the bundled default profile, with no config file and with `PERPLEXITY_API_KEY` and `GEMINI_API_KEY` set:

```
$ node bin/model-caddie.js "code review the scheduler changes"
config: profile:anthropic
route: primary / strong -> claude-opus-5-5 (R3b-review-primary, E2-architecture-review)
dispatch: anthropic claude-opus-5-5, in Claude Code use the Agent tool with the matching model override
review pass (correctness): openai-codex / codex-cli-default; tie-break: google / gemini-3.1-pro-preview
notes:
  - independent review pass required: openai-codex (reviewer lane) reviews the primary lane's work; where the two disagree, google (large-context lane) arbitrates that finding
```

A task that changes code requires the pass too, without ever using the word "review", and a task touching credentials draws the security scope:

```
$ node bin/model-caddie.js "add a backfill that authenticates with the service-role key and patches rows"
config: profile:anthropic
route: primary / standard -> claude-sonnet-5 (R5-primary-ladder, E0-default)
dispatch: anthropic claude-sonnet-5, in Claude Code use the Agent tool with the matching model override
review pass (security): openai-codex / codex-cli-default; tie-break: google / gemini-3.1-pro-preview
notes:
  - scope the reviewer's prompt as a SECURITY review, not correctness: credential leakage paths, trust boundaries on external input, authorization defaults and whether a missing policy fails open, blast radius, third-party trust chain
  - review pass required because the task CHANGES code, not because it asked for a review
```

```
$ node bin/model-caddie.js "what is the current 10-year treasury yield"
config: profile:anthropic
route: research / quick -> sonar (R3-live-web, quick-fact)
dispatch: perplexity: sonar
```

With no `PERPLEXITY_API_KEY` set, the second task stays on the primary lane instead, and says so:

```
$ node bin/model-caddie.js "what is the current 10-year treasury yield"
config: profile:anthropic
route: primary / standard -> claude-sonnet-5 (R3-live-unavailable, E0-default)
dispatch: anthropic claude-sonnet-5, in Claude Code use the Agent tool with the matching model override
notes:
  - live-fact task with the research lane unavailable: staying in the primary lane, so any figure here is unsourced and must be verified against its primary source before it is used as fact
```

The first task reads as a code review, so it stays on the primary lane's strong tier for the work itself and picks up a mandatory second-model review pass. The second task asks for a fact that changes daily, so it routes to the research lane instead of guessing from training data. The `config:` line always prints first on a non-JSON run, naming exactly which config decided the routing (a bundled profile, or a file path relative to the current directory).

## Provider profiles

Five profiles ship in `profiles/`. Each names which environment variable (never a value) a lane needs before the router treats it as available. The primary lane never requires an env var, so routing always works with zero keys set; it just falls back to the primary lane for anything an unavailable lane would otherwise have handled.

| Profile | Primary lane | Env vars a lane may need |
|---|---|---|
| `anthropic` (default) | Claude | `PERPLEXITY_API_KEY` (research), `GEMINI_API_KEY` (large-context); reviewer needs none, it shells out to the Codex CLI |
| `openai` | OpenAI | `PERPLEXITY_API_KEY` (research), `GEMINI_API_KEY` (large-context), `ANTHROPIC_API_KEY` (reviewer) |
| `google` | Gemini | `PERPLEXITY_API_KEY` (research), `ANTHROPIC_API_KEY` (reviewer); no separate large-context lane, since the primary lane already is Gemini |
| `ollama` | A local Ollama model | none; everything runs locally, no keys and no data leaves the machine |
| `claude-code-only` | Claude | none; single-provider setup, review pass asks for a manual second pass since no other lane exists |

Select a profile with `--profile <name>`, or point at your own config with `--config <path>` or the `MODEL_CADDIE_CONFIG` environment variable. See `docs/CONFIGURATION.md` for the full reference.

## Configs from other people

A `model-caddie.config.json` file sitting in the current working directory is picked up automatically, with no flag needed, ahead of the bundled default profile. That config decides where the decision log is written and which words count as overrides ("use opus", "ask gemini"). Read a config before you run it, the same as you would a script you did not write. The CLI always tells you which config it used: the first line of every non-JSON run starts with `config: <source>`, and `--json` output carries the same value in its `source` field, reported relative to the current directory.

## Use it with Claude Code

A ready-made skill lives in `skill/SKILL.md`. Copy that folder into `~/.claude/skills/model-caddie` and edit the path inside it to point at wherever you cloned this repository. Claude Code will then route through the CLI whenever a task matches the skill's trigger.

## Use it with any other agent

This is a plain CLI and a zero-dependency ES module. Any agent framework that can run a shell command can call it directly:

```
node /path/to/model-caddie/bin/model-caddie.js "summarize the entire repo" --json
```

Or import the router straight into JavaScript and skip the CLI entirely:

```js
import { route } from './src/router.js';

const decision = route('refactor error handling across the codebase');
console.log(decision.lane, decision.tier, decision.model);
```

Nothing here has been tested against Cursor, Codex, or the Gemini CLI specifically. It should work anywhere a shell command or an ES module import works, but that has not been verified against those tools.

## Limitations

- **Keyword heuristics can misroute.** The classifier matches phrases, not meaning. A task worded unusually can land on the wrong lane or tier. Read the `notes` and `rule` fields on any decision you are unsure about.
- **English-only grammar.** The negation and override grammar (`do not use X`, `ask Y instead`) is written for English phrasing only.
- **Known gaps and trade-offs are pinned in the test suite.** `test/routing.test.js` documents a few deliberate edge cases rather than hiding them:
  - **KNOWN GAP:** a rejection that names a lane with no verb at all ("no gemini, summarize the repo") is invisible to the override parser and does not bar that lane.
  - **KNOWN LIMIT:** the negation window around a prepositional phrase ("do not send it through gemini") over-reaches rather than under-reaches by design, so an ambiguous sentence structure can decline a lane it did not intend to.
  - **ACCEPTED TRADE-OFF:** if the same lane is both requested and rejected in one task (even when one mention is clearly descriptive, not an instruction), the router refuses the override entirely rather than guessing which mention wins.
- **Model IDs go stale.** Every bundled profile's model IDs were checked against that provider's own docs on the date noted in its `_about` field. Providers rename and retire models often; verify the IDs in `profiles/*.json` before relying on them.
- **The router picks a model. It does not call one.** Dispatching the chosen model, provider, or CLI to actually do the work is left to whatever is calling this router.
- **Very long task text is truncated before classification.** Only the first 4000 characters of the task text are matched against the rules; anything past that is ignored, and the decision's `notes` say so. Routing needs the gist of a task, not the whole thing, and the cap also bounds how expensive a hostile or oversized input can get.

## License

MIT.
