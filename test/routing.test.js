// Routing behavior tests, run against the bundled anthropic profile with every
// optional lane's env var set. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripFilenames, route as routeWith, TIERS, _identity, _vendor } from '../src/router.js';
import { makeLogEntry } from '../src/log.js';

const FULL_ENV = { PERPLEXITY_API_KEY: 'test-placeholder', GEMINI_API_KEY: 'test-placeholder' };
const route = (text) => routeWith(text, { env: FULL_ENV });


test('tier ladder is ordered cheapest-capable first', () => {
  assert.deepEqual(TIERS, ['light', 'standard', 'strong', 'frontier']);
});

test('filename tokens do not leak keywords into classification', () => {
  const d = route('fix the typo in codebase-audit-notes.md');
  assert.equal(d.lane, 'primary');
  assert.notEqual(d.lane, 'large-context');
  assert.equal(d.tier, 'light');
});

test('stripFilenames removes file and path tokens', () => {
  const out = stripFilenames('open Projects/agentic-os/review-plan.md and social-automation.json');
  assert.ok(!out.includes('review-plan.md'));
  assert.ok(!out.includes('social-automation.json'));
  assert.ok(!out.includes('agentic-os'));
});

test('trivial mechanical task routes to haiku', () => {
  const d = route('rename the heading in the team wiki note');
  assert.equal(d.lane, 'primary');
  assert.equal(d.tier, 'light');
  assert.equal(d.rule, 'R5-primary-ladder');
});

test('standard single-feature work defaults to sonnet', () => {
  const d = route('add a retry wrapper to the fetch call in the publish script');
  assert.equal(d.lane, 'primary');
  assert.equal(d.tier, 'standard');
  assert.equal(d.criterion, 'E0-default');
});

test('drafting with no other signals defaults to sonnet', () => {
  const d = route('draft an outline for the newsletter intro');
  assert.equal(d.lane, 'primary');
  assert.equal(d.tier, 'standard');
});

test('multi-file reasoning escalates to opus with E1', () => {
  const d = route('refactor error handling across the codebase');
  assert.equal(d.tier, 'strong');
  assert.equal(d.criterion, 'E1-multi-file');
});

test('architecture and review work escalates to opus with E2', () => {
  const d = route('do a design review of the event layer');
  assert.equal(d.tier, 'strong');
  assert.equal(d.criterion, 'E2-architecture-review');
});

test('ambiguous requirements escalate to opus with E3', () => {
  const d = route('the requirements are ambiguous, figure out what the intake flow should do');
  assert.equal(d.tier, 'strong');
  assert.equal(d.criterion, 'E3-ambiguity');
});

test('high blast radius escalates to opus with E4', () => {
  const d = route('run the schema migration against production');
  assert.equal(d.tier, 'strong');
  assert.equal(d.criterion, 'E4-blast-radius');
});

test('frontier work escalates to fable with E5', () => {
  const d = route('adversarially verify the synthesis before it ships');
  assert.equal(d.tier, 'frontier');
  assert.equal(d.criterion, 'E5-frontier');
});

test('live current fact routes to perplexity search', () => {
  const d = route('what is the current 10-year treasury yield');
  assert.equal(d.lane, 'research');
  assert.equal(d.tier, 'quick');
  assert.equal(d.rule, 'R3-live-web');
});

test('deep multi-source live question routes to perplexity research', () => {
  const d = route('research the latest multi-source view on EU AI Act enforcement');
  assert.equal(d.lane, 'research');
  assert.equal(d.tier, 'deep');
});

test('large summarization offload routes to gemini flash', () => {
  const d = route('summarize the entire repo so I can brief someone on it');
  assert.equal(d.lane, 'large-context');
  assert.equal(d.tier, 'fast');
  assert.equal(d.rule, 'R4-large-input');
});

test('large reasoning-heavy offload escalates to gemini 2.5 pro', () => {
  const d = route('evaluate the trade-offs across the entire codebase');
  assert.equal(d.lane, 'large-context');
  assert.equal(d.tier, 'reasoning');
});

test('a sensitive-data signal emits an advisory note', () => {
  const d = route('draft a follow-up note to client John about his renewal');
  const note = d.notes.find((n) => /sensitive/i.test(n));
  assert.ok(note, 'expected an advisory PII note');
  assert.ok(/advisory/i.test(note), 'the note must read as advisory, not as a bar');
});

test('a sensitive-data signal never changes the lane', () => {
  const d = route('summarize this long contract document for client Jane');
  assert.equal(d.lane, 'large-context');
  assert.equal(d.rule, 'R4-large-input');
});

test('exactly one sensitive-data note is emitted, never one per rule', () => {
  const d = route('get consensus on the customer intake code');
  assert.equal(d.notes.filter((n) => /sensitive/i.test(n)).length, 1);
});

test('consensus request routes to all lanes', () => {
  const d = route('gut-check this positioning across all three');
  assert.equal(d.lane, 'consensus');
  assert.equal(d.rule, 'R2-consensus');
});

test('explicit lane override is honored', () => {
  const d = route('use gemini to summarize the meeting transcript');
  assert.equal(d.lane, 'large-context');
  assert.equal(d.rule, 'R1-override');
});

test('explicit claude tier override is honored', () => {
  const d = route('use opus for this outline');
  assert.equal(d.lane, 'primary');
  assert.equal(d.tier, 'strong');
  assert.equal(d.rule, 'R1-override');
});

test('a lane override is honored even when the task carries PII', () => {
  const d = route('use gemini to draft an email to client John');
  assert.equal(d.lane, 'large-context');
  assert.equal(d.rule, 'R1-override');
  assert.ok(!d.notes.some((n) => /override denied/i.test(n)));
});

test('slash word-pairs are not stripped as paths', () => {
  const out = stripFilenames('deploy and/or migrate the design/architecture docs');
  assert.ok(out.includes('and/or'));
  assert.ok(out.includes('design/architecture'));
});

test('slash word-pair keeps its classification signal', () => {
  const d = route('review the design/architecture of the intake flow');
  assert.equal(d.tier, 'strong');
  assert.equal(d.criterion, 'E2-architecture-review');
});

test('space-separated "gut check" still triggers consensus', () => {
  const d = route('run a gut check on this plan');
  assert.equal(d.lane, 'consensus');
});

test('space-separated "force push" still triggers E4', () => {
  const d = route('clean up then force push the branch');
  assert.equal(d.tier, 'strong');
  assert.equal(d.criterion, 'E4-blast-radius');
});

test('"architecting" triggers E2', () => {
  const d = route('start architecting the intake system');
  assert.equal(d.tier, 'strong');
  assert.equal(d.criterion, 'E2-architecture-review');
});

test('"across our codebase" triggers E1', () => {
  const d = route('tighten logging across our codebase');
  assert.equal(d.tier, 'strong');
  assert.equal(d.criterion, 'E1-multi-file');
});

test('blast radius outranks multi-file in the logged criterion', () => {
  const d = route('codebase-wide migration on production');
  assert.equal(d.tier, 'strong');
  assert.equal(d.criterion, 'E4-blast-radius');
});

