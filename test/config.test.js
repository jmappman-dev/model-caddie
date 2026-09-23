// Config, provider-profile, availability, review-pass, log, and CLI tests.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, prepare } from '../src/router.js';
import { validateConfig, compileConfig, loadProfile, resolveConfig, listProfiles, ConfigError } from '../src/config.js';
import { makeLogEntry } from '../src/log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'model-caddie.js');
const FULL_ENV = { PERPLEXITY_API_KEY: 'test-placeholder', GEMINI_API_KEY: 'test-placeholder', ANTHROPIC_API_KEY: 'test-placeholder' };
const anthropic = () => loadProfile('anthropic');

// --- profiles ------------------------------------------------------------------

test('every bundled profile validates and compiles', () => {
  for (const name of listProfiles()) {
    assert.doesNotThrow(() => compileConfig(loadProfile(name)), `profile ${name} failed to compile`);
  }
});

test('no bundled profile carries anything that looks like a secret', () => {
  for (const name of listProfiles()) {
    const text = JSON.stringify(loadProfile(name));
    assert.ok(!/sk-[A-Za-z0-9]|AIza|ghp_|xox[bp]-|Bearer\s/i.test(text), `profile ${name} contains a key-shaped string`);
  }
});

test('an OpenAI-primary profile routes the ladder onto OpenAI models', () => {
  const config = prepare(loadProfile('openai'));
  const d = route('refactor error handling across the codebase', { config, env: FULL_ENV });
  assert.equal(d.lane, 'primary');
  assert.equal(d.provider, 'openai');
  assert.equal(d.tier, 'strong');
  assert.equal(d.model, loadProfile('openai').lanes.primary.models.strong);
});

test('an OpenAI-primary profile uses Claude as the independent reviewer', () => {
  const config = prepare(loadProfile('openai'));
  const d = route('do a code review of the intake handler', { config, env: FULL_ENV });
  assert.equal(d.provider, 'openai');
  assert.equal(d.reviewPass.reviewer.provider, 'anthropic');
  assert.equal(d.reviewPass.tieBreaker.provider, 'google');
});

test('profile aliases change the override vocabulary', () => {
  const config = prepare(loadProfile('openai'));
  const d = route('use claude to look this over', { config, env: FULL_ENV });
  assert.equal(d.lane, 'reviewer', 'in the openai profile "claude" names the reviewer lane');
  const o = route('use opus for this outline', { config, env: FULL_ENV });
  assert.notEqual(o.rule, 'R1-override', '"opus" is not a word this profile knows');
});

test('a fully local profile routes everything locally and needs no keys', () => {
  const config = prepare(loadProfile('ollama'));
  const d = route('summarize the entire repo', { config, env: {} });
  assert.equal(d.lane, 'primary');
  assert.equal(d.provider, 'ollama');
  assert.equal(d.rule, 'R4-large-unavailable');
  assert.equal(route('what is the current 10-year treasury yield', { config, env: {} }).provider, 'ollama');
});

// --- availability: missing keys --------------------------------------------------

test('routing works with no API keys set at all', () => {
  const d = route('add a retry wrapper to the fetch call', { env: {} });
  assert.equal(d.lane, 'primary');
  assert.equal(d.tier, 'standard');
});

test('a live-fact task with no research key stays on the primary lane and names the missing variable', () => {
  const d = route('what is the current 10-year treasury yield', { env: {} });
  assert.equal(d.lane, 'primary');
  assert.equal(d.rule, 'R3-live-unavailable');
  assert.ok(d.notes.some((n) => /verif/i.test(n)), 'an unsourced live fact must be flagged for verification');
});

test('an override to an unavailable lane says which env var is missing, and never prints a value', () => {
  const d = route('use gemini to summarize the meeting transcript', { env: { PERPLEXITY_API_KEY: 'sk-should-never-appear' } });
  assert.equal(d.lane, 'primary');
  const note = d.notes.find((n) => /not honored/i.test(n));
  assert.ok(note && note.includes('GEMINI_API_KEY'), 'the note must name the missing variable');
  assert.ok(!JSON.stringify(d).includes('sk-should-never-appear'), 'a key value leaked into the decision');
});

