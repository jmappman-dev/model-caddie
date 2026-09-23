# The review pass, in depth

The review pass is the mechanism that attaches a mandatory independent second opinion to work that needs one. This document covers exactly when it fires, how the reviewer is chosen, how the tie-breaker works, and how to act on the result. The logic lives in `reviewPassFor`, `isCodeReview` and `isCodeMutating` in `src/router.js`, plus `hasSourceFile` and `riskSurface` in `src/strip.js`.

**Read [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) before relying on this.** On a clean blind set the decision scores 68.8% precision and 55.0% recall, and it misses more reviews than it over-requests. It is a useful prompt, not a guarantee.

## When it fires

The review pass is decided after the rule ladder has already picked a lane and tier for the task, not as one more rule competing for the same slot. That means it attaches on top of whichever rule actually fired: an explicit override ("use gemini to review this diff", R1) or a consensus fan-out (R2, "get a second opinion on this code review") still carries a `reviewPass`, exactly as a plain R3b match would. R3b in `docs/HOW-IT-WORKS.md` is only what happens when a review task did not match any earlier rule; it is not the only way a task ends up with a `reviewPass`. The one exception is the research lane: a task that landed on the research lane only counts as a code review if it also carries an explicit `codeSignal` word, so an ordinary live-fact question is never retroactively treated as a review.

There are THREE independent triggers. Any one of them is enough.

### Trigger 1: the task names a high-risk PATH (forced, cannot be overridden)

If the task names a migration, an auth or session module, a dependency manifest or lockfile, a CI pipeline, a container or infrastructure definition, or a secret store, the pass is FORCED and nothing in the scoring can remove it. A trivial word cannot exempt it, a content word cannot, and no verb is needed at all, so a terse ticket like `package-lock.json, 40 transitive bumps` still gets reviewed. The decision's notes name which surface forced it.

A path survives paraphrase in a way prose does not: `migrations/002_add_users.sql` means the same thing however the sentence around it is worded. That is the entire reason this trigger exists.

The matcher requires a REAL PATH, never a bare prose word or a bare filename: the risk word as a directory (`src/auth/session.ts`), or a filename with a path prefix (`app/middleware/auth.js`). A bare `auth.ts` is rejected, because filenames appear inside ordinary prose constantly. An earlier version accepted them and a blind set caught it firing on an essay title.

The one exemption is an explicit read-only statement ("do not change anything", "read-only"), because reading a migration is not modifying one.

Scope is pinned to `security` for surfaces inherently about access, secrets, stored data or the supply chain (auth, credential stores, dependency manifests, migrations). CI and infrastructure surfaces force the pass but let the scope be judged from the text, because reshuffling CI jobs is a correctness change.

### Trigger 2: the task CHANGES code

A task that mutates code needs the outside pass whether or not it uses the word "review": a bug fix or a new script is exactly the code such a pass exists for. Detection needs a mutation verb (or a named source file, since real tickets are often noun phrases with no verb at all) plus evidence the task is code work: a code signal, a code-work term that survives filename stripping such as `TDD` or `traceback`, or a named source file. Security vocabulary sets the SCOPE but is not by itself evidence that something is code, which is why "create an invoice for the customer" requires nothing.

A trivial mechanical edit (typo, rename, reformat) suppresses this trigger unless there is other real code evidence, and a NEGATED trivial word does not count: "fix the bug in src/retry.js; do not rename anything" is substantive work that merely forbids a trivial action.

### Trigger 3: the task ASKS for a review

Two conditions both have to hold for this one.

**First, the `reviewPass` regex has to match.** This pattern looks for phrases like "code review", "security review", "spec review", "design review", "diff review", "pr review", "patch review", "build-spec review", or a "review this/the/my/these code/diff/pr/patch/implementation/spec/changes" phrasing, plus a narrower set for reviewing "the security", "correctness", "error handling", or "authentication"/"authorization" of something.

