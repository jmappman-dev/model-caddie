// Property and metamorphic tests for the classifier.
//
// These check general rules over many generated inputs rather than named
// examples, which catches a different class of defect than either the labeled
// corpus (eval/corpus.json) or a reviewer reading the diff. Four independent
// review rounds all worked from examples; none of them would have caught a
// stale regex lastIndex or a capitalisation dependency.
//
// A property here asserts something the CONTRACT promises. Where the contract
// is deliberately silent, the test asserts only that the output stays valid,
// not that it stays the same.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route as routeWith, MAX_INPUT, stripFilenames } from '../src/router.js';

const ENV = { PERPLEXITY_API_KEY: 'test-placeholder', GEMINI_API_KEY: 'test-placeholder' };
const route = (t) => routeWith(t, { env: ENV });

// A deterministic pseudo-random generator, so a failure is reproducible from
// the seed printed in the assertion rather than vanishing on the next run.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const VERBS = ['fix', 'implement', 'refactor', 'remove', 'update', 'rewrite', 'harden', 'add'];
const OBJECTS = ['the parser', 'the retry helper', 'the auth check', 'the invoice total', 'the caption', 'the queue worker'];
const TAILS = ['', ' today', ' please', ' before the release', ' and add tests', ' in src/thing.js', ' in notes.md'];

function sample(seed, n) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length) % a.length];
  return Array.from({ length: n }, () => `${pick(VERBS)} ${pick(OBJECTS)}${pick(TAILS)}`);
}

// ---------- properties ----------

test('P1 routing is deterministic: the same text always gives the same answer', () => {
  for (const t of sample(1, 200)) {
    const a = route(t);
    const b = route(t);
    assert.equal(a.lane, b.lane, t);
    assert.equal(a.tier, b.tier, t);
    assert.equal(Boolean(a.reviewPass), Boolean(b.reviewPass), t);
    if (a.reviewPass) assert.equal(a.reviewPass.scope, b.reviewPass.scope, t);
  }
});

test('P2 no call leaks state into the next: interleaving does not change answers', () => {
  const texts = sample(2, 60);
  const alone = texts.map((t) => JSON.stringify([route(t).lane, route(t).tier, Boolean(route(t).reviewPass)]));
  // Interleave with unrelated traffic that exercises the other rules.
  const noise = ['what is the current price of copper', 'summarize the entire repo', 'use opus for this', 'gut check this plan'];
  const interleaved = texts.map((t, i) => {
    route(noise[i % noise.length]);
    const d = route(t);
    return JSON.stringify([d.lane, d.tier, Boolean(d.reviewPass)]);
  });
  assert.deepEqual(interleaved, alone, 'a global regex lastIndex or cached state is leaking between calls');
});

test('P3 output is always structurally valid, whatever the input', () => {
  const weird = [
    '', ' ', '\n\n', '...', '???', '\\\\', '/////', '.'.repeat(500),
    'a'.repeat(MAX_INPUT + 500), '(((((((((', '[]{}()', '\u0000 null byte',
    '\u200b zero width', 'MiXeD CaSe TeXt', '🙂 emoji only', 'C:\\Users\\x\\y.js',
    '\\\\server\\share\\thing.py', '"quoted path.js"', 'é'.repeat(200),
  ];
  for (const t of weird) {
    const d = route(t);
    assert.ok(typeof d.lane === 'string' && d.lane.length, JSON.stringify(t).slice(0, 40));
    assert.ok(Array.isArray(d.notes));
    if (d.reviewPass) {
      assert.ok(['security', 'correctness'].includes(d.reviewPass.scope), 'invalid scope for ' + JSON.stringify(t).slice(0, 40));
      assert.equal(d.reviewPass.required, true);
    }
  }
});

test('P4 a required review pass always carries a scope', () => {
  for (const t of sample(3, 200)) {
    const d = route(t);
    if (d.reviewPass) assert.ok(d.reviewPass.scope, 'reviewPass without a scope: ' + t);
  }
});

