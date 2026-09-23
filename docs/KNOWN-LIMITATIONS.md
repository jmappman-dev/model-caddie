# Known limitations

This document exists because the honest answer to "how well does the review-pass
decision work?" is a number with a failure direction, not a claim that it works.

Everything here is measured, reproducible, and reported as it actually behaves
rather than as it was intended to behave. Run the measurements yourself:

```
npm test              unit, property and metamorphic tests
npm run eval          the tuned corpus (a regression suite)
npm run eval:holdout  a blind holdout set (the generalisation measure)
```

## What kind of thing this is

The review-pass decision is a **deterministic classifier over natural language**.
It reads a plain-English task description and decides whether that task needs an
outside model to review the result, and whether the review should be scoped as
security or correctness.

That is a hard problem with no complete solution in pattern matching. English has
unbounded ways to say "change this code". A keyword and regex classifier will
always have a long tail. The design goal is therefore **not** perfect accuracy.
It is:

1. a known, measured error rate,
2. errors that fall in the **safe direction**, and
3. limitations written down rather than discovered by a user.

## The failure direction is deliberate

The two error types have very different costs.

| Error | What happens | Cost |
|---|---|---|
| **False positive** (a pass is required when it need not be) | You are told to get a second model to look at something that did not need it | A few minutes, and a reviewer confirming there is nothing to find |
| **False negative** (no pass required when one should be) | Code changes ship with no outside review, and nothing tells you | A real defect reaching production unreviewed |

They are not symmetric, so the classifier is **not** tuned for balance. It is
tuned to keep recall high and accept the false positives that come with it. The
release gate in `eval/evaluate.js` encodes that: the recall threshold is set
higher than the precision threshold, on purpose.

If you would rather trade the other way, lower `THRESHOLDS.recall` and narrow the
patterns. Do not do it silently: the whole point of this file is that the
trade-off is stated.

## Measured behaviour

Four corpora, because they answer different questions.

| Corpus | What it is | State |
|---|---|---|
| `eval/corpus.json` | Every case a review round or bug report ever found. Written by the maintainer. | Regression suite. Near-perfect by construction. |
| `eval/holdout.json` | 60 cases by an outside reviewer from the contract alone. | **Burned**, informed two fix rounds. |
| `eval/holdout2.json` | 70 harder cases, same method. | **Burned**, informed one fix round. |
| `eval/holdout3.json` | 80 cases, deliberately different distribution: symptom-only bug reports, commit-style one-liners, asks buried mid-narrative, questions that are really change requests, infra-as-code, test code. | **CLEAN. Run once, never tuned against. Keep it that way.** |

Measured 2026-09-23:

| Corpus | Precision | Recall | F1 | Scope |
|---|---|---|---|---|
| tuned corpus | 100% | 100% | 100% | 100% |
| holdout 1 (burned) | 85.7% | 100% | 92.3% | 96.7% |
| holdout 2 (burned) | 68.3% | 80.0% | 73.7% | 92.9% |
| **holdout 3 (clean)** | **68.8%** | **55.0%** | **61.1%** | **72.7%** |

**Scope accuracy is conditional and therefore flattering.** A task the router never flagged does not get its scope judged at all, so 72.7% is measured only over tasks it already caught. The end to end number is the one that answers the real question: of every task that needed a review, how many got BOTH the request and the correct scope? On holdout 3 that is **16 of 40, or 40.0%**. `npm run eval` now prints it on every run so the conditional figure cannot be quoted alone. Found by an independent Codex pass, 2026-09-23.

**Quote the holdout 3 row. It is the only unburned measurement here.**

### The trend across three blind sets is the real finding

Each set's score BEFORE it was used to fix anything:

| Blind set, first contact | Precision | Recall |
|---|---|---|
| holdout 1 | 58.8% | 33.3% |
| holdout 2 | 71.0% | 62.9% |
| holdout 3 | 68.8% | 55.0% |

After tuning against a set, that set's score rises above 90%. A fresh set then
lands back near 60 to 70% precision and 33 to 63% recall. That pattern is
consistent with fitting to whichever set was being looked at rather than to the
underlying concept.

**Two caveats on how hard to push that conclusion**, both raised by an independent
Codex pass on 2026-09-23 and both accepted here.

