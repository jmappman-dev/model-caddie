// Deterministic task router. Zero dependencies, no network, no model calls.
//
// route(taskText, { config, env }) reads a plain-language task description and
// returns which lane and tier should do the work, which rule decided it, and
// whether the task needs an independent second-model review. Rules are checked
// first-match-wins, and every earlier rule is bounded so later ones stay
// reachable.
//
//   R1  explicit override  "use opus", "ask gemini"; a negated one declines a lane
//   R2  consensus          "second opinion", "gut check": fan out to every available lane
//   R3  live fact          current prices, news, "latest": research lane
//   R3b review             code/security/spec review: primary lane + review pass
//   R4  large input        whole repo, long document: large-context lane
//   R5  everything else    primary lane, cheapest tier that fits

import { compileConfig, loadProfile, DEFAULT_PROFILE, PRIMARY_TIERS } from './config.js';
import { stripFilenames } from './strip.js';

export { stripFilenames };

// Cheapest-capable order. Escalate one rung only when a named criterion fires.
export const TIERS = PRIMARY_TIERS;

// Task text beyond this length is not classified. Routing needs the gist, and
// the cap bounds the cost of every regex on hostile input.
export const MAX_INPUT = 4000;

const LIVE_NOUN = '(?:price|prices|rate|rates|yield|yields|news|events|standings|score|weather|value|market conditions?)';

// Negation cues shared by both override branches.
const NEG = String.raw`cannot|can['’]?t|won['’]?t|do\s+not|don['’]?t|does\s+not|doesn['’]?t|did\s+not|didn['’]?t|should\s+not|shouldn['’]?t|never|not|avoid|refuse|no\s+need\s+to|instead\s+of|rather\s+than|without`;

const RX = {
  consensus: /\bconsensus\b|\bsecond opinion\b|\bgut[- ]?check\b|\ball three\b/i,
  // 'current' and 'today' are live-fact signals only when tied to a fact noun
  // or a lookup question. Bare \bcurrent\b fired on "current-rules" and
  // "current implementation"; bare "today" fired on any task that dated itself.
  live: new RegExp([
    String.raw`\bcurrent\s+(?:[\w-]+\s+){0,3}${LIVE_NOUN}\b`,
    String.raw`\btoday'?s\s+(?:[\w-]+\s+){0,3}${LIVE_NOUN}\b`,
    // Between the fact noun and "today": a prepositional object, or a CLOSED
    // set of movement adverbs ("rates up today"). Never an open word window.
    String.raw`\b${LIVE_NOUN}\s+(?:(?:for|of|on|in|at)\s+(?:[\w-]+\s+){1,3}|(?:up|down|higher|lower|moving|now)\s+)?today\b`,
    // Present-tense questions only; "what did I draft today" asks about activity.
    String.raw`\b(?:what(?:'s|\s+(?:is|are|happened))|how\s+(?:much|many))\b[^.?!]{0,60}\btoday\b`,
    String.raw`\bas of today\b`,
    String.raw`\blatest\b`,
    String.raw`\bas of now\b`,
    String.raw`\bbreaking\b`,
    String.raw`\brecent news\b`,
    String.raw`\bright now\b`,
  ].join('|'), 'i'),
  deep: /\bresearch\b|\bmulti[- ]?source\b|\bdeep\b|\bcomprehensive\b/i,
  large: /\b(?:full|entire|whole)\s+(?:repo|repository|codebase|project|vault|workspace|monorepo)\b|\blong\s+(?:document|doc|report|pdf|contract|transcript)\b|\blarge\s+(?:file|csv|dataset)\b/i,
  reasoningHeavy: /\bevaluate\b|\btrade[- ]?offs?\b|\breason(?:ing)?\b|\barchitecture\b/i,
  reviewPass: /\b(?:code|security|spec|design|diff|pr|patch|build[- ]spec) review\b|\breview (?:this|the|my|these) (?:code|diff|pr|patch|implementation|spec|changes?)\b|\breview (?:the |our |my )?(?:security|correctness|error handling|auth(?:entication|orization)?)\b/i,
  // An explicit code signal outranks the content guard: plenty of software is
  // named after the business it serves (a listing generator, a contract parser),
  // and dropping a real code review is the dangerous direction.
  codeSignal: /\b(?:code|codebase|implementation|patch|diff|endpoint|api|script|generator|parser|handler|service|component|module|function|schema|migration|repo|repository|app|build[- ]spec|regex|classifier|pipeline)\b/i,
  e5Frontier: /\badversarial(?:ly)?\b|\bnovel architecture\b|\bmulti[- ]?agent\b|\bfrontier\b/i,
  e1MultiFile: /\bacross (?:the|our|your|multiple|all|every|any)?\s*(?:codebase|repo|repos|files|project)\b|\bmulti[- ]?file\b|\bcodebase[- ]?wide\b/i,
  e2ArchReview: /\barchitect(?:ure|ing|ural)?\b|\b(?:design|code|security|spec) review\b|\bsystem design\b/i,
  e3Ambiguity: /\bambiguous\b|\bopen[- ]?ended\b|\bunclear requirements\b/i,
  e4BlastRadius: /\bproduction\b|\bmigration\b|\birreversible\b|\bforce[- ]?push\b|\bdeploy\b/i,
  trivial: /\btypo\b|\brename\b|\breformat\b|\blook(?:ing)? ?up\b|\bone[- ]?liner\b|\bfix the date\b/i,
};

