// Path-based forced review.
//
// The text classifier misses 45% of review-worthy tasks on a blind set, and the
// misses are dominated by phrasing it has never seen. A file path is a far
// stronger and far more stable signal than prose: "migrations/002_add_users.sql"
// means the same thing however the sentence around it is worded.
//
// So a task that names a HIGH-RISK path forces the review pass outright,
// bypassing the scoring entirely. It cannot be talked out of it by a trivial
// word, a content word, or a missing verb.
//
// THE DESIGN RULE, and the reason this is worth having: match PATHS and
// FILENAMES, never bare prose words. "the auth migration milestone" is a project
// management sentence. "src/auth/session.ts" is a risk surface. If this matcher
// starts firing on bare words it has become the same fragile text classifier it
// exists to bypass, and it will fire on release notes and meeting agendas.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskSurface } from '../src/strip.js';
import { route as routeWith } from '../src/router.js';

const ENV = { PERPLEXITY_API_KEY: 'test-placeholder', GEMINI_API_KEY: 'test-placeholder' };
const route = (t) => routeWith(t, { env: ENV });

// ---------- the matcher itself ----------

test('database migrations are a risk surface', () => {
  for (const s of [
    'migrations/002_add_users.sql',
    'db/migrate/20260101_add_index.rb',
    'alembic/versions/ab12_add_column.py',
    'update supabase/migrations/0007_rls.sql',
  ]) assert.ok(riskSurface(s), 'missed: ' + s);
});

test('auth and session modules are a risk surface', () => {
  for (const s of [
    'src/auth/session.ts',
    'lib/authentication/login.py',
    'app/middleware/auth.js',
    'internal/rbac/policy.go',
  ]) assert.ok(riskSurface(s), 'missed: ' + s);
});

test('dependency manifests and lockfiles are a risk surface', () => {
  for (const s of [
    'bump the version in package.json',
    'package-lock.json',
    'requirements.txt',
    'go.mod',
    'Cargo.lock',
    'yarn.lock',
    'Gemfile.lock',
  ]) assert.ok(riskSurface(s), 'missed: ' + s);
});

test('CI, container and infrastructure definitions are a risk surface', () => {
  for (const s of [
    '.github/workflows/deploy.yml',
    'Dockerfile',
    'docker-compose.yml',
    'infra/main.tf',
    'terraform/prod/network.tf',
    'k8s/ingress.yaml',
    'nginx.conf',
  ]) assert.ok(riskSurface(s), 'missed: ' + s);
});

test('secret and credential files are a risk surface', () => {
  for (const s of ['.env', '.env.production', 'config/credentials.yml', 'secrets/keystore.p12']) {
    assert.ok(riskSurface(s), 'missed: ' + s);
  }
});

test('the matcher names WHICH surface matched, for the audit trail', () => {
  assert.equal(riskSurface('migrations/002_add_users.sql'), 'database migration');
  assert.equal(riskSurface('src/auth/session.ts'), 'authentication or authorization');
  assert.equal(riskSurface('package-lock.json'), 'dependency manifest');
});

// ---------- the discipline: prose must NOT fire ----------

test('bare prose words are NOT a risk surface', () => {
  for (const s of [
    'Invoice reconciliation for September. The vendor called the line item auth migration.',
    'Write a meeting agenda for discussing code review turnaround and branch ownership.',
    'Draft an agenda for next week security review meeting.',
    'A better title for the essay Who owns authentication?',
    'Explain our authorization model to the new hire.',
    'The migration to the new office is next month.',
    'Write release notes about the docker rollout.',
  ]) assert.equal(riskSurface(s), null, 'false fire on: ' + s);
});

test('an ordinary source file is not by itself a risk surface', () => {
  assert.equal(riskSurface('src/retry.js'), null);
  assert.equal(riskSurface('fix the bug in worker.ts'), null);
});

// ---------- routing behaviour ----------

test('a risk path forces the review pass with security scope', () => {
  const d = route('migrations/002_add_users.sql');
  assert.ok(d.reviewPass, 'a named migration must force the pass');
  assert.equal(d.reviewPass.scope, 'security');
});

test('a risk path cannot be talked out of it by a trivial word', () => {
  // The whole point. "just a typo" in an auth module still gets reviewed.
  const d = route('fix the typo in src/auth/session.ts');
  assert.ok(d.reviewPass, 'trivial wording must not cancel a risk surface');
  assert.equal(d.reviewPass.scope, 'security');
});

test('a risk path cannot be talked out of it by content vocabulary', () => {
  assert.ok(route('update the copy in .github/workflows/deploy.yml').reviewPass);
});

test('a risk path does not need a verb at all', () => {
  // Verb-less tickets were the largest single cause of missed reviews.
  assert.ok(route('package-lock.json, 40 transitive bumps').reviewPass);
});

test('the decision names the risk surface in its notes, so it is auditable', () => {
  const d = route('bump a dependency in package.json');
  assert.ok(d.reviewPass);
  assert.ok(
    d.notes.some((n) => /risk surface/i.test(n) && /dependency manifest/i.test(n)),
    'expected a note naming the surface: ' + JSON.stringify(d.notes),
  );
});

test('an explicit read-only task still does NOT force the pass', () => {
  // Gemini's arbitration was specific: force review when a risk surface is
  // MODIFIED. Reading one is not modifying it, and forcing review on every
  // mention would train users to ignore the gate.
  assert.equal(route('explain what migrations/002_add_users.sql does, do not change anything').reviewPass, null);
  assert.equal(route('which commit last touched src/auth/session.ts? read-only, just find it').reviewPass, null);
});

test('forcing on a risk path does not change the lane or tier', () => {
  // The review pass is supplementary. It must not silently buy a bigger model.
  const plain = route('bump the version');
  const risky = route('bump the version in package.json');
  assert.equal(risky.lane, plain.lane);
  assert.ok(risky.reviewPass);
});