First, the sets are small. Holdout 3 has 40 positive cases, so a nominal 95%
Wilson interval on 55% recall runs about 40% to 69%. That interval describes
sampling on this set only. It does not account for author selection, correlated
paraphrasing, uncertain labels, or distribution shift, all of which are present.

Second, an earlier draft of this document claimed the ceiling is a property of
lexical matching rather than a fixable defect. **That claim is withdrawn.** It was
not measured, and no published figure exists for what recall lexical matching can
reach on a semantic label of this kind. The regression cycle is evidence that
patching individual phrasings does not generalise. It is not evidence that a
better rule design could not do materially better. Treat the ceiling as unknown.

Every fix in this release was real and each one closed a genuine defect. The
defects were simply drawn from an unbounded pool. Nobody should read the tuned
100% as quality.

### The error direction is NOT reliably safe

An earlier draft of this document claimed errors fall in the safe direction. That
claim has now been wrong twice, and it is corrected here rather than quietly
dropped.

| Set | False negatives (missed review) | False positives (redundant review) | Lean |
|---|---|---|---|
| holdout 2, before fixes | 13 | 9 | dangerous |
| holdout 2, after fixes | 7 | 13 | safe |
| **holdout 3 (clean)** | **18** | **10** | **dangerous** |

On the cleanest data the classifier misses more reviews than it over-requests.
Treat the review pass as **a useful prompt, not a guarantee**. If a change matters,
require the outside pass yourself rather than waiting to be told.

### What it misses, by class

From holdout 3, largest first:

1. **Symptom-only bug reports with no action stated.** "The desktop stopwatch shows 00:60 for a frame before rolling over to 01:00." A defect report is a change request, but there is no verb to match.
2. **Commit-style one-liners.** `fix: retain the selected tab...`, `test: cover leap-day rollover...`, `refunds: round the amount once at the ledger boundary`. The colon form carries the verb as a label, not a clause.
3. **Change requests phrased as questions or complaints.** "Any chance we could make the metronome remember its tempo?" "I'm tired of the animation restarting."
4. **Infrastructure as code.** Terraform, Makefiles, nginx config and shell scripts are code, but carry neither a source extension the detector knows nor the usual code vocabulary.
5. **Conversational review requests.** "Give the design a critical read", "challenge the cases where discounts stack".
6. **Security reported as a user-visible symptom.** "Signed out, hit Back, and there was the previous customer's address again." Real security work, described with no security vocabulary.

Scope accuracy is also weakest on infrastructure security: world-open ingress
rules, tenant isolation in a migration, path traversal in an archive extractor and
CSV formula injection were all scoped correctness rather than security.

### What it over-requests, by class

1. Read-only investigation that names a code file or a code word. "Which commit first introduced the spinner in `src/loading.ts`? Just find the commit."
2. Business and prose work mentioning "security review", "code review" or "auth migration".
3. Trivial edits inside source files, such as fixing a comment typo or reformatting.

## Path-based forced review, and its honest effect

Added 2026-09-23 on the arbitrated recommendation. A task naming a HIGH-RISK path
forces the review pass outright, bypassing the scoring: a migration, an auth
module, a lockfile, a CI pipeline, an infrastructure definition or a secret store.
Nothing in the scoring can talk it out of a review. The one exemption is an
explicit read-only statement, because reading a migration is not modifying one.

The reasoning is that a path survives paraphrase in a way prose does not.
`migrations/002_add_users.sql` means the same thing however the sentence around it
is worded, which is exactly what the text classifier fails at.

**The design rule, and it was violated once already.** Match PATHS, never bare
prose words or bare filenames. The first version accepted `auth.ts` anywhere, and
a blind set immediately showed it firing on "the essay Who owns auth.py?", "the
vendor called the line item auth.ts migration" and a request to summarise a
migration diary that mentioned `main.tf`. Filenames appear inside ordinary prose
constantly. The rule now requires a real path: the risk word as a DIRECTORY
(`src/auth/session.ts`), or a filename WITH a path prefix
(`app/middleware/auth.js`). A bare filename is rejected.

