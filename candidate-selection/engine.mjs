import { hashStable } from '../acquisition/normalize.mjs';
import { ACTIVE_CANDIDATE_STATES, FILTER_OUTCOMES } from './contracts.mjs';
import { resolvePostingNature } from '../intelligence/evidence-resolver.mjs';
import { normalizeCompanyPolicyIdentity } from '../intelligence/unified-candidate-policy.mjs';
import { canonicalHumanDecision } from '../human-decision/contracts.mjs';

export function normalizeSelectionText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalSelectionSource(value) {
  const source = normalizeSelectionText(value).replace(/\s+/g, '-');
  return source.startsWith('browser-') ? source.replace(/^browser-/, 'browser:') : source.replace(/-api$/, '');
}

const includesPhrase = (haystack, phrase) => {
  const normalized = normalizeSelectionText(phrase);
  if (!normalized) return false;
  return normalized.includes(' ') ? haystack.includes(normalized) : haystack.split(' ').includes(normalized);
};
const matchesAny = (haystack, phrases) => phrases.find(phrase => includesPhrase(haystack, phrase)) || '';
const evidence = (ruleId, field, value, source = 'job_observation', effect = 'neutral') => ({ ruleId, field, value, source, effect });
const score = value => Math.max(0, Math.min(100, Math.round(value)));

function titleRelevance(title, rolePhrases) {
  let best = 0;
  let matched = '';
  const titleTokens = new Set(title.split(' ').filter(token => token.length > 1));
  const domainTokens = new Set([
    'ai', 'ia', 'artificial', 'intelligence', 'data', 'platform', 'ml', 'machine',
    'llm', 'solution', 'solutions', 'architect', 'backend',
    'infrastructure', 'cloud', 'automation', 'automatizacion',
  ]);
  for (const phrase of rolePhrases) {
    const normalized = normalizeSelectionText(phrase);
    if (!normalized) continue;
    if (title.includes(normalized)) return { points: 45, matched: phrase, exact: true };
    const tokens = normalized.split(' ').filter(token => token.length > 1);
    const overlap = tokens.filter(token => titleTokens.has(token)).length;
    const ratio = tokens.length ? overlap / tokens.length : 0;
    const domainOverlap = tokens.some(token => domainTokens.has(token) && titleTokens.has(token));
    const roleAnchor = ['engineer', 'engineering', 'architect'].some(token => titleTokens.has(token));
    const candidate = roleAnchor && domainOverlap && ratio >= 0.66 && overlap >= 2 ? Math.round(24 + ratio * 16) : 0;
    if (candidate > best) { best = candidate; matched = phrase; }
  }
  return { points: best, matched, exact: false };
}

function freshness(candidate, now, windowDays) {
  const raw = candidate.postedAt || candidate.rawMetadata?.postedAt || candidate.firstObservedAt;
  if (!raw) return { points: 10, ageDays: null, known: false };
  const time = new Date(raw).getTime();
  if (!Number.isFinite(time)) return { points: 10, ageDays: null, known: false };
  const ageDays = Math.max(0, Math.floor((now.getTime() - time) / 86_400_000));
  if (ageDays > windowDays) return { points: 0, ageDays, known: true };
  return { points: Math.max(5, 20 - Math.floor(ageDays * 15 / windowDays)), ageDays, known: true };
}

function humanValues(candidate) {
  const state = candidate.humanState || {};
  return {
    decision: canonicalHumanDecision(state.humanDecision || state.human_decision),
    application: normalizeSelectionText(state.applicationStatus || state.application_status || candidate.jobStatus).toUpperCase(),
  };
}