**Second, the code-signal-versus-content-guard check has to resolve in favor of it being a real code review.** The word "review" alone is not enough: a huge amount of ordinary business content is named after code-shaped nouns without being code at all (a listing generator, a contract parser, a disclosure automation service are all names real estate or legal software might use, and they all contain words that could look like code terms out of context). So the router checks two more things:

- **`codeSignal`**: does the task also contain an unambiguous code word (`code`, `implementation`, `endpoint`, `api`, `script`, `parser`, `handler`, `module`, `schema`, `migration`, `repo`, `regex`, `pipeline`, and others)? The authoritative list is `RX.codeSignal` in `src/router.js`; it is deliberately not enumerated in full here, because an enumerated copy drifts out of date the first time a word is added.
- **`contentRx`**: does the task instead contain a content word from the configured `signals.contentTerms` list (`newsletter`, `blog`, `caption`, `brochure`, `flyer`, `invitation`, `listing`, `marketing email`, and so on)?

The logic is: **a code signal always wins.** If both a code word and a content word are present, or if a code word is present with no content word, it counts as a real review. Only when there is a content word and no code word at all does the content guard suppress the review pass. That asymmetry is deliberate: dropping a genuine code review because a client name or a business term happened to sit next to it is the dangerous failure mode, so the check is biased toward keeping the review pass rather than toward avoiding a false positive on ordinary content work.

Examples the test suite pins down: "Security review the listing generator code" gets a review pass, because "code" is present even though "listing" is too. "Review the security of the product description in the listing copy" does not, because there is no code word at all, only content words.

## Reviewer selection order

Once a task is confirmed to be a review, the router picks who does the independent check, using the `review` section of the active config (`reviewer`, `tieBreaker`, `fallback`; see `docs/CONFIGURATION.md`).

1. Try `review.reviewer`. It is usable only if the task did not decline that lane by name, the lane itself is enabled with every `requiresEnv` variable set, and it does not share a VENDOR ROOT with a lane already committed to this review (two models from one vendor share training data, tooling and blind spots, so `openai` cannot review `openai-codex`; the root is the label up to the first `-`, `_`, `/`, `:` or `.`, and `docs/CONFIGURATION.md` covers the one direction that deliberately over-matches) (the lane doing the work itself is always excluded; for a consensus review, every lane that is already a consensus leg is excluded, so a consensus that used every configured lane ends with no reviewer and asks for a manual second pass). If usable, it becomes the reviewer.
2. If not, and `review.fallback` is configured, is different from `review.reviewer`, and is itself usable by the same test, it becomes the reviewer instead. A note records that the fallback was used and why.
3. If neither is usable, the reviewer is `null`, and the task's `reviewPass.required` stays `true` but names no automated second model. A note tells you to run the second pass by hand or with a different model.

The tie-breaker is chosen independently, after the reviewer: `review.tieBreaker` is used only if it is configured, different from whichever lane ended up as the reviewer, and itself usable (not declined, enabled, all required env vars present, and not sharing a vendor root with the reviewer or the executing lane). A fallback lane that is already serving as the reviewer never also serves as its own tie-breaker.

This selection always skips, rather than fails on, any of these reasons: the lane the task doing the work itself (a lane can never review itself), a lane the task explicitly declined ("do not use codex"), a lane the environment cannot currently reach (a missing API key), or a lane that resolves to the exact same `provider`/model pair as a lane already committed to this review. That last check matters in small configs where two lane ids might legitimately point at the same underlying model; without it, a "review" could end up being the same model checking its own work under a different lane name. Each skip is recorded in `reviewPass.skipped` with the lane and the reason, so the decision is fully auditable even when it falls all the way through to "no second model available."

## Why the requirement never silently disappears