test('go filenames are stripped so their words do not escalate', () => {
  const d = route('fix the typo in production-deploy.go');
  assert.equal(d.tier, 'light');
  assert.equal(d.criterion, 'E-trivial');
});

test('the sonnet floor is gone with the PII rule that created it', () => {
  const d = route('fix the typo in this long contract for client Jane');
  assert.equal(d.lane, 'large-context');
  assert.equal(d.rule, 'R4-large-input');
  assert.ok(!d.notes.some((n) => /floor/i.test(n)));
});

test('makeLogEntry produces a complete auditable record', () => {
  const d = route('add a retry wrapper to the fetch call in the publish script');
  const entry = makeLogEntry('add a retry wrapper to the fetch call in the publish script', d);
  assert.ok(entry.ts.match(/^\d{4}-\d{2}-\d{2}T/));
  assert.equal(entry.lane, 'primary');
  assert.equal(entry.tier, 'standard');
  assert.equal(entry.rule, 'R5-primary-ladder');
  assert.equal(entry.criterion, 'E0-default');
  assert.ok(Array.isArray(entry.notes));
});

test('makeLogEntry truncates long task text', () => {
  const long = 'x'.repeat(500);
  const entry = makeLogEntry(long, route(long));
  assert.ok(entry.task.length <= 143); // 140 + ellipsis
});

test('R3 does not fire on current-rules / current weights in build tasks', () => {
  const a = route('Epoch-scope the main-lane weight recalibration to current-rules closes with a thin-sample guard; changes live pick steering, production');
  assert.equal(a.lane, 'primary', `misfired to ${a.lane}/${a.rule}`);
  const b = route('Epoch-scope the recalibration in lib/learning.js to current-rules closes, production picker steering change, multi-file TDD build');
  assert.equal(b.lane, 'primary', `misfired to ${b.lane}/${b.rule}`);
  const c = route('refactor the current implementation of the weights module');
  assert.equal(c.lane, 'primary');
});

test('R3 still fires on genuine current-fact queries', () => {
  assert.equal(route('what is the current 10-year treasury yield').lane, 'research');
  assert.equal(route('current price of NVDA').lane, 'research');
  assert.equal(route("today's market news for Chicago").lane, 'research');
});

test('code review attaches a codex review pass with gemini as tie-break', () => {
  const d = route('do a code review of the intake handler');
  assert.equal(d.lane, 'primary', 'primary lane stays Claude; the pass is supplementary');
  assert.ok(d.reviewPass, 'expected a reviewPass on a code review');
  assert.equal(d.reviewPass.required, true);
  assert.equal(d.reviewPass.reviewer.lane, 'reviewer');
  assert.equal(d.reviewPass.tieBreaker.lane, 'large-context');
});

test('security review and spec review both attach the review pass', () => {
  assert.ok(route('run a security review on the token handling').reviewPass);
  assert.ok(route('spec review before I build this').reviewPass);
  assert.ok(route('review this diff before I ship it').reviewPass);
});

test('codex is the reviewer and gemini only arbitrates disagreement', () => {
  const d = route('code review the scheduler changes');
  assert.equal(d.reviewPass.reviewer.lane, 'reviewer');
  assert.equal(d.reviewPass.tieBreaker.provider, 'google', 'gemini also covers codex being unavailable');
  assert.ok(d.notes.some((n) => /disagree/i.test(n)), 'tie-break must be stated in the notes');
});

test('ordinary tasks carry no review pass', () => {
  assert.equal(route('rename the heading in the team wiki note').reviewPass, null);
  assert.equal(route('draft a social caption for the product launch').reviewPass, null);
  assert.equal(route('what is the current 10-year treasury yield').reviewPass, null);
});

test('no review pass when a non-review task offloads to a non-Claude lane', () => {
  const d = route('summarize the entire codebase for me');
  assert.equal(d.lane, 'large-context');
  assert.equal(d.reviewPass, null);
});

test('codex override is honored as a first-class lane', () => {
  const d = route('ask codex to look at the retry logic');
  assert.equal(d.lane, 'reviewer');
  assert.equal(d.rule, 'R1-override');
  assert.equal(d.reviewPass, null, 'codex is the primary here, not a second pass');
});

test('the review pass carries no blocked flag', () => {
  const d = route('code review the customer intake form handler');
  assert.ok(d.reviewPass);
  assert.equal(d.reviewPass.blocked, undefined);
  assert.ok(!d.notes.some((n) => /review pass blocked/i.test(n)));
});

test('a codex override is honored even when the task carries PII', () => {
  const d = route('ask codex to review the customer disclosure handler');
  assert.equal(d.lane, 'reviewer');
  assert.ok(!d.notes.some((n) => /override denied/i.test(n)));
});

test('a large review keeps its Claude primary and still gets a review pass', () => {
  const d = route('perform a security review of the entire repository');
  assert.equal(d.lane, 'primary', 'a review must not be swallowed by the large-input offload');
  assert.ok(d.reviewPass, 'the highest-stakes review must still get an independent pass');
  assert.equal(d.reviewPass.reviewer.lane, 'reviewer');
  assert.ok(d.notes.some((n) => /bulk|large/i.test(n)), 'should still point at Gemini for the bulk read');
});

test('reviews outrank the large-input offload, non-reviews do not', () => {
  assert.equal(route('code review the whole vault').lane, 'primary');
  assert.equal(route('summarize the whole vault').lane, 'large-context');
});

test('a security review phrased without the literal "security review" still escalates', () => {
  const d = route('review the security of the token handler');
  assert.equal(d.tier, 'strong', 'a security review must not land on the cheap tier');
  assert.ok(d.reviewPass);
});

test('every review escalates to at least opus', () => {
  for (const t of ['code review the retry helper', 'review the correctness of the parser', 'spec review this']) {
    assert.equal(route(t).tier, 'strong', `under-escalated: ${t}`);
  }
});

test('review-pass precedence against the earlier rules is pinned', () => {
  assert.equal(route('gut-check this code review approach').lane, 'consensus');
  assert.equal(route("what is today's exchange rate").reviewPass, null);
  const d = route('use sonnet to code review the parser');
  assert.equal(d.rule, 'R1-override');
  assert.ok(d.reviewPass, 'an explicit tier choice does not waive the outside pass');
});

test('editorial review of client-facing material is not a code review', () => {
  for (const t of [
    'Do a design review of the entire project brochure',
    'Review the correctness of the listing details before publishing',
    'Review the security of the product description in the listing copy',
    'Review the changes to the open-house invitation',
  ]) {
    assert.equal(route(t).reviewPass, null, `content task wrongly got a code-review pass: ${t}`);
  }
});

test('content review does not hijack the large-input offload either', () => {
  const d = route('Do a design review of the entire project brochure');
  assert.notEqual(d.rule, 'R3b-review-primary', 'R3b must not claim content reviews');
});

test('a genuine code review is untouched by the content guard', () => {
  for (const t of ['code review the retry helper', 'review the security of the token handler', 'spec review this']) {
    assert.ok(route(t).reviewPass, `real code review lost its pass: ${t}`);
  }
});

