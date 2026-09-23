// Decision log: one JSON line per routed task, so routing quality can be
// audited later. Only written when the caller asks (the CLI's --log flag).
// The log never contains API keys or env var values: decisions only carry env
// var NAMES, and only inside "lane unavailable" notes.

import { appendFileSync, mkdirSync, existsSync, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

const MAX_TASK = 140;

// Task text is dropped when the config says "omit" (the config default) or the
// router's own sensitive-data signal fired; with "truncate" it is cut to 140
// characters.
export function makeLogEntry(taskText, d, { taskText: mode = 'truncate' } = {}) {
  const t = String(taskText ?? '');
  const sensitive = (d.notes || []).some((n) => n.startsWith('sensitive-data signal'));
  const redacted = mode === 'omit' || sensitive;
  return {
    ts: new Date().toISOString(),
    task: redacted ? null : (t.length > MAX_TASK ? t.slice(0, MAX_TASK) + '...' : t),
    taskRedacted: redacted,
    lane: d.lane,
    tier: d.tier,
    model: d.model,
    provider: d.provider,
    rule: d.rule,
    criterion: d.criterion,
    declined: d.declined || [],
    reviewPass: d.reviewPass
      ? {
        scope: d.reviewPass.scope || null,
        reviewer: d.reviewPass.reviewer ? d.reviewPass.reviewer.lane : null,
        tieBreaker: d.reviewPass.tieBreaker ? d.reviewPass.tieBreaker.lane : null,
        skipped: d.reviewPass.skipped.map((x) => x.lane),
      }
      : null,
    notes: d.notes,
  };
}

function lastByte(path, size) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// Lexical checks are not enough: a symlink or junction inside the project can
// point anywhere. Resolve the deepest part of the path that exists and make
// sure the REAL location is still inside the real working directory.
function realContained(full, cwd) {
  let probe = full;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const realBase = realpathSync(resolve(cwd));
  const rel = relative(realBase, realpathSync(probe));
  return !rel.startsWith('..') && !isAbsolute(rel);
}

// Reads up to the first newline. A first line longer than MAX_FIRST_LINE is
// not treated as a log (returns null), which bounds the read on a huge file.
const MAX_FIRST_LINE = 1024 * 1024;
function firstLine(path) {
  const fd = openSync(path, 'r');
  try {
    const chunks = [];
    const buf = Buffer.alloc(65536);
    let pos = 0;
    while (pos < MAX_FIRST_LINE) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) { chunks.push(Buffer.from(buf.subarray(0, nl))); return Buffer.concat(chunks).toString('utf8'); }
      chunks.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
    return pos >= MAX_FIRST_LINE ? null : Buffer.concat(chunks).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// Appends one entry. Refuses to write outside the working directory, and
// refuses to append to an existing file that is not already a JSONL log, so a
// mistaken or hostile path can never add lines to a script or shell profile.
export function appendLog(entry, path, cwd = process.cwd()) {
  const full = resolve(cwd, path);
  const rel = relative(resolve(cwd), full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to write the log outside the working directory: ${path}`);
  }
  if (!realContained(full, cwd)) {
    throw new Error(`refusing to write the log outside the working directory: ${path} resolves through a link`);
  }
  let prefix = '';
  if (existsSync(full)) {
    const size = statSync(full).size;
    if (size > 0) {
      const line = (firstLine(full) ?? '').trim();
      let ok = false;
      try { const v = JSON.parse(line); ok = v !== null && typeof v === 'object'; } catch { ok = false; }
      if (!ok) throw new Error(`refusing to append: ${path} exists and is not a JSONL log`);
      if (lastByte(full, size) !== '\n') prefix = '\n';
    }
  }
  mkdirSync(dirname(full), { recursive: true });
  appendFileSync(full, prefix + JSON.stringify(entry) + '\n', 'utf8');
  return full;
}