// The override grammar, built per config because the lane and tier NAMES are
// configurable. Structure:
//   group 1  a negation cue bound directly to a verb ("do not use X")
//   group 2  a negation cue reaching a prepositional designator ("not ... through X")
//   group 3  the lane or tier word
// Fillers between cue and verb come from CLOSED sets (intensifiers, modal glue),
// never an open word window, because an open window reads "no rush, use gemini"
// as a rejection. Gerunds ("using") and prepositions ("through", "to") exist on
// the NEGATED side only: hearing a rejection costs nothing, while inventing a
// request routes work to a lane the user never asked for.
function overrideRegexes(nameAlt) {
  const all = new RegExp(
    String.raw`\b(?:(${NEG})\s+(?:(?:ever|really|actually)\s+)?(?:(?:be|been)\s+)?(?:(?:going|able|allowed|permitted|willing|planning|supposed|meant|free|try|trying)\s+)?(?:to\s+)?(?:use|using|via|through|ask|asking)|(${NEG})\s+(?:[A-Za-z]+\s+){1,8}?(?:via|through|to)|(?:use|via|through|ask))\s+(?:(?:either|both)\s+)?(${nameAlt})\b`,
    'gi',
  );
  // Coordination tail, inheriting the polarity of the match it follows:
  // "do not use codex or gemini" declines both. "and" may not carry a fresh
  // verb ("do not use codex; and use gemini" is a new affirmative clause), and
  // a lane followed by a verb is the subject of a new clause, not a list item.
  const coord = new RegExp(
    String.raw`^\s*(?:,\s*(?:(?:or|nor)\s+(?:(?:use|via|through|ask)\s+)?|and\s+)?|[;]?\s*(?:(?:or|nor)\s+(?:(?:use|via|through|ask)\s+)?|and\s+))(${nameAlt})\b(?!\s+(?:should|shall|will|would|can|could|may|might|must|is|are|was|were|has|have|had|does|did|gets?|seems?|works?|looks?|needs?)\b)`,
    'i',
  );
  return { all, coord };
}

const compiledCache = new WeakMap();
let defaultCompiled = null;

function getCompiled(config) {
  if (!config) {
    defaultCompiled = defaultCompiled || withRegexes(compileConfig(loadProfile(DEFAULT_PROFILE)));
    return defaultCompiled;
  }
  if (config.__compiled) return config.__compiled;
  if (!compiledCache.has(config)) compiledCache.set(config, withRegexes(compileConfig(config)));
  return compiledCache.get(config);
}