function makeDecision(candidate, policy, now) {
  const title = normalizeSelectionText(candidate.title);
  const company = normalizeSelectionText(candidate.company);
  const location = normalizeSelectionText(candidate.location);
  const description = normalizeSelectionText(candidate.description);
  const combined = `${title} ${location} ${description}`.trim();
  const reasons = [];
  const evidenceRefs = [];
  const human = humanValues(candidate);
  let hardReject = false;

  if (human.decision === 'REJECT') {
    hardReject = true; reasons.push('human_rejected');
    evidenceRefs.push(evidence('human.reject', 'human_decision', 'REJECT', 'human_field_state', 'negative'));
  }
  const actedValues = new Set(['APPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'HIRED']);
  if (actedValues.has(human.application)) {
    hardReject = true; reasons.push('human_already_acted');
    evidenceRefs.push(evidence('human.acted', 'application_status', human.application, 'human_field_state', 'negative'));
  }
  const companyIdentity = normalizeCompanyPolicyIdentity(candidate.company);
  const companyBlock = policy.hardRejectCompanies.find(item => companyIdentity === normalizeCompanyPolicyIdentity(item));
  if (companyBlock) {
    hardReject = true; reasons.push('hard_reject_company');
    evidenceRefs.push(evidence('company.hard_reject', 'company', companyBlock, 'candidate_policy', 'negative'));
  }
  const titleBlock = matchesAny(title, policy.titleExclusions);
  if (titleBlock) {
    hardReject = true; reasons.push('excluded_title_or_seniority');
    evidenceRefs.push(evidence('title.exclusion', 'title', titleBlock, 'candidate_policy', 'negative'));
  }
  const contentBlock = matchesAny(description, policy.contentExclusions);
  if (contentBlock) {
    hardReject = true; reasons.push('explicit_work_condition_exclusion');
    evidenceRefs.push(evidence('content.exclusion', 'description', contentBlock, 'candidate_policy', 'negative'));
  }

  const locationAlwaysAllow = matchesAny(location, policy.location.alwaysAllow);
  const locationBlock = locationAlwaysAllow ? '' : matchesAny(location, [...policy.location.block, ...policy.location.excluded]);
  const remoteSignal = /\b(remote|distributed|anywhere|worldwide|global)\b/.test(combined);
  if (locationBlock) {
    hardReject = true; reasons.push('explicit_location_exclusion');
    evidenceRefs.push(evidence('location.exclusion', 'location', locationBlock, 'candidate_policy', 'negative'));
  }
  if (policy.remoteOnly && /\b(on site|onsite|hybrid)\b/.test(`${location} ${description}`)) {
    hardReject = true; reasons.push('explicit_non_remote_role');
    evidenceRefs.push(evidence('location.remote_only', 'location', candidate.location || '', 'candidate_policy', 'negative'));
  }

  const countryExclusion = matchesAny(description, policy.countryEligibility.exclusionary);
  const countryInclusive = matchesAny(description, policy.countryEligibility.inclusive)
    || (policy.candidateCountry && includesPhrase(description, policy.candidateCountry));
  if (countryExclusion && !countryInclusive) {
    hardReject = true; reasons.push('explicit_country_restriction');
    evidenceRefs.push(evidence('country.exclusion', 'description', countryExclusion, 'candidate_policy', 'negative'));
  }

  const fresh = freshness(candidate, now, policy.freshnessWindowDays);
  if (fresh.known && fresh.ageDays > policy.freshnessWindowDays) {
    hardReject = true; reasons.push('posting_expired');
    evidenceRefs.push(evidence('freshness.expired', 'postedAt', candidate.postedAt || candidate.firstObservedAt, 'job_observation', 'negative'));
  }

  const relevance = titleRelevance(title, policy.rolePhrases);
  if (!relevance.points) {
    hardReject = true; reasons.push('title_outside_target_domain');
    evidenceRefs.push(evidence('title.relevance', 'title', candidate.title || '', 'candidate_policy', 'negative'));
  } else {
    reasons.push(relevance.exact ? 'target_title_match' : 'target_title_partial_match');
    evidenceRefs.push(evidence('title.relevance', 'title', relevance.matched, 'candidate_policy', 'positive'));
  }

  const postingNature = resolvePostingNature(candidate, policy);
  const poolPhrase = postingNature.poolSignal;
  if (postingNature.status === 'CONFIRMED_POOL_ONLY') {
    hardReject = true; reasons.push('confirmed_pool_only');
    evidenceRefs.push(...postingNature.evidence);
  } else if (postingNature.status === 'MARKETPLACE_SIGNAL') {
    reasons.push('marketplace_signal_warning');
    evidenceRefs.push(...postingNature.evidence);
  }

  let preliminaryScore = relevance.points + fresh.points;
  preliminaryScore += remoteSignal ? 12 : location ? 6 : 3;
  preliminaryScore += description.length >= 200 ? 10 : description ? 6 : 2;
  preliminaryScore += candidate.sourceUrl || candidate.canonicalUrl ? 6 : 0;
  preliminaryScore += matchesAny(title, policy.seniorityBoosts) ? 7 : 0;
  preliminaryScore -= postingNature.penalty;
  preliminaryScore += human.decision === 'NEXT_STAGE' ? 8 : human.decision === 'HOLD' ? 3 : 0;
  preliminaryScore = score(preliminaryScore);

  const weakIdentity = !candidate.jobId || !candidate.observationId || !(candidate.sourceUrl || candidate.canonicalUrl);
  let outcome = hardReject ? 'REJECT' : weakIdentity ? 'UNKNOWN' : 'PASS';
  if (!FILTER_OUTCOMES.includes(outcome)) outcome = 'UNKNOWN';
  if (!hardReject && preliminaryScore < policy.minimumSelectionScore) reasons.push('below_selection_threshold');
  if (!description) reasons.push('description_missing_preserved');
  return {
    decisionKey: hashStable(JSON.stringify({
      runId: candidate.runId || '', jobId: candidate.jobId, observationId: candidate.observationId,
      rulesVersion: policy.rulesVersion, policyHash: policy.policyHash,
    })),
    jobId: candidate.jobId, observationId: candidate.observationId,
    outcome, reasons: [...new Set(reasons)], evidenceRefs,
    rulesVersion: policy.rulesVersion, policyHash: policy.policyHash,
    preliminaryScore, freshnessDays: fresh.ageDays,
    source: candidate.provider || candidate.source || '',
    sourceKey: canonicalSelectionSource(candidate.provider || candidate.source || ''),
    poolOnly: postingNature.status === 'CONFIRMED_POOL_ONLY', evidenceWeak: weakIdentity || !description,
    observedInRun: Boolean(candidate.observedInRun),
    humanDecision: human.decision, applicationStatus: human.application,
  };
}

function qualified(decision, policy) {
  return decision.outcome !== 'REJECT' && decision.preliminaryScore >= policy.minimumSelectionScore;
}

function stableOrder(a, b) {
  return b.preliminaryScore - a.preliminaryScore
    || (a.freshnessDays ?? Number.MAX_SAFE_INTEGER) - (b.freshnessDays ?? Number.MAX_SAFE_INTEGER)
    || String(a.jobId).localeCompare(String(b.jobId));
}

function boundedFairSelection(decisions, policy) {
  const eligible = decisions.filter(item => qualified(item, policy)).sort(stableOrder);
  const distinctSources = new Set(eligible.map(item => item.sourceKey || 'unknown'));
  if (!policy.sourceDiversity.enabled || distinctSources.size < 2) return eligible.slice(0, policy.maxActiveCandidates);
  const sourceLimit = Math.max(1, Math.floor(policy.maxActiveCandidates * policy.sourceDiversity.maximumShare));
  const counts = new Map();
  const selected = [];
  for (const item of eligible) {
    if (selected.length >= policy.maxActiveCandidates) break;
    const key = item.sourceKey || 'unknown';
    if ((counts.get(key) || 0) >= sourceLimit) continue;
    selected.push(item); counts.set(key, (counts.get(key) || 0) + 1);
  }
  return selected;
}

function terminalState(decision) {
  if (decision.applicationStatus && ['APPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'HIRED'].includes(decision.applicationStatus)) return 'ACTED';
  if (decision.applicationStatus === 'ARCHIVED') return 'DISCARDED';
  if (decision.humanDecision === 'REJECT') return 'DISCARDED';
  if (decision.reasons.includes('posting_expired')) return 'EXPIRED';
  return 'SUPERSEDED';
}

export class CandidateSelectionEngine {
  constructor({ policy, clock = () => new Date() } = {}) {
    if (!policy?.policyHash) throw new TypeError('versioned candidate selection policy is required');
    this.policy = policy;
    this.clock = clock;
  }

  select({ candidates = [], previousCandidates = [] } = {}) {
    const now = this.clock();
    const decisions = candidates.map(candidate => makeDecision(candidate, this.policy, now));
    const chosen = boundedFairSelection(decisions, this.policy);
    const selectedIds = new Set(chosen.map(item => item.jobId));
    const previous = new Map(previousCandidates.map(item => [item.jobId, item]));
    const activeCandidates = chosen.map((item, index) => {
      const before = previous.get(item.jobId);
      return {
        ...item, state: before && ['ACTIVE', 'CARRYOVER'].includes(before.state) && !item.observedInRun ? 'CARRYOVER' : 'ACTIVE',
        stateReason: before && !item.observedInRun ? 'retained_by_rolling_policy' : 'qualified_by_current_policy',
        previousRank: before?.previousRank ?? before?.rank ?? null, selectionRank: index + 1,
      };
    });
    const transitions = [];
    for (const prior of previousCandidates) {
      if (!['ACTIVE', 'CARRYOVER'].includes(prior.state) || selectedIds.has(prior.jobId)) continue;
      const decision = decisions.find(item => item.jobId === prior.jobId);
      const state = decision ? terminalState(decision) : 'SUPERSEDED';
      transitions.push({
        jobId: prior.jobId, observationId: decision?.observationId || prior.observationId,
        state, stateReason: decision?.reasons?.[0] || 'displaced_by_higher_quality_candidates',
        preliminaryScore: decision?.preliminaryScore ?? prior.preliminaryScore ?? 0,
        freshnessDays: decision?.freshnessDays ?? null,
        source: decision?.source || prior.source || '', previousRank: prior.selectionRank || prior.previousRank || null,
      });
    }
    for (const item of decisions) {
      if (selectedIds.has(item.jobId) || previous.has(item.jobId)) continue;
      if (item.humanDecision === 'REJECT' || ['APPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'HIRED', 'ARCHIVED'].includes(item.applicationStatus)) {
        transitions.push({ ...item, state: terminalState(item), stateReason: item.reasons[0] });
      }
    }
    const counts = Object.fromEntries(FILTER_OUTCOMES.map(outcome => [outcome, decisions.filter(item => item.outcome === outcome).length]));
    return {
      rulesVersion: this.policy.rulesVersion, policyHash: this.policy.policyHash,
      capacity: this.policy.maxActiveCandidates, threshold: this.policy.minimumSelectionScore,
      fillToCapacity: false, decisions, activeCandidates, transitions,
      counts: { raw: candidates.length, ...counts, active: activeCandidates.length },
    };
  }
}

export function buildDailyPrioritySnapshot({ runId, snapshotDate, activeCandidates, assessments, previousRanks = new Map(), policy }) {
  const byJob = new Map(assessments.map(item => [item.jobId, item]));
  const ranked = activeCandidates.map(candidate => ({ candidate, assessment: byJob.get(candidate.jobId) }))
    .filter(item => item.assessment)
    .sort((a, b) => b.assessment.finalPriorityScore - a.assessment.finalPriorityScore
      || b.assessment.candidateFitScore - a.assessment.candidateFitScore
      || String(a.candidate.jobId).localeCompare(String(b.candidate.jobId)));
  const entries = ranked.map((item, index) => {
    const rank = index + 1;
    const previousRank = previousRanks.get(item.candidate.jobId) ?? null;
    return {
      runId, snapshotDate, jobId: item.candidate.jobId, observationId: item.candidate.observationId,
      rank, previousRank, movement: previousRank == null ? 'NEW' : previousRank > rank ? `UP_${previousRank - rank}` : previousRank < rank ? `DOWN_${rank - previousRank}` : 'SAME',
      finalPriorityScore: item.assessment.finalPriorityScore,
      eligibilityStatus: item.assessment.eligibilityStatus,
      candidateFitScore: item.assessment.candidateFitScore,
      opportunityScore: item.assessment.opportunityScore,
      decision: item.assessment.decision, reasons: item.assessment.reasons || [],
      confidence: item.assessment.confidence,
      poolOnly: item.candidate.poolOnly,
      evidenceWeak: Boolean(item.assessment.result?.eligibility?.signals?.evidenceCompleteness?.evidenceWeak ?? item.candidate.evidenceWeak),
      evidenceCompleteness: item.assessment.result?.eligibility?.signals?.evidenceCompleteness || null,
      researchNeeds: item.assessment.result?.eligibility?.researchNeeds || [],
    };
  });
  const top10 = entries.filter(item => item.eligibilityStatus === 'ELIGIBLE'
    && item.decision === 'SHORTLIST'
    && item.finalPriorityScore >= policy.topMinimumPriorityScore
    && !item.poolOnly).slice(0, policy.topLimit);
  return { entries, top10, ranked: entries.length };
}

export function assertCandidateState(value) {
  if (!ACTIVE_CANDIDATE_STATES.includes(value)) throw new TypeError(`invalid active candidate state: ${value}`);
  return value;
}