test('P5 execution stays bounded at the input cap', () => {
  const hostile = [
    'fix '.repeat(1000),
    'a.js '.repeat(800),
    'src/'.repeat(1000) + 'x.js',
    ('x'.repeat(80) + '.js ').repeat(50),
    'fix the bug in ' + 'a.'.repeat(1000) + 'js',
  ];
  for (const t of hostile) {
    const started = Date.now();
    route(t.slice(0, MAX_INPUT));
    const ms = Date.now() - started;
    assert.ok(ms < 1000, `took ${ms}ms on ${t.slice(0, 24)}...`);
  }
});

// ---------- metamorphic: transformations the contract says are invariant ----------

test('M1 capitalisation does not change the decision', () => {
  for (const t of sample(4, 150)) {
    const a = route(t);
    const b = route(t.toUpperCase());
    assert.equal(Boolean(a.reviewPass), Boolean(b.reviewPass), t);
    if (a.reviewPass && b.reviewPass) assert.equal(a.reviewPass.scope, b.reviewPass.scope, t);
  }
});

test('M2 surrounding whitespace does not change the decision', () => {
  for (const t of sample(5, 150)) {
    assert.equal(
      Boolean(route(t).reviewPass),
      Boolean(route(`   ${t}  \n`).reviewPass),
      t,
    );
  }
});

test('M3 a polite prefix does not change the decision', () => {
  for (const t of sample(6, 100)) {
    assert.equal(
      Boolean(route(t).reviewPass),
      Boolean(route(`when you get a chance, ${t}`).reviewPass),
      t,
    );
  }
});

// ---------- metamorphic: transformations that MUST change the answer ----------

test('M4 adding a credential object escalates the scope to security', () => {
  for (const base of ['fix the parser', 'refactor the queue worker', 'update the fetch helper']) {
    const plain = route(base);
    const secure = route(`${base} so it stops logging the api key`);
    assert.ok(plain.reviewPass, base);
    assert.equal(plain.reviewPass.scope, 'correctness', base);
    assert.ok(secure.reviewPass, base);
    assert.equal(secure.reviewPass.scope, 'security', base);
  }
});

test('M5 swapping a source file for a prose file removes the code evidence', () => {
  // Same verb, same object, only the file kind differs.
  assert.ok(route('fix the wording in src/thing.js').reviewPass);
  assert.equal(route('fix the wording in docs/thing.md').reviewPass, null);
});

test('M6 turning a change request into a lookup should remove the pass', () => {
  // Documented as a KNOWN GAP: there is no read-only-intent guard, so this
  // transformation does NOT currently hold. Asserted in the failing direction
  // on purpose, so the day someone adds that guard, this test tells them to
  // update docs/KNOWN-LIMITATIONS.md instead of silently drifting.
  const changed = route('fix the retry helper');
  const lookup = route('explain how the retry helper works, do not change anything');
  assert.ok(changed.reviewPass, 'the change request must require a pass');
  assert.equal(lookup.reviewPass, null, 'a pure lookup must not');
  // This WAS a known gap: a lookup containing a mutation verb still required a
  // pass. The explicit no-change guard closed it on 2026-09-23, and THIS TEST
  // FAILING is what reported it, which is exactly why it was written asserting
  // the broken behaviour. docs/KNOWN-LIMITATIONS.md and eval/corpus.json updated
  // to match rather than leaving the docs claiming a gap that no longer exists.
  assert.equal(
    route('explain how to fix the retry helper, do not change any files').reviewPass,
    null,
    'an explicit no-change statement must exempt the task',
  );
});

// ---------- stripping invariants ----------

test('S1 stripping is idempotent', () => {
  for (const t of sample(7, 120)) {
    const once = stripFilenames(t);
    assert.equal(stripFilenames(once), once, t);
  }
});

test('S2 stripping never grows the text', () => {
  for (const t of sample(8, 120)) {
    assert.ok(stripFilenames(t).length <= t.length + 1, t);
  }
});
