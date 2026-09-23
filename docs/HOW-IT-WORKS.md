# How it works

This explains what happens when you hand this router a sentence describing a task, in plain language. No code reading required.

## The short version

You type a sentence describing what you want done. The router reads that sentence, checks it against a fixed list of rules in a fixed order, and stops at the first rule that matches. That rule decides which "lane" (which kind of model) does the work, and within the primary lane, which tier (how strong a model). The whole thing runs as text matching, with no model call involved in making that choice.

## The rule ladder

The router checks rules in this exact order and stops at the first match. Think of it as a list of questions asked one at a time:

- **R1, explicit override.** Did you name a specific model or lane yourself ("use opus", "ask gemini")? If so, and you did not also reject that same lane somewhere else in the sentence, that wins outright.
- **R2, consensus.** Did you ask for a second opinion or a gut check ("get consensus on this", "gut-check this plan")? If so, the task fans out to every lane that is currently usable, and the primary lane reconciles the answers.
- **R3, live fact.** Does the task ask about something that changes today (a rate, a price, the news, a score)? If so, it goes to the research lane, because no model's training data has today's number in it.
- **R3b, review.** Does the task read as a code, security, or spec review, and none of R1 through R3 already claimed it? If so, the primary lane does the work at whatever tier the escalation criteria below pick.
- **R4, large input.** Does the task mention a whole repository, a long document, or a large file? If so, it goes to a lane built for bigger inputs.
- **R5, everything else.** If nothing above matched, the task stays on the primary lane, at the cheapest tier that the wording justifies.

The review pass itself is decided separately, after one of the rules above has already picked a lane and tier. Any task that reads as a code, security, or spec review picks up a mandatory `reviewPass`, whichever rule assigned the work: naming a lane yourself ("use gemini to review this diff", R1) or asking for a second opinion (R2, consensus) still gets the independent pass on top of whatever that rule decided, not instead of it. R3b above is only what happens when a review task did not match any earlier rule. See `docs/REVIEW-PASS.md` for the full mechanics of when the pass attaches and how the reviewer is chosen.

## How the primary lane picks a tier

When a task lands on the primary lane (rule R5, or R1 naming the primary lane without a specific tier), the router still has to decide how strong a model to use. It checks a short list of escalation criteria, in this order, and uses the first one that fires:

- **E5-frontier**: the task calls for adversarial checking, a novel architecture, or multiple agents working together. Escalates to the top tier.
- **E4-blast-radius**: the task touches production, a migration, a force-push, or anything hard to undo. Escalates because the cost of a mistake is high, not because the task is intellectually hard.
- **E1-multi-file**: the task spans a whole codebase or multiple files at once.
- **E2-architecture-review**: the task is an architecture, design, code, or security review, or plain system design work.
- **E3-ambiguity**: the task itself says its requirements are unclear or open-ended.
- **E-trivial**: the task is a typo fix, a rename, a reformat, or another one-line mechanical change. Drops to the cheapest tier.
- **E0-default**: none of the above fired. This is the ordinary, single-feature, moderately scoped task, and it gets the standard tier.

## Three worked examples

These are real inputs, run through the actual CLI, not paraphrased.

**Example 1: a trivial edit.**

```
$ node bin/model-router.js "rename the heading in the team wiki note"
config: profile:anthropic
route: primary / light -> claude-haiku-4-5-20251001 (R5-primary-ladder, E-trivial)
```

Nothing here asks for a live fact, a review, or a large input, so R1 through R4 all pass without matching, and R5 takes over. Inside R5, the word "rename" matches the trivial pattern, so the tier drops to the cheapest one instead of the default standard tier. A rename is exactly the kind of task where a bigger model buys you nothing.

**Example 2: a live fact.**

```
$ node bin/model-router.js "what is the current 10-year treasury yield"
config: profile:anthropic
route: research / quick -> sonar (R3-live-web, quick-fact)
```

The phrase "current ... yield" matches the live-fact pattern, so R3 fires before the ladder even gets a chance to run. This routes to the research lane, which can actually look the number up, instead of a model that would otherwise have to guess or refuse. Because the sentence did not ask for deep, multi-source research, it lands on the quick tier rather than the deep one.

**Example 3: a code review.**

```
$ node bin/model-router.js "code review the scheduler changes"
config: profile:anthropic
route: primary / strong -> claude-opus-5-5 (R3b-review-primary, E2-architecture-review)
review pass: openai-codex / codex-cli-default; tie-break: google / gemini-3.1-pro-preview
```

The phrase "code review" matches the review pattern, and the word "code" itself is a strong enough signal that the task is genuinely about software (not, say, a real estate listing that happens to use the word "review"). That combination fires R3b: the primary lane still does the actual review work, at the strong tier because a review is architecture-review-shaped, but the decision also attaches a mandatory independent review pass from a different model, with a third model standing by to arbitrate any disagreement between the two.

## Overrides and negation

You can name a lane or model directly ("use opus", "ask gemini", "via perplexity"), and the router honors it as long as you did not also reject that same target somewhere in the same sentence. Rejection uses ordinary negative phrasing: "do not use gemini", "never ask codex", "avoid using perplexity", "without going through gemini".

A rejection is not local to the sentence it appears in. If you write "do not use gemini, summarize the entire repository," the summarization would normally route to the large-context lane (that is what R4 does with a whole-repo request), but because gemini was rejected earlier in the same task, R4 is barred from reaching it and the router falls back to the primary lane instead, with a note explaining why.

**Coordination lists.** A rejection can cover more than one name at once: "do not use codex or gemini" bars both the reviewer lane and the large-context lane, not just the first one named. The router also recognizes comma-separated lists ("do not use codex, gemini, or perplexity") and either/both phrasing ("do not use either codex or gemini").

**Why the grammar is asymmetric.** Hearing a rejection is treated as cheap: the router is generous about what counts as "don't use X," including loose phrasing like "we are not able to use gemini for this" or "we should not be trying to use gemini here." Recognizing an actual request is treated as expensive: the router is deliberately narrow about what counts as "use X," because inventing a request that was never made would route real work to a lane the user never asked for. A stray mention of a model's name in passing ("the problem with using gemini is the payload ceiling") creates no override in either direction, since there is no cue word attached to it at all. The asymmetry is deliberate: a missed rejection just means work goes somewhere the user didn't want; a fabricated request actually sends data or spend somewhere on a guess.

## Long task text is truncated first

Only the first 4000 characters of the task text are ever classified. Anything past that is dropped before any rule runs, and the decision's `notes` say the text was truncated. This is not about avoiding "reading" a long task, it just bounds the cost of running every regex in the ladder against a hostile or oversized input, and a routing decision only ever needs the gist of what the task is, not its entirety.

## How filenames are stripped before matching

Before any pattern runs, the router strips out anything that looks like a file path or filename. This matters because keyword matching would otherwise misread a filename as a signal about the task itself. "Fix the typo in production-deploy.go" is not actually a production deployment, it is a one-line fix to a file that happens to have "production" and "deploy" in its name. Without stripping, that sentence would wrongly escalate to a stronger tier.

The stripping is narrow on purpose. A single slash between two ordinary words ("and/or", "design/architecture") is left alone, because that is normal prose, not a path, and stripping it would silently delete real signal (a task that says "review the design/architecture of the intake flow" should still escalate as an architecture review). A token only gets stripped when it clearly looks like a path: it starts with a drive letter or a `./` or `~/` prefix, it has two or more path separators in a row, or it ends in a recognized file extension (`.js`, `.md`, `.py`, `.go`, and so on).
