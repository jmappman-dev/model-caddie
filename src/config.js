// Config loading, validation, and compilation.
//
// A config says which models sit behind each lane, which words a user can say
// to name a lane or tier ("use opus", "ask gemini"), and which lanes need an
// API key in the environment before they count as available. The classifier
// itself never reads files or the network; it only ever sees a compiled config.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripFilenames } from './strip.js';

export const LANES = ['primary', 'research', 'large-context', 'reviewer'];
export const PRIMARY_TIERS = ['light', 'standard', 'strong', 'frontier'];
export const LANE_TIERS = {
  research: ['quick', 'deep'],
  'large-context': ['fast', 'reasoning'],
  reviewer: ['review'],
};

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILES_DIR = join(HERE, '..', 'profiles');
export const DEFAULT_PROFILE = 'anthropic';

// Aliases start AND end with a letter or digit, so the word-boundary anchors in
// the override grammar can always match them.
const ALIAS_RX = /^[a-z0-9](?:[a-z0-9.+-]{0,38}[a-z0-9])?$/;
// Provider labels and model IDs reach stdout and the calling agent, so they are
// held to a plain character set: no spaces, quotes, shell metacharacters, or
// control characters.
const NAME_RX = /^[A-Za-z0-9][\w.:/@+-]{0,79}$/;
const CONTROL_RX = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_DISPATCH = 300;
// Dispatch hints are display text that agents read, so they may not carry
// shell syntax: no quotes, backslashes, $, backticks, ;, |, &, <, >, or
// parentheses (PowerShell evaluates a parenthesized command). Braces are
// allowed only as the four placeholders.
const DISPATCH_RX = /^[A-Za-z0-9 .,:'\/@+_-]*$/;
const PLACEHOLDER_RX = /\{(?:provider|model|tier|lane)\}/g;
// Filenames are stripped from task text before matching, so an alias that
// looks like a filename ("notes.md") could never be heard.
const FILENAME_LIKE_RX = /\.[a-z][a-z0-9]{0,4}$/i;
const ENV_NAME_RX = /^[A-Z_][A-Z0-9_]{0,127}$/;
const TERM_RX = /^[a-z0-9][a-z0-9 .+'-]{0,59}$/i;

const DEFAULT_SIGNALS = {
  sensitiveTerms: ['client', 'clients', 'customer', 'customers', 'patient', 'patients', 'contract', 'contracts'],
  contentTerms: ['newsletter', 'blog', 'caption', 'copy', 'brochure', 'flyer', 'invitation', 'press release', 'listing', 'listings', 'marketing email', 'contract', 'disclosure'],
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function fail(msg) {
  throw new ConfigError(`invalid router config: ${msg}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function validateConfig(raw) {
  if (!isPlainObject(raw)) fail('top level must be a JSON object');
  const cfg = structuredClone(raw);

  if (!isPlainObject(cfg.lanes)) fail('"lanes" must be an object');
  for (const id of Object.keys(cfg.lanes)) {
    if (!LANES.includes(id)) fail(`unknown lane "${id}" (allowed: ${LANES.join(', ')})`);
  }
  const primary = cfg.lanes.primary;
  if (!isPlainObject(primary)) fail('"lanes.primary" is required');
  if (primary.enabled === false) fail('the primary lane cannot be disabled; every route falls back to it');
  if (primary.requiresEnv && primary.requiresEnv.length) fail('the primary lane cannot require env vars; routing must work with no keys set');

  for (const [id, lane] of Object.entries(cfg.lanes)) {
    if (!isPlainObject(lane)) fail(`lane "${id}" must be an object`);
    if (typeof lane.provider !== 'string' || !NAME_RX.test(lane.provider)) fail(`lane "${id}" provider must be a plain label (letters, digits, . : / @ + - _, max 80)`);
    if (!isPlainObject(lane.models)) fail(`lane "${id}" needs a "models" object`);
    const tiers = id === 'primary' ? PRIMARY_TIERS : LANE_TIERS[id];
    for (const t of tiers) {
      if (typeof lane.models[t] !== 'string' || !lane.models[t]) fail(`lane "${id}" is missing models.${t}`);
      if (!NAME_RX.test(lane.models[t])) fail(`lane "${id}" models.${t} must be a plain model ID (letters, digits, . : / @ + - _, max 80)`);
    }
    for (const t of Object.keys(lane.models)) {
      if (!tiers.includes(t)) fail(`lane "${id}" has unknown model tier "${t}" (allowed: ${tiers.join(', ')})`);
    }
    if (id !== 'primary' && !Array.isArray(lane.requiresEnv)) {
      fail(`lane "${id}" must list requiresEnv explicitly; use [] only if it needs no key (for example a CLI with its own login)`);
    }
    lane.requiresEnv = lane.requiresEnv ?? [];
    if (!Array.isArray(lane.requiresEnv) || !lane.requiresEnv.every((n) => typeof n === 'string' && ENV_NAME_RX.test(n))) {
      fail(`lane "${id}" requiresEnv must be a list of env var NAMES (never values), e.g. ["OPENAI_API_KEY"]`);
    }
    if (lane.enabled !== undefined && typeof lane.enabled !== 'boolean') fail(`lane "${id}" enabled must be true or false`);
    lane.enabled = lane.enabled !== false;
    if (lane.dispatch !== undefined) {
      if (typeof lane.dispatch !== 'string' || !DISPATCH_RX.test(lane.dispatch.replace(PLACEHOLDER_RX, '')) || lane.dispatch.length > MAX_DISPATCH) {
        fail(`lane "${id}" dispatch must be one line of plain text (letters, digits, spaces, and . , : ' / @ + _ -, plus the {provider} {model} {tier} {lane} placeholders), max ${MAX_DISPATCH} characters`);
      }
    }
  }

  cfg.aliases = cfg.aliases ?? {};
  if (!isPlainObject(cfg.aliases)) fail('"aliases" must be an object');
  for (const [word, target] of Object.entries(cfg.aliases)) {
    if (FILENAME_LIKE_RX.test(word) || stripFilenames(word).trim() !== word) fail(`alias "${word}" looks like a filename; filenames are removed from task text before matching, so it could never be heard`);
    if (!ALIAS_RX.test(word)) fail(`alias "${word}" must be lowercase letters, digits, ".", "+", or "-", starting and ending with a letter or digit (max 40 chars)`);
    const [lane, tier, extra] = String(target).split(':');
    if (extra !== undefined || !LANES.includes(lane)) fail(`alias "${word}" points at "${target}"; use a lane id, or "primary:<tier>"`);
    if (tier !== undefined && (lane !== 'primary' || !PRIMARY_TIERS.includes(tier))) {
      fail(`alias "${word}" points at "${target}"; only the primary lane has named tiers (${PRIMARY_TIERS.join(', ')})`);
    }
    if (!cfg.lanes[lane]) fail(`alias "${word}" points at lane "${lane}", which is not configured`);
  }

  cfg.review = cfg.review ?? {};
  if (!isPlainObject(cfg.review)) fail('"review" must be an object');
  if (cfg.review.enabled !== undefined && typeof cfg.review.enabled !== 'boolean') fail('review.enabled must be true or false');
  cfg.review.enabled = cfg.review.enabled !== false;
  for (const key of ['reviewer', 'tieBreaker', 'fallback']) {
    const v = cfg.review[key];
    if (v === undefined || v === null) { cfg.review[key] = null; continue; }
    if (!LANES.includes(v) || v === 'primary') fail(`review.${key} must be a non-primary lane id (research, large-context, reviewer) or null`);
  }

  cfg.signals = { ...DEFAULT_SIGNALS, ...(cfg.signals ?? {}) };
  for (const key of ['sensitiveTerms', 'contentTerms']) {
    const list = cfg.signals[key];
    if (!Array.isArray(list) || !list.every((t) => typeof t === 'string' && TERM_RX.test(t))) {
      fail(`signals.${key} must be a list of plain words or short phrases`);
    }
  }

  // Task text stays out of the log unless a config opts in with "truncate".
  cfg.log = { path: '.model-router/decisions.jsonl', taskText: 'omit', ...(cfg.log ?? {}) };
  if (typeof cfg.log.path !== 'string' || !cfg.log.path) fail('log.path must be a string');
  checkLogPath(cfg.log.path);
  if (!['truncate', 'omit'].includes(cfg.log.taskText)) fail('log.taskText must be "truncate" or "omit"');

  return cfg;
}

// A config can come from a stranger (a cloned repo, a gist), and it decides
// where the log is appended. Confine it to a .jsonl file inside the working
// directory so a config can never aim the log at a shell profile or anything
// else outside the project.
export function checkLogPath(p) {
  if (CONTROL_RX.test(p)) fail('log.path contains control characters');
  if (isAbsolute(p) || win32.isAbsolute(p) || posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) {
    fail('log.path must be a relative path inside the working directory, not an absolute path');
  }
  const segments = p.split(/[\\/]+/);
  if (segments.includes('..')) fail('log.path must stay inside the working directory (no ".." segments)');
  if (!/\.jsonl$/i.test(p)) fail('log.path must end in .jsonl');
}

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termAlternation(terms) {
  if (!terms.length) return '(?!)';
  return terms.map((t) => escapeRx(t.trim()).replace(/\s+/g, '\\s+')).join('|');
}

// Builds the config-dependent matchers once. The override grammar is identical
// for every provider; only the words that name a lane or tier change.
export function compileConfig(raw) {
  const config = validateConfig(raw);
  const words = Object.keys(config.aliases).sort((a, b) => b.length - a.length);
  const nameAlt = words.length ? words.map(escapeRx).join('|') : '(?!)';
  return {
    config,
    aliasWords: words,
    nameAlt,
    // The email branch is anchored with a lookbehind so a long run of word
    // characters is scanned once, not once per starting position.
    sensitiveRx: new RegExp(String.raw`\b(?:${termAlternation(config.signals.sensitiveTerms)})\b|(?<![\w.+-])[\w.+-]+@[\w-]+\.[a-z]{2,}|\b(?:password|passwd|pwd|secret|token|api[_-]?key)["']?\s*[:=]|(?<![A-Za-z0-9])(?:sk-|ghp_|gho_|xox[bp]-|AIza)[A-Za-z0-9_-]{8,}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b`, 'i'),
    contentRx: new RegExp(String.raw`\b(?:${termAlternation(config.signals.contentTerms)})\b`, 'i'),
  };
}

export function listProfiles() {
  return ['anthropic', 'openai', 'google', 'ollama', 'claude-code-only'];
}

export function loadProfile(name) {
  if (!listProfiles().includes(name)) {
    throw new ConfigError(`unknown profile "${name}" (available: ${listProfiles().join(', ')})`);
  }
  return readJson(join(PROFILES_DIR, `${name}.json`));
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config file ${path}: ${e.code || e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // Never echo e.message: V8 quotes the start of the file in it, which leaks
    // secrets when someone points --config at the wrong file.
    const pos = /position (\d+)/.exec(String(e.message));
    throw new ConfigError(`config file ${path} is not valid JSON${pos ? ` (error near character ${pos[1]})` : ''}`);
  }
}

// Resolution order: --config flag, MODEL_ROUTER_CONFIG env var,
// ./model-router.config.json in the working directory, --profile flag, then
// the bundled default profile. Returns the raw object plus where it came from.
export function resolveConfig({ configPath, profile, env = process.env, cwd = process.cwd() } = {}) {
  // source is reported relative to cwd so --json output does not expose the
  // user's home directory.
  const shown = (abs) => relative(cwd, abs) || abs;
  if (configPath) return { raw: readJson(resolve(cwd, configPath)), source: shown(resolve(cwd, configPath)) };
  if (env.MODEL_ROUTER_CONFIG) return { raw: readJson(resolve(cwd, env.MODEL_ROUTER_CONFIG)), source: shown(resolve(cwd, env.MODEL_ROUTER_CONFIG)) };
  const local = join(cwd, 'model-router.config.json');
  if (existsSync(local)) return { raw: readJson(local), source: shown(local) };
  const name = profile || DEFAULT_PROFILE;
  return { raw: loadProfile(name), source: `profile:${name}` };
}