function withRegexes(c) {
  return { ...c, override: overrideRegexes(c.nameAlt) };
}

// Precompile once when routing many tasks with the same config.
export function prepare(config) {
  return { __compiled: withRegexes(compileConfig(config)) };
}

// Resolves an alias word to { lane, tier }.
function resolveAlias(c, word) {
  const [lane, tier] = String(c.config.aliases[word.toLowerCase()]).split(':');
  return { lane, tier: tier ?? null, word: word.toLowerCase() };
}

// Reads EVERY override phrase and its polarity instead of trusting the first.
//   target     the lane/tier to honor, or null
//   declined   lanes named behind a negation cue, barred for the whole ladder
//   conflicted lanes both requested and rejected in the same task
// Declines are recorded by LANE: "don't use gemini" bars the large-context
// lane however it is reached later. A declined primary-lane TIER is only a
// preference and is reported, never enforced.
export function parseOverride(text, opts = {}) {
  const c = getCompiled(opts.config);
  const { all, coord } = c.override;
  text = String(text ?? '').slice(0, MAX_INPUT).replace(/\s+/g, ' ');
  const affirmative = [];
  const negated = [];
  all.lastIndex = 0;
  let m;
  while ((m = all.exec(text)) !== null) {
    const bucket = m[1] || m[2] ? negated : affirmative;
    bucket.push(resolveAlias(c, m[3]));
    let t;
    while ((t = coord.exec(text.slice(all.lastIndex))) !== null) {
      bucket.push(resolveAlias(c, t[1]));
      all.lastIndex += t[0].length;
    }
  }
  const key = (a) => (a.tier ? `${a.lane}:${a.tier}` : a.lane);
  const declinedKeys = [...new Set(negated.map(key))];
  const declinedLanes = [...new Set(negated.filter((a) => !a.tier && a.lane !== 'primary').map((a) => a.lane))];
  const conflicted = [...new Set(affirmative.map(key).filter((k) => declinedKeys.includes(k)))];
  const target = affirmative.find((a) => !declinedKeys.includes(key(a))) || null;
  return {
    target,
    declined: declinedLanes,
    declinedWords: [...new Map(negated.filter((a) => !a.tier && a.lane !== 'primary').map((a) => [a.word, a.lane])).entries()].map(([word, lane]) => ({ word, lane })),
    declinedTiers: [...new Set(negated.filter((a) => a.tier).map((a) => a.tier))],
    conflicted,
  };
}

function laneStatus(c, laneId, env) {
  const lane = c.config.lanes[laneId];
  if (!lane) return { available: false, reason: `the ${laneId} lane is not configured` };
  if (!lane.enabled) return { available: false, reason: `the ${laneId} lane is disabled in the config` };
  const missing = lane.requiresEnv.filter((name) => !env[name]);
  if (missing.length) return { available: false, reason: `the ${laneId} lane needs ${missing.join(', ')} set in the environment` };
  return { available: true, reason: null };
}

function describe(c, laneId, tier) {
  const lane = c.config.lanes[laneId];
  const model = lane.models[tier];
  const dispatch = (lane.dispatch || '{provider}: {model}')
    .replaceAll('{provider}', lane.provider)
    .replaceAll('{model}', model)
    .replaceAll('{tier}', tier)
    .replaceAll('{lane}', laneId);
  return { lane: laneId, tier, model, provider: lane.provider, dispatch };
}

function isCodeReview(s, c) {
  if (!RX.reviewPass.test(s)) return false;
  return RX.codeSignal.test(s) || !c.contentRx.test(s);
}

// The review pass: a review needs one model to do the work AND a different
// model to check it. The reviewer is chosen from the config, skipping any lane
// the task declined, the environment cannot reach, or that resolves to a model
// already in the loop (the executing model, or the reviewer when picking the
// tie-breaker). The requirement itself never disappears; with no reviewer left
// it says so and asks for a manual second pass.
const REVIEW_TIER = { reviewer: 'review', 'large-context': 'reasoning', research: 'deep' };
const identity = (x) => JSON.stringify([x.provider, x.model]);