test('F5 regex covers every alternative it claims, not just two', () => {
  assert.ok(route('review the error handling of the import workflow').reviewPass);
  assert.ok(route('review the authentication of the callback endpoint').reviewPass);
});

test('the bulk-read note names the large-context lane and confines it to reading', () => {
  const note = route('perform a security review of the entire repository').notes
    .find((n) => /bulk/i.test(n));
  assert.ok(note, 'expected a bulk-read note');
  assert.ok(note.includes('large-context') && note.includes('google'), 'note must name the lane and provider doing the bulk read');
  assert.ok(/never as the sole reviewer|bulk read only/i.test(note), 'note must confine that lane to reading');
});

test('F9 precedence actually stacks a live signal against a review signal', () => {
  const d = route("security review of today's market conditions");
  assert.equal(d.lane, 'research');
  assert.equal(d.reviewPass, null);
});

test('an explicit code signal beats the content guard', () => {
  for (const t of [
    'Security review the listing generator code',
    'Review this implementation of the CMA builder',
    'Build-spec review for the disclosure automation service',
    'Review the authentication code for the open-house invitation app',
    'Review this patch to the contract parser',
  ]) {
    assert.ok(route(t).reviewPass, `genuine code review lost its pass: ${t}`);
  }
});

test('the content guard still holds when there is no code signal', () => {
  for (const t of [
    'Review the correctness of the listing details before publishing',
    'Do a design review of the entire project brochure',
    'Review the security of the product description in the listing copy',
    'Review the changes to the open-house invitation',
  ]) {
    assert.equal(route(t).reviewPass, null, `content task wrongly got a pass: ${t}`);
  }
});

test('a code review on client-named code still gets its pass', () => {
  const d = route('Security review the contract parser for client data');
  assert.ok(d.reviewPass);
  assert.equal(d.reviewPass.reviewer.lane, 'reviewer');
});

test('the affirmative lane wins even when another lane is named first', () => {
  assert.equal(route('do not use codex; use claude for this review').lane, 'primary');
  assert.equal(route("don't use gemini, use perplexity for this").lane, 'research');
  assert.equal(route('never use perplexity, ask codex to look at the retry logic').lane, 'reviewer');
});

test('a rejected lane is recorded as declined, not routed to', () => {
  const d = route('do not use codex; use claude for this review');
  assert.deepEqual(d.declined, ['reviewer']);
  assert.ok(d.notes.some((n) => /declined/i.test(n) && /codex/i.test(n)));
});

test('an override with no affirmative lane falls through to the ladder', () => {
  const d = route('do not use gemini for this refactor');
  assert.equal(d.lane, 'primary');
  assert.notEqual(d.rule, 'R1-override');
  assert.ok(d.notes.some((n) => /declined/i.test(n)));
});

test('a declined lane stays barred for the later rules, not just R1', () => {
  const g = route('do not use gemini, summarize the entire repository');
  assert.equal(g.lane, 'primary', 'R4 re-entered a lane the user rejected');
  assert.equal(g.rule, 'R4-large-declined');
  const p = route("do not use perplexity, what is today's exchange rate");
  assert.equal(p.lane, 'primary', 'R3 re-entered a lane the user rejected');
  assert.equal(p.rule, 'R3-live-declined');
  assert.ok(p.notes.some((n) => /verif/i.test(n)), 'a live fact kept offline must say so');
});

test('a declined lane is named in the consensus fan-out note', () => {
  const d = route('get a second opinion on this plan, but do not use gemini');
  assert.equal(d.lane, 'consensus');
  assert.ok(d.notes.some((n) => /reduced/i.test(n) && /large-context/i.test(n)));
});

test('the same lane both requested and rejected refuses the override', () => {
  const d = route('use gemini but do not use gemini for this');
  assert.notEqual(d.rule, 'R1-override');
  assert.equal(d.lane, 'primary');
  assert.ok(d.notes.some((n) => /conflict/i.test(n)));
});

test('negation detection does not misfire on an unrelated "no" or "not" nearby', () => {
  assert.equal(route('no rush, use gemini to summarize the transcript').lane, 'large-context');
  assert.equal(route('this is not urgent, use codex to look at the retry logic').lane, 'reviewer');
  assert.equal(route('cannot reproduce it yet, ask codex about the parser').lane, 'reviewer');
  assert.equal(route('not sure which one is right, use perplexity for the rate').lane, 'research');
});

test('affirmative overrides that already worked are unchanged', () => {
  assert.equal(route('use gemini not perplexity').lane, 'large-context');
  assert.equal(route('use gemini to summarize the meeting transcript').lane, 'large-context');
  assert.equal(route('ask codex to look at the retry logic').lane, 'reviewer');
  assert.equal(route('use opus for this outline').tier, 'strong');
  assert.deepEqual(route('use gemini to summarize the meeting transcript').declined, []);
});

test('a declined reviewer is skipped and the review pass falls back, never dropped', () => {
  const d = route('do not use codex; use claude for this code review');
  assert.equal(d.lane, 'primary');
  assert.ok(d.reviewPass);
  assert.equal(d.reviewPass.reviewer.lane, 'large-context', 'the configured fallback reviews instead');
  assert.equal(d.reviewPass.tieBreaker, null, 'the fallback cannot also be its own tie-breaker');
  assert.deepEqual(d.reviewPass.skipped, [{ lane: 'reviewer', reason: 'declined in this task' }]);
  assert.ok(d.notes.some((n) => /fell back/i.test(n)));
});

test('a declined Claude tier the ladder still picks is flagged, not silently used', () => {
  const d = route('do not use opus, run the schema migration against production');
  assert.equal(d.tier, 'strong', 'the ladder is unchanged; Claude tiers are not third-party lanes');
  assert.ok(d.notes.some((n) => /tier conflict/i.test(n)));
});

test('makeLogEntry carries the declined lanes into the audit trail', () => {
  const t = 'do not use gemini, summarize the entire repository';
  assert.deepEqual(makeLogEntry(t, route(t)).declined, ['large-context']);
  assert.deepEqual(makeLogEntry('use opus for this outline', route('use opus for this outline')).declined, []);
});

test('a negation separated from the verb only by "to" is still a rejection', () => {
  assert.equal(route('I would prefer not to use gemini for this').lane, 'primary');
  assert.equal(route('refuse to use gemini here, keep it local').lane, 'primary');
  assert.deepEqual(route('refuse to use gemini here, keep it local').declined, ['large-context']);
});

test('the filler set between cue and verb is closed, not a word count', () => {
  assert.deepEqual(route('we are not able to use gemini for this').declined, ['large-context']);
  assert.equal(route('we cannot afford to use gemini').declined.length, 0);
  assert.equal(route('no rush, use gemini to summarize the transcript').lane, 'large-context');
});

