// Regression tests for findings from the independent Codex review (F*) and the
// security review (S*) before the first public release. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, prepare, parseOverride } from '../src/router.js';
import { validateConfig, loadProfile, resolveConfig } from '../src/config.js';
import { makeLogEntry, appendLog } from '../src/log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'model-caddie.js');
const FULL_ENV = { PERPLEXITY_API_KEY: 'test-placeholder', GEMINI_API_KEY: 'test-placeholder', ANTHROPIC_API_KEY: 'test-placeholder' };
const r = (t, config) => route(t, { env: FULL_ENV, config });
const anthropic = () => loadProfile('anthropic');
const tmp = () => mkdtempSync(join(tmpdir(), 'mr-'));
const cli = (args, cwd = tmp(), env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: { PATH: process.env.PATH, ...env } });

// --- F1: a code review never loses its review pass to an earlier rule ----------

test('F1 a code review mentioning "latest" stays a review on the primary lane', () => {
  const d = r('code review the latest patch');
  assert.equal(d.lane, 'primary');
  assert.ok(d.reviewPass);
});

test('F1 an explicit override on a code review keeps the pass, with a different model reviewing', () => {
  const d = r('use gemini to do a code review of the handler');
  assert.equal(d.lane, 'large-context');
  assert.ok(d.reviewPass, 'naming a lane does not waive the independent pass');
  assert.notEqual(d.reviewPass.reviewer.lane, 'large-context', 'the executing lane cannot review itself');
});

test('F1 a consensus code review still carries the review pass', () => {
  const d = r('get a second opinion on this code review of the parser');
  assert.equal(d.lane, 'consensus');
  assert.ok(d.reviewPass);
});

test('F1 a live-fact review with no code signal is still not a code review', () => {
  assert.equal(r("security review of today's market conditions").reviewPass, null);
});

// --- F2: comma plus a repeated verb keeps the negated list ------------------------

test('F2 "do not use codex, or ask gemini" declines both', () => {
  const d = r('do not use codex, or ask gemini to review this code');
  assert.deepEqual(d.declined, ['reviewer', 'large-context']);
  assert.equal(d.lane, 'primary');
});

test('F2 a comma followed by "and use" is still a fresh affirmative clause', () => {
  const d = r('do not use codex, and use gemini to summarize this');
  assert.equal(d.lane, 'large-context');
});

// --- F3: empty signal lists match nothing -----------------------------------------------

test('F3 empty signal lists never match', () => {
  const cfg = anthropic();
  cfg.signals = { sensitiveTerms: [], contentTerms: [] };
  const config = prepare(cfg);
  assert.ok(r('design review the event layer', config).reviewPass, 'an empty content list must not suppress reviews');
  assert.ok(!r('rename a heading', config).notes.some((n) => /sensitive/i.test(n)));
  assert.ok(r('email jane@example.com about it', config).notes.some((n) => /sensitive/i.test(n)), 'the email detector still works');
});

// --- F4: every alias validation accepts must be matchable ----------------------------------

test('F4 aliases must start and end with a letter or digit', () => {
  const cfg = anthropic();
  cfg.aliases['gpt+'] = 'large-context';
  assert.throws(() => validateConfig(cfg), /alias/);
  const ok = anthropic();
  ok.aliases['gpt-4.1'] = 'large-context';
  assert.equal(parseOverride('use gpt-4.1 here', { config: prepare(ok) }).target.lane, 'large-context');
});

// --- F5: booleans are validated, not coerced ----------------------------------------------

test('F5 a non-boolean "enabled" is rejected', () => {
  const a = anthropic(); a.lanes['large-context'].enabled = 'false';
  assert.throws(() => validateConfig(a), /enabled must be true or false/);
  const b = anthropic(); b.review.enabled = 'no';
  assert.throws(() => validateConfig(b), /enabled must be true or false/);
});

// --- F6: the reviewer must be a different model from the one doing the work -----------

test('F6 a reviewer resolving to the executing model is skipped', () => {
  const cfg = anthropic();
  cfg.lanes.reviewer = { provider: 'anthropic', requiresEnv: [], models: { review: cfg.lanes.primary.models.strong } };
  const d = r('code review the handler', prepare(cfg));
  assert.equal(d.tier, 'strong');
  assert.equal(d.reviewPass.reviewer.lane, 'large-context', 'fell back past the identical model');
  assert.ok(d.reviewPass.skipped.some((x) => x.lane === 'reviewer' && /same model/i.test(x.reason)));
});