function reviewPassFor(s, ctx, exec) {
  const { c, env, ov, notes } = ctx;
  const rc = c.config.review;
  if (!rc.enabled) return null;

  const skipped = [];
  const skip = (lane, reason) => { if (!skipped.some((x) => x.lane === lane)) skipped.push({ lane, reason }); };
  const taken = new Set(exec.provider && exec.model ? [identity(exec)] : []);
  const working = exec.lane === 'consensus' ? exec.legs : [exec.lane];
  const candidate = (laneId) => {
    if (!laneId || !c.config.lanes[laneId]) return null;
    if (working.includes(laneId)) { skip(laneId, 'it is already doing the work'); return null; }
    if (ov.declined.includes(laneId)) { skip(laneId, 'declined in this task'); return null; }
    const st = laneStatus(c, laneId, env);
    if (!st.available) { skip(laneId, st.reason); return null; }
    const pick = describe(c, laneId, REVIEW_TIER[laneId]);
    if (taken.has(identity(pick))) { skip(laneId, `same model (${pick.provider} ${pick.model}) as one already in this review`); return null; }
    return pick;
  };

  let reviewer = candidate(rc.reviewer);
  let usedFallback = false;
  if (!reviewer && rc.fallback && rc.fallback !== rc.reviewer) {
    reviewer = candidate(rc.fallback);
    usedFallback = Boolean(reviewer);
  }
  if (reviewer) taken.add(identity(reviewer));
  const tieBreaker = rc.tieBreaker && (!reviewer || rc.tieBreaker !== reviewer.lane) ? candidate(rc.tieBreaker) : null;

  const worker = exec.lane === 'consensus' ? 'the consensus' : `the ${exec.lane} lane's`;
  if (reviewer) {
    notes.push(`independent review pass required: ${reviewer.provider} (${reviewer.lane} lane) reviews ${worker} work${tieBreaker ? `; where the two disagree, ${tieBreaker.provider} (${tieBreaker.lane} lane) arbitrates that finding` : '; no tie-breaker is available, so settle any disagreement by hand'}`);
  } else {
    notes.push('independent review pass required, but no second model is available for it: run the second pass by hand or with a different model before calling this done');
  }
  if (usedFallback) notes.push(`review pass fell back to the ${reviewer.lane} lane because the configured reviewer is unavailable`);

  return {
    required: true,
    reviewer,
    tieBreaker,
    skipped,
    protocol: [
      `${exec.lane === 'consensus' ? 'The consensus legs do' : `The ${exec.lane} lane does`} the review and records its findings.`,
      reviewer ? `${reviewer.provider} reviews the same material independently, without seeing the primary findings first.` : 'A second reviewer (a different model, or a person) reviews the same material independently.',
      tieBreaker ? `Findings the two reviewers disagree on go to ${tieBreaker.provider}, whose read decides.` : 'Findings the two reviewers disagree on are settled by hand.',
      'Only findings that survive are fixed; record that the independent pass ran.',
    ],
  };
}

function primaryTier(s, c) {
  if (RX.e5Frontier.test(s)) return { tier: 'frontier', criterion: 'E5-frontier' };
  // Blast radius is checked before the other escalations so the logged
  // criterion names the operational risk when signals overlap.
  if (RX.e4BlastRadius.test(s)) return { tier: 'strong', criterion: 'E4-blast-radius' };
  if (RX.e1MultiFile.test(s)) return { tier: 'strong', criterion: 'E1-multi-file' };
  if (RX.e2ArchReview.test(s) || isCodeReview(s, c)) return { tier: 'strong', criterion: 'E2-architecture-review' };
  if (RX.e3Ambiguity.test(s)) return { tier: 'strong', criterion: 'E3-ambiguity' };
  if (RX.trivial.test(s)) return { tier: 'light', criterion: 'E-trivial' };
  return { tier: 'standard', criterion: 'E0-default' };
}