test('an empty-string key counts as missing', () => {
  const d = route('use perplexity to check the latest news', { env: { PERPLEXITY_API_KEY: '' } });
  assert.equal(d.lane, 'primary');
});

test('a disabled lane is never routed to', () => {
  const cfg = anthropic();
  cfg.lanes['large-context'].enabled = false;
  const d = route('summarize the entire repo', { config: prepare(cfg), env: FULL_ENV });
  assert.equal(d.lane, 'primary');
  assert.equal(d.rule, 'R4-large-unavailable');
});

test('consensus drops unavailable legs and says why', () => {
  const d = route('get a second opinion on this plan', { env: {} });
  assert.deepEqual(d.legs, ['primary', 'reviewer']);
  assert.ok(d.notes.some((n) => /PERPLEXITY_API_KEY/.test(n) && /GEMINI_API_KEY/.test(n)));
});

// --- review pass is config-driven ------------------------------------------------

test('the reviewer and tie-breaker come from config', () => {
  const cfg = anthropic();
  cfg.review = { reviewer: 'large-context', tieBreaker: 'research', fallback: null };
  const d = route('code review the scheduler changes', { config: prepare(cfg), env: FULL_ENV });
  assert.equal(d.reviewPass.reviewer.lane, 'large-context');
  assert.equal(d.reviewPass.tieBreaker.lane, 'research');
});

test('an unavailable reviewer falls back, and the skip reason names the env var', () => {
  const cfg = anthropic();
  cfg.lanes.reviewer.requiresEnv = ['OPENAI_API_KEY'];
  const d = route('code review the scheduler changes', { config: prepare(cfg), env: FULL_ENV });
  assert.equal(d.reviewPass.reviewer.lane, 'large-context');
  assert.ok(d.reviewPass.skipped[0].reason.includes('OPENAI_API_KEY'));
});

test('with no second model configured, a review still requires a manual second pass', () => {
  const config = prepare(loadProfile('claude-code-only'));
  const d = route('security review the token handling code', { config, env: {} });
  assert.ok(d.reviewPass, 'the requirement must survive a single-provider setup');
  assert.equal(d.reviewPass.reviewer, null);
  assert.ok(d.notes.some((n) => /by hand/i.test(n)));
  assert.equal(d.reviewPass.protocol.length, 4);
});

test('the review pass can be switched off in config', () => {
  const cfg = anthropic();
  cfg.review.enabled = false;
  assert.equal(route('code review the scheduler changes', { config: prepare(cfg), env: FULL_ENV }).reviewPass, null);
});

test('the review protocol tells the reviewer to work independently', () => {
  const d = route('code review the scheduler changes', { env: FULL_ENV });
  assert.ok(d.reviewPass.protocol.some((s) => /independently/i.test(s)));
});

// --- validation ----------------------------------------------------------------------

test('validation rejects a config with a key VALUE where an env var NAME belongs', () => {
  const cfg = anthropic();
  cfg.lanes.research.requiresEnv = ['pplx-1234567890abcdef'];
  assert.throws(() => validateConfig(cfg), ConfigError);
});

test('validation rejects a missing tier, an unknown lane, and a bad alias', () => {
  const a = anthropic(); delete a.lanes.primary.models.strong;
  assert.throws(() => validateConfig(a), /models\.strong/);
  const b = anthropic(); b.lanes.bogus = b.lanes.research;
  assert.throws(() => validateConfig(b), /unknown lane/);
  const c = anthropic(); c.aliases['(evil|.*)'] = 'primary';
  assert.throws(() => validateConfig(c), /alias/);
  const d = anthropic(); d.aliases.gpt = 'primary:turbo';
  assert.throws(() => validateConfig(d), /named tiers/);
});

test('validation refuses a primary lane that needs keys or can be disabled', () => {
  const a = anthropic(); a.lanes.primary.requiresEnv = ['ANTHROPIC_API_KEY'];
  assert.throws(() => validateConfig(a), /primary lane cannot require/);
  const b = anthropic(); b.lanes.primary.enabled = false;
  assert.throws(() => validateConfig(b), /cannot be disabled/);
});

