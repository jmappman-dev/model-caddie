#!/usr/bin/env node
// CLI: model-caddie "<task text>" [--log] [--json] [--config <path>] [--profile <name>]
//      model-caddie --check-config [--config <path>] [--profile <name>]
// Use "--" before a task that itself starts with dashes.

import { route, prepare } from '../src/router.js';
import { resolveConfig, compileConfig, listProfiles, ConfigError, LANES } from '../src/config.js';
import { makeLogEntry, appendLog } from '../src/log.js';

const USAGE = `usage: model-caddie "<task text>" [--log] [--json] [--config <path>] [--profile <name>]
       model-caddie --check-config [--config <path>] [--profile <name>]
       model-caddie [options] -- "<task text starting with dashes>"
profiles: ${listProfiles().join(', ')}`;

function parseArgs(argv) {
  const out = { words: [], log: false, json: false, check: false, configPath: null, profile: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.words.push(...argv.slice(i + 1)); break; }
    if (a === '--log') out.log = true;
    else if (a === '--json') out.json = true;
    else if (a === '--check-config') out.check = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--config' || a === '--profile') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new ConfigError(`${a} needs a value`);
      if (a === '--config') out.configPath = v; else out.profile = v;
    } else if (a.startsWith('-')) {
      // A typo like --profiel must not silently fall back to the default profile.
      throw new ConfigError(`unknown option ${a.split('=')[0]} (use -- before a task that starts with dashes)\n${USAGE}`);
    } else out.words.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }
  const { raw, source } = resolveConfig({ configPath: args.configPath, profile: args.profile });

  if (args.check) {
    const { config } = compileConfig(raw);
    console.log(`config OK (${source})`);
    for (const id of LANES) {
      const lane = config.lanes[id];
      if (!lane) { console.log(`  ${id.padEnd(14)} not configured`); continue; }
      const missing = lane.requiresEnv.filter((n) => !process.env[n]);
      let state;
      if (!lane.enabled) state = 'disabled';
      else if (missing.length) state = `unavailable (set ${missing.join(', ')})`;
      else if (id !== 'primary' && !lane.requiresEnv.length) state = 'assumed available (no env check)';
      else state = 'available';
      console.log(`  ${id.padEnd(14)} ${lane.provider.padEnd(12)} ${state}`);
    }
    return 0;
  }

  const task = args.words.join(' ').trim();
  if (!task) { console.error(USAGE); return 1; }

  const prepared = prepare(raw);
  const d = route(task, { config: prepared });
  const { config } = prepared.__compiled;
  const entry = makeLogEntry(task, d, { taskText: config.log.taskText });

  if (args.json) console.log(JSON.stringify({ decision: d, source }, null, 2));
  else {
    // Always say which config decided this, so a config picked up from the
    // working directory is never a silent surprise.
    console.log(`config: ${source}`);
    console.log(`route: ${d.lane}${d.tier ? ' / ' + d.tier : ''} -> ${d.model} (${d.rule}, ${d.criterion})`);
    console.log(`dispatch: ${d.dispatch}`);
    if (d.reviewPass) {
      const r = d.reviewPass;
      console.log(`review pass: ${r.reviewer ? `${r.reviewer.provider} / ${r.reviewer.model}` : 'NO SECOND MODEL AVAILABLE, review by hand'}${r.tieBreaker ? `; tie-break: ${r.tieBreaker.provider} / ${r.tieBreaker.model}` : ''}`);
    }
    if (d.notes.length) console.log(`notes:\n  - ${d.notes.join('\n  - ')}`);
  }
  if (args.log) {
    const where = appendLog(entry, config.log.path);
    if (!args.json) console.log(`logged: ${where}`);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`model-caddie: ${e.message}`);
    process.exitCode = 2;
  } else {
    // Unexpected failure: print the message only, never the environment.
    console.error(`model-caddie: ${e && e.message ? e.message : String(e)}`);
    process.exitCode = 3;
  }
}
