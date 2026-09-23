#!/usr/bin/env node
// Measures the review-pass decision against eval/corpus.json.
//
//   npm run eval                                human-readable report, tuned corpus
//   npm run eval:holdout                        the BLIND holdout set
//   node eval/evaluate.js --corpus=<file>       any corpus in eval/
//   npm run eval -- --json  machine-readable, for CI
//   npm run eval -- --gate  exit 1 if a threshold in THRESHOLDS is missed
//
// Why this exists. The review-pass decision is a deterministic classifier over
// natural language, which means it has a long tail no amount of patching
// removes. Four independent review rounds against v0.2.0 each found real
// defects, and each fix was verified only by the anecdote that prompted it.
// That is not a measurement. This harness turns the question "is it good?" into
// numbers anyone can reproduce, and makes the failure DIRECTION explicit.
//
// The operational rule that goes with it: never patch a false positive or false
// negative without first adding the case here.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route } from '../src/router.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Release gate. Set deliberately, before looking at a change's results.
// Recall is held higher than precision on purpose: a missed review is a real
// defect shipping unreviewed, while a spurious one costs a few minutes.
const THRESHOLDS = {
  recall: 0.95,
  precision: 0.85,
  scopeAccuracy: 0.95,
};

const ENV = { PERPLEXITY_API_KEY: 'eval-placeholder', GEMINI_API_KEY: 'eval-placeholder' };

function pct(n) {
  return Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : 'n/a';
}