test('F6 a tie-breaker resolving to the reviewer model is skipped', () => {
  const cfg = anthropic();
  cfg.lanes['large-context'].models.reasoning = 'shared-model';
  cfg.lanes['large-context'].provider = 'same';
  cfg.lanes.reviewer = { provider: 'same', requiresEnv: [], models: { review: 'shared-model' } };
  const d = r('code review the handler', prepare(cfg));
  assert.equal(d.reviewPass.tieBreaker, null);
  assert.ok(d.reviewPass.skipped.some((x) => x.lane === 'large-context' && /same model/i.test(x.reason)));
});

// --- F7: unknown CLI flags fail loudly ---------------------------------------------------

test('F7 a misspelled flag is an error, not a silent default', () => {
  const res = cli(['--profiel', 'ollama', 'rename a heading']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown option --profiel/);
});

test('F7 "--" passes a literal task that starts with dashes', () => {
  const res = cli(['--', '--weird task: rename a heading']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /route: primary \/ light/);
});

// --- S1: the log cannot be pointed outside the working directory by a config ---------

test('S1 a config log.path that is absolute or escapes the working directory is rejected', () => {
  for (const p of ['../outside.jsonl', '/etc/evil.jsonl', 'C:/Users/x/evil.jsonl', 'logs/../../x.jsonl']) {
    const cfg = anthropic(); cfg.log = { path: p };
    assert.throws(() => validateConfig(cfg), /log\.path/, `accepted ${p}`);
  }
});

test('S1 a log path must end in .jsonl', () => {
  const cfg = anthropic(); cfg.log = { path: 'home/.bashrc' };
  assert.throws(() => validateConfig(cfg), /\.jsonl/);
});

test('S1 appendLog refuses to write into an existing non-JSONL file', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'x.jsonl'), 'export PATH=/evil\n');
  assert.throws(() => appendLog({ a: 1 }, 'x.jsonl', dir), /not a JSONL log/);
  assert.equal(readFileSync(join(dir, 'x.jsonl'), 'utf8'), 'export PATH=/evil\n');
});

test('S1 appendLog refuses a path outside the working directory even when called directly', () => {
  assert.throws(() => appendLog({ a: 1 }, '../escape.jsonl', tmp()), /outside the working directory/);
});

// --- S2: pathological input finishes fast ---------------------------------------------------

test('S2 50k-character pathological inputs route in well under a second', () => {
  for (const s of ['a.'.repeat(25000), 'a-'.repeat(25000), 'a.b'.repeat(16666), 'a'.repeat(50000), '1'.repeat(50000)]) {
    const t0 = performance.now();
    r(s);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `took ${Math.round(ms)}ms on ${JSON.stringify(s.slice(0, 6))}...`);
  }
});

test('S2 very long input is truncated with a note', () => {
  const d = r('fix the typo. ' + 'x '.repeat(10000));
  assert.ok(d.notes.some((n) => /truncated/i.test(n)));
});

// --- S3: config strings cannot carry control characters to stdout ------------------------

test('S3 provider and model names are restricted to a safe character set', () => {
  const a = anthropic(); a.lanes.primary.provider = 'x$(touch pwned)';
  assert.throws(() => validateConfig(a), /provider/);
  const b = anthropic(); b.lanes.primary.models.light = 'model\u001b[31m';
  assert.throws(() => validateConfig(b), /models\.light/);
});

test('S3 dispatch templates reject control characters and are length-capped', () => {
  const a = anthropic(); a.lanes.primary.dispatch = 'run \u001b[31mthis';
  assert.throws(() => validateConfig(a), /dispatch/);
  const b = anthropic(); b.lanes.primary.dispatch = 'x'.repeat(301);
  assert.throws(() => validateConfig(b), /dispatch/);
});

// --- S4: the CLI always says which config it used ----------------------------------------

test('S4 the CLI prints its config source on every run', () => {
  const res = cli(['rename a heading']);
  assert.match(res.stdout, /^config: profile:anthropic/m);
});

// --- S5: sensitive task text is kept out of the log by default --------------------------