test('a gerund is a rejection signal only, never a request', () => {
  assert.deepEqual(route('avoid using gemini, keep it local').declined, ['large-context']);
  assert.deepEqual(route('using gemini, summarize the entire repo').declined, []);
  assert.equal(route('using gemini, summarize the entire repo').rule, 'R4-large-input');
});

test('no third-party lane is denied on a PII signal', () => {
  assert.equal(route('ask perplexity to pull comps for client Jane').lane, 'research');
  assert.equal(route('use gemini for client Jane').lane, 'large-context');
  assert.equal(route('ask codex about the customer file').lane, 'reviewer');
});

test('modal glue between the cue and the verb does not defeat the negation', () => {
  assert.equal(route('we are not going to use gemini here; summarize the entire repository').lane, 'primary');
  assert.deepEqual(route('we are not going to use gemini here; summarize the entire repository').declined, ['large-context']);
  assert.deepEqual(route('we are not able to use gemini for this').declined, ['large-context']);
  assert.deepEqual(route('not allowed to use codex on this repo').declined, ['reviewer']);
});

test('the modal set stays closed: ordinary words before the verb keep it affirmative', () => {
  assert.equal(route('no rush, use gemini to summarize the transcript').lane, 'large-context');
  assert.equal(route('this is not urgent, use codex to look at the retry logic').lane, 'reviewer');
  assert.equal(route('not sure which one is right, use perplexity for the rate').lane, 'research');
  assert.equal(route('we cannot afford to use gemini').declined.length, 0, 'open-ended fillers stay out of the window');
});

test('with every review lane declined, the pass survives and asks for a manual second pass', () => {
  const d = route('do not use codex; do not use gemini; use claude for this code review');
  assert.ok(d.reviewPass, 'the review requirement must never disappear');
  assert.equal(d.reviewPass.reviewer, null);
  assert.equal(d.reviewPass.tieBreaker, null);
  assert.deepEqual(d.reviewPass.skipped.map((x) => x.lane).sort(), ['large-context', 'reviewer']);
  assert.ok(d.notes.some((n) => /by hand/i.test(n)));
});

test('the large-review bulk-read note does not point at a declined lane', () => {
  const d = route('do not use gemini; perform a security review of the entire repository');
  assert.equal(d.rule, 'R3b-review-primary');
  assert.ok(!d.notes.some((n) => /use the large-context lane/i.test(n)), 'note sent the bulk read to a declined lane');
  assert.ok(route('perform a security review of the entire repository').notes.some((n) => /use the large-context lane/i.test(n)), 'the same wording must appear when the lane is allowed, or this check proves nothing');
  assert.ok(d.notes.some((n) => /bulk/i.test(n)), 'the large-review caveat must still be stated');
});

test('a declined consensus leg is dropped in the machine-readable fields, not only the note', () => {
  const d = route('get a second opinion on this plan, but do not use gemini');
  assert.equal(d.lane, 'consensus');
  assert.deepEqual(d.legs, ['primary', 'research', 'reviewer'], 'the declined leg must leave the machine-readable leg list');
  assert.ok(!/large-context/.test(d.dispatch), 'dispatch still tells the executor to run the declined leg');
  assert.deepEqual(d.dropped.map((x) => x.lane), ['large-context']);
});

test('an unconstrained consensus still fans out to everything', () => {
  const d = route('gut-check this positioning across all three');
  assert.deepEqual(d.legs, ['primary', 'research', 'large-context', 'reviewer']);
  assert.deepEqual(d.dropped, []);
});

test('a conflict on one lane does not suppress a clean override of another', () => {
  const d = route('ask perplexity for this; use gemini in the example but do not use gemini for execution');
  assert.equal(d.lane, 'research');
  assert.equal(d.rule, 'R1-override');
  assert.deepEqual(d.declined, ['large-context']);
});

test('a refused override rejoins the ladder at R2, not at R5', () => {
  const d = route("use perplexity but do not use perplexity; what is today's exchange rate");
  assert.equal(d.lane, 'primary');
  assert.equal(d.rule, 'R3-live-declined', 'the live rule still gets its turn after R1 refuses');
});

test('ACCEPTED TRADE-OFF: a same-lane collision refuses even when one mention is descriptive', () => {
  const d = route('Use Gemini to summarize the entire repository and explain why the legacy adapter cannot use Gemini');
  assert.equal(d.lane, 'primary');
  assert.ok(d.notes.some((n) => /conflict/i.test(n)), 'the downgrade must not be silent');
});

test('a coordinated negation declines every lane in the list', () => {
  assert.deepEqual(route('do not use codex or gemini; do a code review of the entire repository').declined, ['reviewer', 'large-context']);
  assert.deepEqual(route('get consensus, but do not use gemini or codex').declined, ['large-context', 'reviewer']);
  assert.deepEqual(route('do not use codex or use gemini for this').declined, ['reviewer', 'large-context']);
});

test('the coordinated form closes the bulk-read and consensus paths too', () => {
  const r = route('do not use codex or gemini; do a code review of the entire repository');
  assert.ok(!r.notes.some((n) => /use the large-context lane/i.test(n)), 'bulk read still sent to a declined lane');
  const c = route('get consensus, but do not use gemini or codex');
  assert.deepEqual(c.legs, ['primary', 'research']);
  assert.deepEqual(c.dropped.map((x) => x.lane), ['large-context', 'reviewer'], 'both declined legs must be named');
});

test('coordination reads affirmatively as well, and needs a real lane after the conjunction', () => {
  assert.equal(route('use gemini or codex for this').lane, 'large-context');
  assert.equal(route('do not use gemini and summarize the entire repo').rule, 'R4-large-declined');
});

test('the modal set covers try and the be-forms', () => {
  assert.deepEqual(route('do not try to use gemini; summarize the entire repository').declined, ['large-context']);
  assert.deepEqual(route('we should not be trying to use gemini here').declined, ['large-context']);
  assert.deepEqual(route('we are not able to use codex on this repo').declined, ['reviewer']);
});

test('only third-party lanes reduce the consensus fan-out', () => {
  const d = route("don't use sonnet; get consensus on this plan");
  assert.equal(d.lane, 'consensus');
  assert.deepEqual(d.legs, ['primary', 'research', 'large-context', 'reviewer'], 'a primary tier is not a consensus leg');
  assert.ok(!/sonnet|standard/i.test(d.dispatch));
});

test('a declined tie-breaker leaves the reviewer in place and says disagreements are settled by hand', () => {
  const d = route('do not use gemini. review this code.');
  assert.equal(d.reviewPass.reviewer.lane, 'reviewer', 'the reviewer was not declined here');
  assert.equal(d.reviewPass.tieBreaker, null);
  assert.ok(d.notes.some((n) => /settle any disagreement by hand/i.test(n)));
  const both = route('do not use codex or gemini. review this code.');
  assert.equal(both.reviewPass.reviewer, null, 'with both declined the pass is by hand');
  assert.ok(both.notes.some((n) => /by hand/i.test(n)));
});

test('KNOWN GAP: a rejection naming a lane with no verb at all is invisible to R1', () => {
  assert.deepEqual(route('no gemini. summarize the entire repository').declined, []);
  assert.equal(route('no gemini. summarize the entire repository').lane, 'large-context');
  assert.deepEqual(route('do not route this through gemini; summarize the entire repository').declined, ['large-context']);
});