**Measured effect: none on the clean holdout, and that is stated rather than
spun.** On holdout 3 the rule fires on 1 of 80 cases, and every headline figure is
unchanged: 68.8% precision, 55.0% recall, 40.0% end to end, identical before and
after. The cases in that set which name risk paths were already being caught by
the text classifier. On holdout 2 it costs 1 false positive, taking precision from
68.3% to 66.7%, because a comment typo in `src/auth.ts` now forces a security
review. That is deliberate: a trivial word must not exempt a risk surface.

So the value of this rule is real but narrow, and it is demonstrated by
construction (14 targeted tests covering migrations, auth modules, lockfiles, CI,
infrastructure and secret stores) rather than by the blind measurement. It buys
safety on a class of task the corpora happen not to contain much of. It did not
move the number, and claiming otherwise would be exactly the overfitting story
this document exists to record.

**Scope is pinned to security only for surfaces that inherently concern access,
secrets, stored data or the supply chain** (auth, credential stores, dependency
manifests, migrations). Pinning every surface cost measured scope accuracy,
because reshuffling CI jobs in a workflow file is a correctness change.

## Known gaps, specifically

These are reachable, reproducible, and currently unfixed. Cases marked
`known_gap: true` in the corpora assert this behaviour, so if one is ever fixed the
eval tells you to update this file rather than letting the docs drift.

### 1. A filename mentioned incidentally in a prose task

> "The incident report mentions renderer.cpp; turn that report into a short update for management."

Naming a source file is treated as evidence the task is code work, which is what
fixes a much worse false-negative class. It cannot distinguish a file being
*worked on* from a file being *talked about*. Fails toward a redundant review.

### 2. "review" appearing as a noun in something that is not a review

> "Draft an agenda for next week's security review meeting."

The phrase "security review" is matched literally. Fails toward a redundant review.

### 3. No model of intent, only of vocabulary

> "Read the incident timeline, identify the stalled worker, then explain where cancellation currently stops. Leave the implementation alone."

There is a guard for explicit no-change statements ("do not change any files",
"read-only") and for read-only framing verbs that lead a task. It is vocabulary
matching, not intent analysis, so a long mixed-mode request can still be read
wrongly. Fails toward a redundant review.

### 4. Filename matching was ASCII, and is not any more

This section previously said a source filename in a non-Latin script was not
recognised, and that it was the most important open item here because it failed
toward a MISSED review. A blind holdout set found three more instances of it, so
it was fixed on 2026-09-23: the path patterns now use Unicode property escapes
with the `u` flag, and `packages/表示/整列.ts`, `moteur/échéance.rs` and
`src/算法/寻路.cpp` all register as source.

Kept here rather than deleted, because the fix has a sharp edge worth knowing:
rebuilding one of those patterns without the `u` flag makes every `\p{...}` class
silently stop meaning anything, and every non-ASCII path stops matching with no
error. That is exactly what happened once during the fix. If you touch
`src/strip.js`, keep the flag.

### 5. A mixed prompt can dilute its own signal

A request whose implementation clause sits among several investigation clauses can
come out below the bar. Routing each implementation subtask on its own works.
Widening the patterns to catch it reliably trades one real false negative for many
false positives, which the measurements did not support.

### 6. Vendor-root comparison over-matches

For why `api.openai.com` and `api.anthropic.com` are treated as the same vendor,
and why that direction is the safe one, see the provider section of
[CONFIGURATION.md](./CONFIGURATION.md). It never produces a false claim of
independence; it can cost you an available tie-breaker.

## If you are extending this

The rule that keeps this honest, and the one that was learned the hard way:

> **Never patch a false positive or false negative without first adding the case
> to a corpus.**

Four review rounds against v0.2.0 each fixed the specific example that prompted
them, and each fix was verified only by that example. Two of those fixes created
new defects, one of them worse than the problem it solved: tightening a keyword
list to remove false positives silently stopped `fix the bug in src/retry.js` from
requiring any review at all.

So, for a change to the classifier:

1. Add the case to `eval/corpus.json` with its correct label first.
2. Run `npm run eval` and watch it fail.
3. Fix it.
4. Run `npm run eval` again, and check the **whole** confusion matrix, not your case.
5. Run `npm run eval:holdout` and confirm generalisation did not regress.
6. Run `npm test` for the property and metamorphic tests.
7. If the right answer is a documented limitation rather than a fix, mark it
   `known_gap: true` and add a section here.

Step 4 is the one that matters. Every regression in this project's history came
from checking the case that prompted the change and nothing else.