test('S5 truncate mode redacts task text when the sensitive-data signal fires', () => {
  const t = 'email bob@example.com about the renewal';
  const e = makeLogEntry(t, r(t));
  assert.equal(e.task, null);
  assert.equal(e.taskRedacted, true);
  const plain = makeLogEntry('rename a heading', r('rename a heading'));
  assert.equal(plain.task, 'rename a heading');
});

// --- S6: a JSON parse error never echoes file content -------------------------------------

test('S6 a malformed config reports a position, never the file content', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'tok.json'), 'ghp_FAKEtoken1234567890');
  try {
    resolveConfig({ cwd: dir, env: {}, configPath: 'tok.json' });
    assert.fail('expected a ConfigError');
  } catch (e) {
    assert.match(e.message, /not valid JSON/);
    assert.ok(!e.message.includes('ghp_'), `leaked content: ${e.message}`);
  }
});

// --- S7: an outside lane must say explicitly whether it needs a key -----------------------

test('S7 a non-primary lane without a requiresEnv key is rejected', () => {
  const cfg = anthropic(); delete cfg.lanes.research.requiresEnv;
  assert.throws(() => validateConfig(cfg), /requiresEnv/);
});

test('S7 --check-config labels a lane with no env check as assumed available', () => {
  const res = cli(['--check-config']);
  assert.match(res.stdout, /reviewer\s+openai-codex\s+assumed available \(no env check\)/);
});

test('S7 --json output does not expose the absolute config path', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'model-caddie.config.json'), JSON.stringify(anthropic()));
  const out = JSON.parse(cli(['--json', 'rename a heading'], dir).stdout);
  assert.equal(out.source, 'model-caddie.config.json');
});

// --- second independent pass: bypasses of the first round of fixes -----------------

import { symlinkSync, mkdirSync as mk } from 'node:fs';
import { parseOverride as po2 } from '../src/router.js';

test('S1b a log path through a symlink or junction pointing outside the project is refused', () => {
  const outside = tmp();
  const project = tmp();
  try { symlinkSync(outside, join(project, 'logs'), 'junction'); } catch { return; }
  assert.throws(() => appendLog({ a: 1 }, 'logs/x.jsonl', project), /outside the working directory/);
  assert.ok(!existsSync(join(outside, 'x.jsonl')));
});

test('S1c an existing file whose first line is blank is not treated as a log', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'x.jsonl'), '\nexport PATH=/evil\n');
  assert.throws(() => appendLog({ a: 1 }, 'x.jsonl', dir), /not a JSONL log/);
});

test('N4 appending to a log with no trailing newline keeps every line valid JSON', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'x.jsonl'), '{"a":1}');
  appendLog({ b: 2 }, 'x.jsonl', dir);
  const lines = readFileSync(join(dir, 'x.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }]);
});

test('S2b the exported parseOverride is bounded on long whitespace runs', () => {
  const t0 = performance.now();
  po2('use codex' + ' '.repeat(50000));
  po2('do not' + ' '.repeat(50000) + 'use codex');
  assert.ok(performance.now() - t0 < 500);
});

test('S3b dispatch templates cannot carry shell syntax', () => {
  for (const bad of ['echo safe; $(whoami)', 'run `id`', 'a | sh', 'x && y', 'a > b', 'say "hi"', 'c:\\x']) {
    const cfg = anthropic(); cfg.lanes.primary.dispatch = bad;
    assert.throws(() => validateConfig(cfg), /dispatch/, `accepted ${bad}`);
  }
  const ok = anthropic(); ok.lanes.primary.dispatch = "{provider} {model}, in Claude Code use the Agent tool's model override";
  assert.doesNotThrow(() => validateConfig(ok));
});

test('S5b sensitive data hidden in a filename-shaped token is still detected and kept out of the log', () => {
  for (const t of ['email bob@example.com.js about it', 'set password=FAKE_SECRET_123 in the config', 'rotate the token sk-FAKEabc123def456']) {
    const e = makeLogEntry(t, r(t));
    assert.equal(e.task, null, `logged: ${t}`);
  }
});

test('S5c the default config keeps task text out of the log', () => {
  assert.equal(validateConfig({ lanes: { primary: anthropic().lanes.primary } }).log.taskText, 'omit');
});

test('S7b requiresEnv must be an array, not null', () => {
  const cfg = anthropic(); cfg.lanes.research.requiresEnv = null;
  assert.throws(() => validateConfig(cfg), /requiresEnv/);
});