If `review.enabled` is `false` in the config, or the task simply is not a review, `reviewPassFor` returns `null` and there is no review pass, which is correct: nothing was owed. But once a task is confirmed to be a review, the requirement itself is unconditional. Every branch of the selection logic above (reviewer found, fallback found, neither found) still returns an object with `required: true`. The only thing that changes across those branches is whether `reviewer` is a real lane or `null`, and whether the accompanying note says who is reviewing or says to do it by hand. There is no code path where a genuine review task quietly comes back with no `reviewPass` at all because a lane happened to be unavailable.

## The tie-breaker

The tie-breaker exists because two independent reviewers can disagree, and someone has to decide which finding stands. It is a separate lane from the reviewer, chosen by the same availability rules, and it only ever arbitrates findings the reviewer and the primary lane's own review disagree on. It is never a required participant; a review pass with `reviewer` set but `tieBreaker: null` is fully valid and simply means disagreements get settled by hand.

## The four-step protocol

Every `reviewPass` object (when `required` is `true`) carries a `protocol` array describing the sequence to actually follow, worded around whichever reviewer and tie-breaker were resolved for that specific task:

1. The primary lane does the review and records its findings.
2. The reviewer (a named provider, or "a second reviewer, a different model, or a person" if none was resolved) reviews the same material independently, without seeing the primary lane's findings first.
3. Findings the two disagree on go to the tie-breaker, whose read decides (or are settled by hand if no tie-breaker was resolved).
4. Only findings that survive are fixed; record that the independent pass ran.

Step 2's independence matters: showing the second reviewer the primary lane's findings first would let it anchor on those findings instead of forming its own judgment, defeating the point of having two separate reviewers at all.

## Why a review outranks the large-input offload

The rule ladder normally routes a whole-repository or whole-document task to the large-context lane (rule R4), because that lane is built to handle bulk input cheaply. But a review task that also happens to be large ("perform a security review of the entire repository") is checked by rule R3b before R4 ever gets a turn, specifically so the review is never swallowed by the large-input offload. Handing an entire security review to one outside model as a bulk-read shortcut would defeat the reason a review pass exists in the first place: the whole point is two independent readers, not one reader with a bigger context window.

When this happens, the primary lane still does the actual review, and still gets the mandatory review pass. The large-context lane is only ever suggested for the bulk read itself, never as a substitute reviewer, and the decision's notes say so explicitly.

## How it is logged

`makeLogEntry` (in `src/log.js`) reduces a `reviewPass` down to its auditable shape before it is written to the decision log: which lane reviewed (`reviewer`), which lane arbitrated (`tieBreaker`), and which lanes were skipped and why (`skipped`, as a plain list of lane ids). The full reviewer and tie-breaker descriptions (model id, provider, dispatch string) live on the in-memory decision object returned by `route()`, but only the lane ids are persisted to the JSONL log, keeping log entries small and free of anything that could resemble a credential.

## Acting on a review pass: a copy-paste snippet

An agent that receives a decision with a non-null `reviewPass` should treat the requirement as binding, not advisory. A minimal pattern:

```js
import { route } from './src/router.js';

const d = route(taskDescription);

// ... do the primary lane's work as d.dispatch describes ...

if (d.reviewPass) {
  const rp = d.reviewPass;
  if (rp.reviewer) {
    // Dispatch rp.reviewer.dispatch against the SAME material, independently,
    // before showing it the primary lane's own findings.
  } else {
    // No second model is available. Stop and get a human, or a manually
    // chosen different model, to review the same material before calling
    // this task done.
  }
  if (rp.tieBreaker) {
    // Hold this lane in reserve; only invoke it on findings the primary
    // lane and rp.reviewer disagree on.
  }
  // Record, wherever this task's outcome is logged, that the independent
  // pass ran (or, if rp.reviewer was null, that it was deferred to a human).
}
```

The key discipline this enforces: a review task is not "done" the moment the primary lane finishes its pass. It is done once `reviewPass.required` has been satisfied, whether that means a second model ran independently or a human explicitly took over that step.