test('signal term lists are configurable and validated', () => {
  const cfg = anthropic();
  cfg.signals = { sensitiveTerms: ['member'], contentTerms: ['press release'] };
  const d = route('draft a welcome note for member Sam', { config: prepare(cfg), env: FULL_ENV });
  assert.ok(d.notes.some((n) => /sensitive/i.test(n)));
  const bad = anthropic(); bad.signals = { sensitiveTerms: ['a|b)'] };
  assert.throws(() => validateConfig(bad), /signals\.sensitiveTerms/);
});

test('config resolution prefers an explicit path, then the env var, then a local file, then a profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-'));
  const local = anthropic(); local.name = 'local-file';
  writeFileSync(join(dir, 'model-caddie.config.json'), JSON.stringify(local));
  assert.equal(resolveConfig({ cwd: dir, env: {} }).raw.name, 'local-file');
  const viaEnv = anthropic(); viaEnv.name = 'via-env';
  writeFileSync(join(dir, 'other.json'), JSON.stringify(viaEnv));
  assert.equal(resolveConfig({ cwd: dir, env: { MODEL_CADDIE_CONFIG: 'other.json' } }).raw.name, 'via-env');
  assert.equal(resolveConfig({ cwd: dir, env: {}, configPath: 'other.json' }).raw.name, 'via-env');
  const empty = mkdtempSync(join(tmpdir(), 'mr-'));
  assert.equal(resolveConfig({ cwd: empty, env: {}, profile: 'ollama' }).raw.name, 'ollama');
});

test('an unknown profile and malformed JSON both fail with a clear ConfigError', () => {
  assert.throws(() => loadProfile('nope'), /unknown profile/);
  const dir = mkdtempSync(join(tmpdir(), 'mr-'));
  writeFileSync(join(dir, 'bad.json'), '{ not json');
  assert.throws(() => resolveConfig({ cwd: dir, env: {}, configPath: 'bad.json' }), /not valid JSON/);
});

// --- log -------------------------------------------------------------------------------

test('taskText "omit" keeps task text out of the log entirely', () => {
  const t = 'draft a note to client Jane at jane@example.com';
  const entry = makeLogEntry(t, route(t, { env: FULL_ENV }), { taskText: 'omit' });
  assert.equal(entry.task, null);
  assert.ok(!JSON.stringify(entry).includes('jane@example.com'));
});

test('the log records who reviews and who arbitrates', () => {
  const t = 'code review the scheduler changes';
  const entry = makeLogEntry(t, route(t, { env: FULL_ENV }));
  assert.deepEqual(entry.reviewPass, { scope: 'correctness', reviewer: 'reviewer', tieBreaker: 'large-context', skipped: [] });
});

// --- CLI -------------------------------------------------------------------------------

const cli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...opts.env }, cwd: opts.cwd || mkdtempSync(join(tmpdir(), 'mr-')) });

test('the CLI routes with no config and no keys', () => {
  const r = cli(['rename the heading in the team wiki note']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /route: primary \/ light/);
});

test('the CLI prints the review pass for a review task', () => {
  const r = cli(['code review the scheduler changes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /review pass \((?:correctness|security)\): openai-codex/);
});

test('the CLI --json output parses and --log writes to the configured path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-'));
  const r = cli(['--json', '--log', 'fix the typo in the header'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision.tier, 'light');
  const logFile = join(dir, '.model-caddie', 'decisions.jsonl');
  assert.ok(existsSync(logFile));
  assert.equal(JSON.parse(readFileSync(logFile, 'utf8').trim()).rule, 'R5-primary-ladder');
});

test('the CLI exits 2 with a readable message on a bad config, and 1 with no task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-'));
  writeFileSync(join(dir, 'model-caddie.config.json'), '{"lanes": {}}');
  const bad = cli(['anything'], { cwd: dir });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid router config/);
  assert.equal(cli([]).status, 1);
});

test('--check-config reports lane availability by env var NAME only', () => {
  const r = cli(['--check-config'], { env: { GEMINI_API_KEY: 'sk-secret-value-123' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /research\s+perplexity\s+unavailable \(set PERPLEXITY_API_KEY\)/);
  assert.match(r.stdout, /large-context\s+google\s+available/);
  assert.ok(!r.stdout.includes('sk-secret-value-123'));
});

test('--profile selects a bundled profile', () => {
  const r = cli(['--profile', 'ollama', 'refactor error handling across the codebase']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /qwen2\.5:32b/);
});