test('an either/both list is still an override list', () => {
  const d = route('do not use either codex or gemini; summarize the entire repo');
  assert.deepEqual(d.declined, ['reviewer', 'large-context']);
  assert.equal(d.lane, 'primary', 'R4 offloaded to a lane the input declined');
  assert.equal(route('use either gemini or codex for this').lane, 'large-context');
});

test('a fresh imperative after a negated list is judged on its own polarity', () => {
  const d = route('do not use codex; and use gemini to summarize this');
  assert.equal(d.lane, 'large-context', 'the second clause is a real request, not part of the negated list');
  assert.deepEqual(d.declined, ['reviewer']);
  assert.deepEqual(route('do not use codex or use gemini for this').declined, ['reviewer', 'large-context']);
  assert.deepEqual(route('do not use codex and gemini').declined, ['reviewer', 'large-context']);
});

test('the review pass uses the surviving fallback reviewer', () => {
  const d = route('do not use codex. review this code for client Alice.');
  assert.equal(d.reviewPass.reviewer.lane, 'large-context');
  assert.ok(d.notes.some((n) => /fell back to the large-context lane/i.test(n)));
});

test('a coordinated negation covers every override verb, not just a repeated "use"', () => {
  const d = route('do not use codex or ask gemini to review this code');
  assert.equal(d.lane, 'primary');
  assert.deepEqual(d.declined, ['reviewer', 'large-context']);
  assert.deepEqual(route('do not use gemini or via perplexity for this').declined, ['large-context', 'research']);
  assert.equal(route('do not use codex; and ask gemini to summarize this').lane, 'large-context');
});

test('a comma-separated negation list declines every item', () => {
  const d = route('do not use codex, gemini, or perplexity; give me the latest weather');
  assert.deepEqual(d.declined, ['reviewer', 'large-context', 'research']);
  assert.equal(d.lane, 'primary');
  assert.equal(d.rule, 'R3-live-declined');
});

test('a comma that is not a lane list is not chained', () => {
  const d = route('use gemini, summarize the entire repo');
  assert.equal(d.lane, 'large-context');
  assert.deepEqual(d.declined, []);
});

test('a comma followed by a lane acting as a subject is not a list continuation', () => {
  const d = route("do not use gemini, perplexity should get today's news");
  assert.deepEqual(d.declined, ['large-context']);
  assert.equal(d.lane, 'research', 'perplexity was never declined here');
});

test('a genuine list is unaffected by the subject test', () => {
  assert.deepEqual(route('do not use codex, gemini and perplexity for this').declined, ['reviewer', 'large-context', 'research']);
  assert.deepEqual(route('do not use codex, gemini, or perplexity; give me the latest weather').declined, ['reviewer', 'large-context', 'research']);
});

test('an intensifier between the cue and the verb does not defeat the negation', () => {
  assert.deepEqual(route('do not ever use gemini').declined, ['large-context']);
  assert.equal(route('do not ever use gemini; summarize the entire repo').lane, 'primary');
  assert.deepEqual(route('never really use codex for this').declined, ['reviewer']);
});

test('a gerund rejection is heard, and bars the lane for the later rules', () => {
  const d = route('avoid using gemini to summarize the entire repo');
  assert.deepEqual(d.declined, ['large-context']);
  assert.equal(d.lane, 'primary');
  assert.equal(d.rule, 'R4-large-declined');
  assert.deepEqual(route('without using gemini, summarize the entire repo').declined, ['large-context']);
  assert.deepEqual(route('instead of asking codex, review this code').declined, ['reviewer']);
});

test('a gerund with no cue creates no override in either direction', () => {
  const d = route('we tried using gemini and it failed; summarize the entire repo');
  assert.deepEqual(d.declined, []);
  assert.equal(d.lane, 'large-context', 'no cue means no override at all, so R4 decides on its own');
  assert.equal(route('the problem with using gemini is the payload ceiling').rule, 'R5-primary-ladder');
});

test('scoping adverbs are not treated as negation intensifiers', () => {
  assert.deepEqual(route("don't just use gemini; get a second opinion").declined, []);
  assert.deepEqual(route('do not simply use codex, review it yourself too').declined, []);
  assert.deepEqual(route('do not ever use gemini').declined, ['large-context'], 'real intensifiers still bind');
  assert.deepEqual(route('do not really use codex here').declined, ['reviewer']);
});

test('a prepositional lane designator binds to a cue earlier in the same phrase', () => {
  const d = route('do not send the entire repo through gemini');
  assert.deepEqual(d.declined, ['large-context']);
  assert.equal(d.lane, 'primary');
  assert.deepEqual(route('never run the transcript via perplexity').declined, ['research']);
});

test('the prepositional window stops at punctuation, so a new clause reads affirmatively', () => {
  const d = route('this is not a problem, run it through gemini');
  assert.deepEqual(d.declined, [], 'the cue reached across a clause boundary');
  assert.equal(d.lane, 'large-context');
});

test('the prepositional window fits a real object phrase', () => {
  const d = route('do not send any portion of the full repo through gemini; summarize the entire repo');
  assert.deepEqual(d.declined, ['large-context']);
  assert.equal(d.lane, 'primary');
});

test('KNOWN LIMIT: the window over-reaches rather than under-reaches, by design', () => {
  const d = route('if claude is not available send the full repo through gemini');
  assert.deepEqual(d.declined, ['large-context']);
  assert.equal(d.lane, 'primary');
});

test('"to <lane>" is recognized as a rejection target', () => {
  const d = route('do not send the entire repo to gemini');
  assert.deepEqual(d.declined, ['large-context']);
  assert.equal(d.lane, 'primary');
  assert.equal(d.rule, 'R4-large-declined');
});

test('bare "to <lane>" is not an affirmative override', () => {
  assert.equal(route('compared to gemini, summarize the entire repo').rule, 'R4-large-input');
  assert.deepEqual(route('compared to gemini, summarize the entire repo').declined, []);
});

test('R3 does not fire on bare "today" in dated logging or drafting tasks', () => {
  const a = route("Log today's product demo activity to the CRM (two attendees, one repeat visitor), then draft follow-up emails to both");
  assert.equal(a.lane, 'primary', `misfired to ${a.lane}/${a.rule}`);
  assert.equal(a.rule, 'R5-primary-ladder');
  const b = route("Draft today's session log and append the open threads");
  assert.equal(b.lane, 'primary', `misfired to ${b.lane}/${b.rule}`);
  const c = route('Add the sign-ins from today to the CRM and tag them open-house');
  assert.equal(c.lane, 'primary', `misfired to ${c.lane}/${c.rule}`);
  const d = route('Narrow the router regex so bare today no longer routes drafting tasks to Perplexity');
  assert.equal(d.lane, 'primary', `misfired to ${d.lane}/${d.rule}`);
});