function summarize(rows) {
  const tp = rows.filter((r) => r.expected && r.got).length;
  const fp = rows.filter((r) => !r.expected && r.got).length;
  const fn = rows.filter((r) => r.expected && !r.got).length;
  const tn = rows.filter((r) => !r.expected && !r.got).length;
  const precision = tp + fp ? tp / (tp + fp) : NaN;
  const recall = tp + fn ? tp / (tp + fn) : NaN;
  const f1 = Number.isFinite(precision) && Number.isFinite(recall) && precision + recall
    ? (2 * precision * recall) / (precision + recall)
    : NaN;
  return { tp, fp, fn, tn, precision, recall, f1, total: rows.length };
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const gate = args.includes('--gate');

  const which = args.find((a) => a.startsWith('--corpus='));
  const file = which ? which.slice('--corpus='.length) : 'corpus.json';
  const corpus = JSON.parse(readFileSync(join(HERE, file), 'utf8'));

  const rows = corpus.cases.map((c) => {
    const d = route(c.text, { env: ENV });
    const got = Boolean(d.reviewPass);
    const gotScope = d.reviewPass ? d.reviewPass.scope : null;
    return {
      text: c.text,
      slice: c.slice,
      knownGap: Boolean(c.known_gap),
      note: c.note || null,
      expected: c.review,
      got,
      expectedScope: c.scope,
      gotScope,
      correct: got === c.review,
      scopeCorrect: c.review && got ? gotScope === c.scope : null,
    };
  });

  // Known gaps are reported separately. Folding them into the headline would
  // either hide them or punish the score twice for something already documented.
  const scored = rows.filter((r) => !r.knownGap);
  const gaps = rows.filter((r) => r.knownGap);

  const overall = summarize(scored);
  const scopeRows = scored.filter((r) => r.scopeCorrect !== null);
  const scopeOk = scopeRows.filter((r) => r.scopeCorrect).length;
  const scopeAccuracy = scopeRows.length ? scopeOk / scopeRows.length : NaN;
  // End to end, and it is the number that matters. scopeAccuracy is CONDITIONAL
  // on the task having been detected at all, so it flatters: a task that was
  // missed entirely never gets a chance to have its scope judged. This asks the
  // real question, of every task that needed a review, how many got both the
  // request AND the right scope. Codex review 2026-09-23.
  const allPositives = scored.filter((r) => r.expected).length;
  const endToEnd = allPositives ? scopeOk / allPositives : NaN;

  const slices = [...new Set(scored.map((r) => r.slice))].sort().map((slice) => ({
    slice,
    ...summarize(scored.filter((r) => r.slice === slice)),
    wrong: scored.filter((r) => r.slice === slice && !r.correct).length,
  }));

  const failures = scored.filter((r) => !r.correct);
  const scopeMisses = scored.filter((r) => r.scopeCorrect === false);
  const gapsBehavingAsDocumented = gaps.filter((r) => !r.correct).length;

  const report = {
    generated: new Date().toISOString().slice(0, 10),
    cases: rows.length,
    scored: scored.length,
    knownGaps: gaps.length,
    overall: {
      precision: overall.precision,
      recall: overall.recall,
      f1: overall.f1,
      truePositives: overall.tp,
      falsePositives: overall.fp,
      falseNegatives: overall.fn,
      trueNegatives: overall.tn,
    },
    scopeAccuracy,
    endToEnd,
    endToEndDetail: { correctScopeAndDetected: scopeOk, totalNeedingReview: allPositives },
    slices,
    falsePositives: failures.filter((r) => r.got).map((r) => r.text),
    falseNegatives: failures.filter((r) => !r.got).map((r) => r.text),
    scopeMisses: scopeMisses.map((r) => ({ text: r.text, expected: r.expectedScope, got: r.gotScope })),
    knownGapsStillFailing: gapsBehavingAsDocumented,
    thresholds: THRESHOLDS,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`review-pass classifier, measured against eval/${file}`);
    console.log(`cases ${rows.length} (scored ${scored.length}, known gaps ${gaps.length} reported separately)\n`);
    console.log(`precision       ${pct(overall.precision)}   of the passes it requires, how many should be required`);
    console.log(`recall          ${pct(overall.recall)}   of the passes that should be required, how many it catches`);
    console.log(`F1              ${pct(overall.f1)}`);
    console.log(`scope accuracy  ${pct(scopeAccuracy)}   security vs correctness, CONDITIONAL on being detected at all`);
    console.log(`END TO END      ${pct(endToEnd)}   of all tasks needing review, got BOTH the request and the right scope (${scopeOk}/${allPositives})`);
    console.log(`\nconfusion: tp ${overall.tp}  fp ${overall.fp}  fn ${overall.fn}  tn ${overall.tn}`);

    console.log('\nper slice:');
    for (const s of slices) {
      const flag = s.wrong ? `  <- ${s.wrong} wrong` : '';
      console.log(`  ${s.slice.padEnd(16)} ${String(s.total).padStart(3)} cases  tp ${s.tp} fp ${s.fp} fn ${s.fn} tn ${s.tn}${flag}`);
    }

    if (failures.length) {
      console.log('\nMISCLASSIFIED:');
      for (const r of failures) {
        console.log(`  ${r.got ? 'false positive' : 'FALSE NEGATIVE'}: ${r.text}`);
      }
    } else {
      console.log('\nno misclassifications on the scored set.');
    }

    if (scopeMisses.length) {
      console.log('\nSCOPE MISSES:');
      for (const r of scopeMisses) console.log(`  expected ${r.expectedScope}, got ${r.gotScope}: ${r.text}`);
    }

    console.log(`\nknown gaps (documented in docs/KNOWN-LIMITATIONS.md): ${gaps.length}, of which ${gapsBehavingAsDocumented} still behave as documented`);
    for (const r of gaps) {
      console.log(`  ${r.correct ? 'NOW FIXED, promote it out of known-gap' : 'as documented'}: ${r.text}`);
    }
  }

  if (gate) {
    const misses = [];
    if (!(overall.recall >= THRESHOLDS.recall)) misses.push(`recall ${pct(overall.recall)} < ${pct(THRESHOLDS.recall)}`);
    if (!(overall.precision >= THRESHOLDS.precision)) misses.push(`precision ${pct(overall.precision)} < ${pct(THRESHOLDS.precision)}`);
    if (!(scopeAccuracy >= THRESHOLDS.scopeAccuracy)) misses.push(`scope accuracy ${pct(scopeAccuracy)} < ${pct(THRESHOLDS.scopeAccuracy)}`);
    if (misses.length) {
      console.error('\nGATE FAILED: ' + misses.join('; '));
      process.exitCode = 1;
    } else if (!asJson) {
      console.log('\ngate passed.');
    }
  }
}

main().catch((e) => { console.error('eval failed: ' + e.message); process.exitCode = 1; });