function decision(c, laneId, tier, rule, criterion, extra = {}) {
  return { ...describe(c, laneId, tier), rule, criterion, reviewPass: null, ...extra };
}

function primaryDecision(s, rule, ctx) {
  const { tier, criterion } = primaryTier(s, ctx.c);
  return decision(ctx.c, 'primary', tier, rule, criterion);
}

function researchDecision(s, rule, ctx) {
  const deep = RX.deep.test(s);
  return decision(ctx.c, 'research', deep ? 'deep' : 'quick', rule, deep ? 'depth-multi-source' : 'quick-fact');
}

function largeContextDecision(s, rule, ctx) {
  const heavy = RX.reasoningHeavy.test(s);
  return decision(ctx.c, 'large-context', heavy ? 'reasoning' : 'fast', rule, heavy ? 'reasoning-heavy-offload' : 'extract-summarize-offload');
}

function reviewerDecision(rule, ctx) {
  return decision(ctx.c, 'reviewer', 'review', rule, 'independent-outside-review');
}

// An outside lane is usable only if the task did not decline it and the
// environment can reach it. Anything else falls back to the primary lane.
function outsideUsable(laneId, ctx) {
  if (ctx.ov.declined.includes(laneId)) return { ok: false, why: 'declined' };
  const st = laneStatus(ctx.c, laneId, ctx.env);
  return st.available ? { ok: true } : { ok: false, why: 'unavailable', reason: st.reason };
}

function classify(s, ctx) {
  const { c, ov, notes } = ctx;

  // R1: explicit override.
  if (ov.target) {
    const { lane, tier, word } = ov.target;
    if (lane === 'primary') {
      if (tier) return decision(c, 'primary', tier, 'R1-override', 'explicit-tier');
      return primaryDecision(s, 'R1-override', ctx);
    }
    const u = outsideUsable(lane, ctx);
    if (u.ok) {
      if (lane === 'research') return researchDecision(s, 'R1-override', ctx);
      if (lane === 'large-context') return largeContextDecision(s, 'R1-override', ctx);
      return reviewerDecision('R1-override', ctx);
    }
    notes.push(`override "${word}" not honored: ${u.reason}; falling through to the rule ladder`);
  }

  // R2: consensus, on request only. Fans out to every lane still usable.
  if (RX.consensus.test(s)) {
    const legs = ['primary'];
    const dropped = [];
    for (const lane of ['research', 'large-context', 'reviewer']) {
      if (!c.config.lanes[lane]) continue;
      const u = outsideUsable(lane, ctx);
      if (u.ok) legs.push(lane);
      else dropped.push({ lane, provider: c.config.lanes[lane].provider, reason: u.why === 'declined' ? 'declined in this task' : u.reason });
    }
    if (dropped.length) notes.push(`consensus fan-out reduced: ${dropped.map((d) => `${d.lane} lane, ${d.provider} (${d.reason})`).join('; ')}`);
    if (legs.length === 1) notes.push('consensus requested but only the primary lane is available, so there is no second opinion to gather');
    return {
      lane: 'consensus', tier: null, model: legs.join('+'), provider: null,
      dispatch: `run every leg (${legs.join(', ')}); the primary lane reconciles the answers`,
      legs, dropped, rule: 'R2-consensus', criterion: 'requested', reviewPass: null,
    };
  }

  // R3: live facts have no offline substitute. A code review with an explicit
  // code signal is not a live-fact question, even if it says "latest patch".
  if (RX.live.test(s) && !(isCodeReview(s, c) && RX.codeSignal.test(s))) {
    const u = outsideUsable('research', ctx);
    if (u.ok) return researchDecision(s, 'R3-live-web', ctx);
    notes.push(`live-fact task with the research lane ${u.why === 'declined' ? 'declined' : 'unavailable'}: staying in the primary lane, so any figure here is unsourced and must be verified against its primary source before it is used as fact`);
    return primaryDecision(s, u.why === 'declined' ? 'R3-live-declined' : 'R3-live-unavailable', ctx);
  }

  // R3b: a review outranks the large-input offload. Handing an entire review
  // to one outside model defeats the point of a second pass.
  if (isCodeReview(s, c)) {
    if (RX.large.test(s)) {
      const u = outsideUsable('large-context', ctx);
      notes.push(u.ok
        ? `large review: the primary lane stays the reviewer; use the large-context lane (${c.config.lanes['large-context'].provider}) for the bulk read only, never as the sole reviewer`
        : 'large review with the large-context lane not usable: the bulk read stays in the primary lane as well, so budget context for it');
    }
    return primaryDecision(s, 'R3b-review-primary', ctx);
  }

  // R4: large-input offload.
  if (RX.large.test(s)) {
    const u = outsideUsable('large-context', ctx);
    if (u.ok) return largeContextDecision(s, 'R4-large-input', ctx);
    notes.push(`large-input task with the large-context lane ${u.why === 'declined' ? 'declined' : 'unavailable'}: keeping the whole read in the primary lane`);
    return primaryDecision(s, u.why === 'declined' ? 'R4-large-declined' : 'R4-large-unavailable', ctx);
  }

  // R5: everything else stays on the primary lane, cheapest tier that fits.
  return primaryDecision(s, 'R5-primary-ladder', ctx);
}