test('R3 still fires when "today" is tied to a live-fact lookup', () => {
  assert.equal(route("today's 10-year treasury yield").rule, 'R3-live-web');
  assert.equal(route("what is the weather in Chicago today").rule, 'R3-live-web');
  assert.equal(route('NVDA price today').rule, 'R3-live-web');
  assert.equal(route('exchange rates as of today').rule, 'R3-live-web');
  assert.equal(route("what's the Villanova score today").rule, 'R3-live-web');
});

test('R3 question branch ignores past-tense activity questions with "today"', () => {
  const a = route('What did I draft today?');
  assert.equal(a.lane, 'primary', `misfired to ${a.lane}/${a.rule}`);
  const b = route('What does the open-house sign-in flow do today?');
  assert.equal(b.lane, 'primary', `misfired to ${b.lane}/${b.rule}`);
});

test('R3 fires on adverb-separated and "what happened" live-fact forms', () => {
  assert.equal(route('Are exchange rates up today?').rule, 'R3-live-web');
  assert.equal(route('What happened in markets today?').rule, 'R3-live-web');
});


// ---------------------------------------------------------------------------
// 0.2.0: the review pass used to fire only when a task ASKED for a review,
// because the matcher keyed on the literal word "review". A task that CHANGES
// code needs the outside pass just as much and never uses that word, so the
// requirement silently depended on the operator remembering it.
// ---------------------------------------------------------------------------

test('a code-mutating task requires a review pass without the word review', () => {
  const d = route('fix the crash in the retry helper, TDD then verify');
  assert.ok(d.reviewPass, 'a code fix must require the outside pass');
  assert.equal(d.reviewPass.required, true);
});

test('an ordinary code change is correctness-scoped', () => {
  assert.equal(route('refactor the retry helper and add tests').reviewPass.scope, 'correctness');
});

test('a task touching credentials is security-scoped', () => {
  const d = route('add a backfill that authenticates with the service-role key and patches rows');
  assert.equal(d.reviewPass.scope, 'security');
});

test('auth, payment, PII and untrusted input each force security scope', () => {
  for (const s of [
    'implement the login authorization check',
    'build the payment webhook that charges the card on file',
    'write an export of customer PII to csv',
    'parse the user-supplied URL before fetching it',
  ]) {
    assert.equal(route(s).reviewPass.scope, 'security', s);
  }
});

test('an explicit security review is security-scoped', () => {
  assert.equal(route('run a security review of the intake endpoint').reviewPass.scope, 'security');
});

test('read-only investigation requires no review pass', () => {
  for (const s of [
    'trace why the report shows the same figure twice',
    'find out what changed last week',
    'summarise the open items',
  ]) assert.equal(route(s).reviewPass, null, s);
});

test('prose work requires no code review pass', () => {
  for (const s of [
    'draft a caption for the launch post',
    'write the newsletter edition',
    'fix the typo in the product description',
  ]) assert.equal(route(s).reviewPass, null, s);
});

test('the log entry carries the review scope', () => {
  const text = 'add a script that patches rows using the service-role key';
  const e = makeLogEntry(text, route(text));
  assert.equal(e.reviewPass.scope, 'security');
});

// ---------------------------------------------------------------------------
// 0.2.0: two models from the SAME PROVIDER are not an independent review.
// The identity guard compared [provider, model], so a second lane on the same
// provider with a different model passed it and the run reported an
// "independent review pass". Different weights from one vendor share training,
// tooling and blind spots, which is the whole reason the pass exists.
// ---------------------------------------------------------------------------

test('a reviewer on the same provider as the worker is refused', () => {
  const cfg = {
    lanes: {
      primary: { provider: 'acme', models: { light: 'a-1', standard: 'a-2', strong: 'a-3', frontier: 'a-4' } },
      reviewer: { provider: 'acme', requiresEnv: [], models: { review: 'a-9' } },
    },
    review: { reviewer: 'reviewer' },
  };
  const d = routeWith('fix the crash in the parser, add tests', { env: FULL_ENV, config: cfg });
  assert.ok(d.reviewPass, 'the requirement must not disappear');
  assert.equal(d.reviewPass.reviewer, null, 'same-provider lane must not be accepted as the reviewer');
  assert.ok(
    d.reviewPass.skipped.some((x) => /same provider/i.test(x.reason)),
    'the skip reason must name the provider clash: ' + JSON.stringify(d.reviewPass.skipped),
  );
});

test('a same-provider clash still demands a manual second pass', () => {
  const cfg = {
    lanes: {
      primary: { provider: 'acme', models: { light: 'a-1', standard: 'a-2', strong: 'a-3', frontier: 'a-4' } },
      reviewer: { provider: 'acme', requiresEnv: [], models: { review: 'a-9' } },
    },
    review: { reviewer: 'reviewer' },
  };
  const d = routeWith('fix the crash in the parser, add tests', { env: FULL_ENV, config: cfg });
  assert.equal(d.reviewPass.required, true);
  assert.ok(d.notes.some((n) => /no second model is available|by hand/i.test(n)), JSON.stringify(d.notes));
});

test('a reviewer on a different provider is still accepted', () => {
  const d = route('fix the crash in the parser, add tests');
  assert.ok(d.reviewPass.reviewer, 'the bundled profile has a different-provider reviewer');
  assert.notEqual(d.reviewPass.reviewer.provider, d.provider);
});


// ---------------------------------------------------------------------------
// Findings from the independent Codex review of the 0.2.0 change itself.
// ---------------------------------------------------------------------------

// P2-1: the trivial-edit guard matched anywhere in the text, so one incidental
// word cancelled the review requirement for a substantive fix. Worst case a
// security fix silently lost its pass because it also renamed something.
test('a trivial keyword does not cancel review of a substantive fix', () => {
  assert.ok(route('fix the authentication bypass and rename the helper').reviewPass,
    'a security fix must keep its pass even when it also renames something');
});

test('a negated trivial instruction does not cancel the pass', () => {
  assert.ok(route('fix the crash in the parser; do not reformat anything').reviewPass);
});

test('a genuinely trivial edit still requires nothing', () => {
  assert.equal(route('fix the typo in the readme').reviewPass, null);
  assert.equal(route('rename the heading in the team wiki note').reviewPass, null);
  assert.equal(route('reformat the config file').reviewPass, null);
});

// P2-2: security vocabulary alone, and the bare word "test", were treated as
// evidence of CODE work, so ordinary business bookkeeping demanded a code review.
test('business bookkeeping is not code work', () => {
  for (const s of [
    'create an invoice for the customer',
    'add a payment to the ledger',
    'write a refund request',
    'export the billing records',
  ]) assert.equal(route(s).reviewPass, null, 'spurious pass for: ' + s);
});

test('the bare word test in a non-code task is not code work', () => {
  assert.equal(route('build a science test for students').reviewPass, null);
});

test('but real code work touching money still requires a security pass', () => {
  const d = route('implement the payment webhook handler that charges the card on file');
  assert.ok(d.reviewPass, 'a webhook handler is code');
  assert.equal(d.reviewPass.scope, 'security');
});