test('F4b aliases that look like filenames are rejected, since filenames are stripped before matching', () => {
  for (const a of ['a.js', 'x.md', 'y.json']) {
    const cfg = anthropic(); cfg.aliases[a] = 'large-context';
    assert.throws(() => validateConfig(cfg), /alias/, `accepted ${a}`);
  }
});

test('N1 a consensus code review never picks a reviewer that is already a consensus leg', () => {
  const d = r('get a second opinion on this code review of the parser');
  assert.ok(d.reviewPass);
  assert.equal(d.reviewPass.reviewer, null, 'every configured lane already took part');
  assert.equal(d.reviewPass.tieBreaker, null);
  assert.ok(d.notes.some((n) => /by hand/i.test(n)));
});

test('N2 model identity is compared as a pair, not a joined string', () => {
  // Providers chosen so a NAIVE provider+model concatenation collides on "abc"
  // while the pair stays distinct. They previously read 'a' and 'a/b', which
  // 0.2.0's vendor-root rule now correctly treats as ONE vendor, so the
  // tie-breaker was suppressed for a different and legitimate reason and this
  // regression went untested. Distinct vendor roots keep the original intent.
  const cfg = anthropic();
  cfg.lanes.reviewer = { provider: 'ab', requiresEnv: [], models: { review: 'c' } };
  cfg.lanes['large-context'] = { provider: 'a', requiresEnv: [], models: { fast: 'bc', reasoning: 'bc' } };
  const d = r('code review the handler', prepare(cfg));
  assert.equal(d.reviewPass.reviewer.lane, 'reviewer');
  assert.equal(d.reviewPass.tieBreaker.lane, 'large-context', 'a distinct model was suppressed by a string collision');
});

test('N3 a code review that also needs live facts stays a review and points at the research lane for the lookup', () => {
  const d = r('code review using current exchange rates and latest security news');
  assert.equal(d.lane, 'primary');
  assert.ok(d.reviewPass);
  assert.ok(d.notes.some((n) => /research lane/i.test(n) && /look/i.test(n)));
});

// --- third independent pass ------------------------------------------------------------

test('S3c dispatch templates cannot carry parentheses or braces beyond the placeholders', () => {
  for (const bad of ['Write-Output (Get-Location)', 'run {evil}', 'x {model']) {
    const cfg = anthropic(); cfg.lanes.primary.dispatch = bad;
    assert.throws(() => validateConfig(cfg), /dispatch/, `accepted ${bad}`);
  }
  const ok = anthropic(); ok.lanes.primary.dispatch = '{provider} {model}, tier {tier}, lane {lane}';
  assert.doesNotThrow(() => validateConfig(ok));
});

test('S5d quoted credential assignments and underscore-glued tokens are detected', () => {
  const cfg = anthropic(); cfg.log = { taskText: 'truncate' };
  const config = prepare(cfg);
  for (const t of ['set "password":"FAKE_SECRET_123"', 'rotate token_sk-FAKEabc123def456', "api_key = 'abc'"]) {
    const e = makeLogEntry(t, r(t, config), { taskText: 'truncate' });
    assert.equal(e.task, null, `logged: ${t}`);
  }
});

test('F4c any alias the filename stripper would alter is rejected', () => {
  for (const a of ['a.js-fast', 'a.js+fast']) {
    const cfg = anthropic(); cfg.aliases[a] = 'large-context';
    assert.throws(() => validateConfig(cfg), /alias/, `accepted ${a}`);
  }
});

test('N3b the live-fact pointer survives an override, and an unusable research lane gets the unsourced warning', () => {
  const d = r('use gemini to code review using current exchange rates and latest security news');
  assert.equal(d.lane, 'large-context');
  assert.ok(d.notes.some((n) => /research lane/i.test(n)));
  const off = route('code review using current exchange rates and latest security news', { env: {} });
  assert.ok(off.notes.some((n) => /verif/i.test(n)), 'with no research lane the figures must be flagged as unsourced');
});

test('N5 a valid log whose first line is longer than 4KB is still recognized as a log', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'x.jsonl'), JSON.stringify({ notes: ['y'.repeat(6000)] }) + '\n');
  assert.doesNotThrow(() => appendLog({ a: 1 }, 'x.jsonl', dir));
});