export function route(taskText, opts = {}) {
  const c = getCompiled(opts.config);
  const env = opts.env ?? process.env;
  const raw = String(taskText ?? '');
  const notes = [];
  if (raw.length > MAX_INPUT) notes.push(`task text truncated to its first ${MAX_INPUT} characters for classification`);
  const s = stripFilenames(raw.slice(0, MAX_INPUT));
  if (c.sensitiveRx.test(raw.slice(0, MAX_INPUT))) notes.push('sensitive-data signal: this task reads like it may carry personal or client data. Advisory only, routing is unchanged; remove anything sensitive before an outside lane sees it');

  const ov = parseOverride(s, { config: opts.config });
  if (ov.conflicted.length) notes.push(`override conflict: ${ov.conflicted.join(', ')} was both requested and rejected in the same task; that override is not honored`);
  if (ov.declined.length) notes.push(`declined: ${ov.declinedWords.map((w) => `${w.word} (${w.lane} lane)`).join(', ')} explicitly rejected; not routed to for any rule in this task`);

  const ctx = { c, env, ov, notes };
  const d = classify(s, ctx);
  d.declined = ov.declined;
  d.notes = notes;

  // A code review that also mentions live facts stays a review, whatever lane
  // it landed on, and says where the facts should come from.
  if (RX.live.test(s) && isCodeReview(s, c) && RX.codeSignal.test(s) && d.lane !== 'research') {
    const u = c.config.lanes.research ? outsideUsable('research', ctx) : { ok: false };
    notes.push(u.ok
      ? `this review also mentions live facts: look them up through the research lane (${c.config.lanes.research.provider}) and keep the review itself where it was routed`
      : 'this review also mentions live facts and no research lane is usable: any figure it relies on is unsourced and must be verified against its primary source');
  }

  // The review pass is decided last so no earlier rule can drop it. A task that
  // routed to the research lane only counts as a code review when it names code.
  if (isCodeReview(s, c) && (d.lane !== 'research' || RX.codeSignal.test(s))) {
    d.reviewPass = reviewPassFor(s, ctx, d);
  }

  // A declined primary TIER is a preference, not a data-exposure guardrail, so
  // it is reported rather than silently re-tiered.
  if (d.lane === 'primary' && ov.declinedTiers.includes(d.tier)) {
    notes.push(`tier conflict: the ladder selected the ${d.tier} tier, which this task declined; the escalation criterion stands, so override the tier by hand if that is wrong`);
  }
  return d;
}