test('a credential-handling script is still caught as security code work', () => {
  const d = route('add a backfill script that authenticates with the service-role key and patches rows');
  assert.ok(d.reviewPass);
  assert.equal(d.reviewPass.scope, 'security');
});

// P2-3: the sanitize/sanitise alternatives ended at a word boundary after the
// bare stem, so the actual words never matched and scope came back correctness.
test('sanitization wording selects security scope', () => {
  for (const s of [
    'sanitize input in the parser',
    'implement input sanitization in the parser',
    'sanitise the user input in the handler',
  ]) assert.equal(route(s).reviewPass.scope, 'security', s);
});

// P2-4: provider equality compared raw labels, so "openai" and "openai-codex"
// read as different vendors and a same-vendor reviewer was accepted.
test('provider labels sharing a vendor prefix count as the same vendor', () => {
  const cfg = {
    lanes: {
      primary: { provider: 'openai', models: { light: 'o-1', standard: 'o-2', strong: 'o-3', frontier: 'o-4' } },
      reviewer: { provider: 'openai-codex', requiresEnv: [], models: { review: 'o-9' } },
    },
    review: { reviewer: 'reviewer' },
  };
  const d = routeWith('fix the crash in the parser, add tests', { env: FULL_ENV, config: cfg });
  assert.ok(d.reviewPass, 'the requirement must not disappear');
  assert.equal(d.reviewPass.reviewer, null, 'openai-codex must not review openai work');
  assert.ok(d.reviewPass.skipped.some((x) => /same provider/i.test(x.reason)), JSON.stringify(d.reviewPass.skipped));
});

test('genuinely different vendors are still accepted', () => {
  const cfg = {
    lanes: {
      primary: { provider: 'acme', models: { light: 'a-1', standard: 'a-2', strong: 'a-3', frontier: 'a-4' } },
      reviewer: { provider: 'globex', requiresEnv: [], models: { review: 'g-9' } },
    },
    review: { reviewer: 'reviewer' },
  };
  const d = routeWith('fix the crash in the parser, add tests', { env: FULL_ENV, config: cfg });
  assert.ok(d.reviewPass.reviewer, 'a different vendor must still be accepted');
  assert.equal(d.reviewPass.reviewer.provider, 'globex');
});


// ---------------------------------------------------------------------------
// Second independent Codex pass, after the first round of fixes. It found the
// first two findings only PARTIALLY closed, and one of my own fixes had opened
// a worse hole than it shut.
// ---------------------------------------------------------------------------

// RR-1: the trivial guard consulted security wording and code-work terms but
// NOT an explicit code signal, so a plain code change plus one trivial word
// still required nothing.
test('an explicit code signal makes a change substantive despite a trivial word', () => {
  assert.ok(route('fix the parser').reviewPass, 'baseline: a parser fix is code work');
  assert.ok(route('fix the parser and rename the helper').reviewPass,
    'a code signal must outweigh an incidental "rename"');
  assert.ok(route('implement pagination in the API; do not reformat anything').reviewPass,
    'a negated "reformat" must not cancel the pass');
});

// RR-2: tightening the keyword list to kill false positives created a WORSE
// false negative. Filename stripping removes the path and extension, so once
// bare "bug", "test", "helper" and "timeout" were gone, an ordinary bug fix in a
// named source file required no review at all. The fix detects the source file
// on the RAW text, before stripping, rather than restoring broad keywords.
test('naming a source file is itself evidence of code work', () => {
  for (const s of [
    'fix the bug in src/retry.js',
    'write a test for src/retry.js',
    'implement the retry helper in src/retry.js',
    'fix the timeout in src/retry.js',
  ]) assert.ok(route(s).reviewPass, 'no pass for: ' + s);
});

test('a named source file survives the content guard', () => {
  // "billing" is business vocabulary, which alone is not code work, but a named
  // source file says this is code and the money wording sets the scope.
  const d = route('implement recurring billing in src/billing.js');
  assert.ok(d.reviewPass, 'a named source file must carry it');
  assert.equal(d.reviewPass.scope, 'security');
});

test('a source DIRECTORY path counts even with no extension', () => {
  assert.ok(route('fix the retry logic in lib/backoff').reviewPass);
});

test('prose files are not source files', () => {
  assert.equal(route('fix the wording in docs/overview.md').reviewPass, null);
  assert.equal(route('update the numbers in reports/q3.csv').reviewPass, null);
});

// RR-3: underscores are valid provider-label characters and were not normalized,
// so "openai" and "openai_codex" still read as different vendors.
test('an underscore provider alias is the same vendor', () => {
  const cfg = {
    lanes: {
      primary: { provider: 'openai', models: { light: 'o-1', standard: 'o-2', strong: 'o-3', frontier: 'o-4' } },
      reviewer: { provider: 'openai_codex', requiresEnv: [], models: { review: 'o-9' } },
    },
    review: { reviewer: 'reviewer' },
  };
  const d = routeWith('fix the crash in the parser, add tests', { env: FULL_ENV, config: cfg });
  assert.ok(d.reviewPass);
  assert.equal(d.reviewPass.reviewer, null, 'openai_codex must not review openai work');
});

// RR-4: rewriting N2's fixture to dodge the new vendor rule lost its original
// point, that identity is a PAIR and not a concatenation. Cover that directly
// with a pair that collides under BOTH a delimiter-free join and a '/' join,
// while the two providers remain genuinely different vendors.
test('reviewer and tie-breaker survive a provider/model string collision', () => {
  const cfg = {
    lanes: {
      primary: { provider: 'zeta', models: { light: 'z-1', standard: 'z-2', strong: 'z-3', frontier: 'z-4' } },
      // Naive concatenation: 'a' + 'b/c' = 'ab/c'; 'ab' + '/c' = 'ab/c'. Same.
      // A '/'-join also collides: 'a/b/c' vs 'ab//c' differ, so both joins are
      // covered by the pair below staying distinct.
      reviewer: { provider: 'acme', requiresEnv: [], models: { review: 'b/c' } },
      'large-context': { provider: 'bravo', requiresEnv: [], models: { reasoning: 'c', fast: 'c' } },
    },
    review: { reviewer: 'reviewer', tieBreaker: 'large-context' },
  };
  const d = routeWith('code review the handler', { env: FULL_ENV, config: cfg });
  assert.equal(d.reviewPass.reviewer.lane, 'reviewer');
  assert.equal(d.reviewPass.tieBreaker.lane, 'large-context',
    'a distinct model was suppressed by a string collision');
});


// ---------------------------------------------------------------------------
// Third independent Codex pass. It confirmed three findings closed and caught
// that the source-file signal I added to fix the second pass had created its
// own false positives, plus two regex defects in it.
// ---------------------------------------------------------------------------

test('a prose file inside a source directory is not code work', () => {
  // The directory matcher accepted ANY leaf, so src/README.md read as source.
  assert.equal(route('fix the wording in src/README.md').reviewPass, null);
  assert.equal(route('update the notes in lib/CHANGELOG.md').reviewPass, null);
});

test('a source extension mid-name does not make a prose file source', () => {
  // The trailing \b matched the ".js" inside "retry.js.md".
  assert.equal(route('fix the wording in docs/retry.js.md').reviewPass, null);
});

test('data, config and markup files alone are not code work', () => {
  for (const s of [
    'export billing records to invoices.json',
    'fix the spelling in translations.yml',
    'write the newsletter in email.html',
  ]) assert.equal(route(s).reviewPass, null, 'spurious pass for: ' + s);
});

test('but a code signal makes a config file code work again', () => {
  assert.ok(route('fix the schema in config.json').reviewPass,
    '"schema" is an explicit code signal regardless of the extension');
});

test('a named source file does not attach a pass to a live-fact lookup', () => {
  const d = route('write a report on current prices using prices.json');
  assert.equal(d.lane, 'research');
  assert.equal(d.reviewPass, null, 'a research-lane lookup is not code work');
});

test('a trivial edit in a real source file still needs no pass', () => {
  // Naming a source file must NOT override the trivial guard: a typo fix in a
  // .go file is noise. Real code evidence elsewhere in the task does override it.
  assert.equal(route('fix the typo in production-deploy.go').reviewPass, null);
  assert.ok(route('fix the typo in the auth token handling').reviewPass,
    'security wording means the trivial word was incidental');
});

test('business money wording alone is never evidence of code', () => {
  // strongCode must consult securityTECHNICAL, not the combined scope matcher:
  // including business terms re-broke the bookkeeping cases.
  assert.equal(route('create an invoice for the customer').reviewPass, null);
  assert.equal(route('write a refund request').reviewPass, null);
});

// Codex demonstrated by mutation that neither the old N2 fixture nor my
// replacement actually detected a '/'-joined identity, because the vendor guard
// masks the original collision. Test the helpers directly instead.
test('identity encodes provider and model as a PAIR, not a joined string', () => {
  // Every pair below collides under SOME naive join but must stay distinct.
  const pairs = [
    [{ provider: 'a', model: 'b/c' }, { provider: 'ab', model: '/c' }],  // ''-join
    [{ provider: 'a', model: 'b/c' }, { provider: 'a/b', model: 'c' }],  // '/'-join
    [{ provider: 'x-y', model: 'z' }, { provider: 'x', model: 'y-z' }],  // '-'-join
  ];
  for (const [p, q] of pairs) {
    assert.notEqual(_identity(p), _identity(q),
      `identity collapsed ${JSON.stringify(p)} and ${JSON.stringify(q)}`);
  }
});

test('identity treats an identical pair as identical', () => {
  assert.equal(_identity({ provider: 'a', model: 'b' }), _identity({ provider: 'a', model: 'b' }));
});

test('vendor reduces a provider label to its root', () => {
  for (const [label, root] of [
    ['openai', 'openai'],
    ['openai-codex', 'openai'],
    ['openai_codex', 'openai'],
    ['openai/codex', 'openai'],
    ['openai:codex', 'openai'],
    ['OpenAI-Codex', 'openai'],
    ['anthropic', 'anthropic'],
  ]) assert.equal(_vendor(label), root, label);
});

test('vendor is documented as over-matching host-style labels', () => {
  // Not a bug, a documented conservative fallback: the cost is a manual second
  // pass, never a false claim of independence. See docs/CONFIGURATION.md.
  assert.equal(_vendor('api.openai.com'), _vendor('api.anthropic.com'));
});


// ---------------------------------------------------------------------------
// Fourth independent Codex pass, scoped as fresh eyes rather than
// re-verification. It found the most serious defect of the four rounds: a
// ROUTING regression, not just a review-pass question.
// ---------------------------------------------------------------------------

// P4-6, the routing regression. SOURCE_EXT gained extensions that stripFilenames
// did not know about, so those filenames were no longer stripped and their words
// leaked into lane and tier selection. "latest" inside "latest.jsx" read as a
// live-fact signal and sent a bug fix to the research lane.
test('a newly recognised source extension is still stripped before classification', () => {
  const d = route('fix the bug in latest.jsx');
  assert.equal(d.lane, 'primary', 'the word "latest" inside a filename must not reach the live-fact rule');
  assert.ok(d.reviewPass);
});

test('filename words do not escalate the tier for any source extension', () => {
  assert.equal(route('fix the bug in production.scala').tier, route('fix the bug in production.js').tier);
  assert.equal(route('fix the bug in latest.vue').lane, 'primary');
});

test('stripFilenames removes every extension hasSourceFile recognises', () => {
  for (const f of ['latest.jsx', 'production.scala', 'current.lua', 'today.vue', 'entire.svelte']) {
    assert.ok(!stripFilenames(`fix the bug in ${f}`).includes(f), 'not stripped: ' + f);
  }
});

// P4-4: ordinary edit verbs were missing from the mutation list entirely, so
// removing a security bug required no review at all.
test('ordinary edit verbs count as mutating code', () => {
  for (const s of [
    'remove the authentication bypass in src/login.js',
    'update the retry logic in src/retry.js',
    'delete the dead branch in src/parser.js',
    'replace the timeout handling in src/fetch.js',
    'revert the change in src/index.js',
  ]) assert.ok(route(s).reviewPass, 'no pass for: ' + s);
});

// P4-3: a NEGATED trivial word cancelled a substantive change. The trivial guard
// now only fires when the trivial word is the actual action.
test('a negated trivial instruction does not cancel the requirement', () => {
  assert.ok(route('fix the bug in src/retry.js; do not rename anything').reviewPass);
  assert.ok(route('implement the parser; avoid reformatting').reviewPass);
});

test('but an un-negated trivial edit still suppresses it', () => {
  assert.equal(route('fix the typo in production-deploy.go').reviewPass, null);
  assert.equal(route('rename the heading in the team wiki note').reviewPass, null);
});

// P4-5: the content guard ran before source evidence, so ordinary software
// vocabulary suppressed real implementation work.
test('a named source file survives ordinary content vocabulary', () => {
  assert.ok(route('fix the copy loop in src/copy.ts').reviewPass,
    '"copy" is a content term but this is implementation work in a source file');
});

// P4-7: only the FIRST source-directory candidate was examined, so an excluded
// prose path masked a valid source path after it.
test('every source-directory candidate is examined, not just the first', () => {
  assert.ok(route('fix the bug in src/README.md and lib/backoff').reviewPass);
  assert.ok(route('update docs/notes.md then src/retry.js').reviewPass);
});

test('a prose path alone is still not source', () => {
  assert.equal(route('fix the wording in src/README.md and docs/guide.md').reviewPass, null);
});

// Re-entrancy: the strip regex is module-level with /g, so a stale lastIndex
// would make results depend on call order.
test('repeated calls are stable, no lastIndex carryover', () => {
  const t = 'fix the bug in latest.jsx';
  const first = stripFilenames(t);
  for (let i = 0; i < 5; i++) assert.equal(stripFilenames(t), first);
  const a = route(t).lane;
  route('fix the bug in other.scala');
  assert.equal(route(t).lane, a);
});
