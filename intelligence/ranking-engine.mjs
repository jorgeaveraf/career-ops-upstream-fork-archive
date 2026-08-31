import { boundedScore, RANKING_RULES_VERSION, scoreBand } from './contracts.mjs';
import { detectEmploymentModel, normalizedText, normalizedTitleTokens } from './signals.mjs';

const GENERIC_ROLE_TOKENS = new Set(['senior', 'staff', 'lead', 'principal', 'junior', 'director', 'head', 'manager', 'of', 'the']);
const SCHEDULE_NEGATIVE = ['mandatory pst hours', 'us business hours only', '24/7 on-call', 'on-call rotation', 'rotations', 'night shift'];
const SCHEDULE_POSITIVE = ['async', 'asynchronous', 'flexible hours', 'flexible schedule', 'distributed', 'timezone overlap'];

function candidateFit(job, policy) {
  const title = normalizedText(job?.title);
  const titleTokens = new Set(normalizedTitleTokens(job?.title).filter(token => !GENERIC_ROLE_TOKENS.has(token)));
  let best = { phrase: '', overlap: 0, exact: false };
  for (const phrase of policy?.rolePhrases || []) {
    const normalized = normalizedText(phrase).trim();
    const tokens = new Set(normalizedTitleTokens(phrase).filter(token => !GENERIC_ROLE_TOKENS.has(token)));
    const overlap = tokens.size ? [...tokens].filter(token => titleTokens.has(token)).length / tokens.size : 0;
    const exact = normalized && title.includes(normalized);
    if ((exact ? 2 : overlap) > (best.exact ? 2 : best.overlap)) best = { phrase, overlap, exact };
  }
  let score = best.exact ? 95 : best.overlap >= 0.75 ? 85 : best.overlap >= 0.5 ? 70 : best.overlap > 0 ? 45 : 20;
  const reasons = best.phrase
    ? [`Title alignment with “${best.phrase}”: ${best.exact ? 'direct match' : `${Math.round(best.overlap * 100)}% core-token overlap`}.`]
    : ['No configured target-role phrase matched the title.'];
  return { score: boundedScore(score), band: scoreBand(score), reasons, evidence: { matchedRole: best.phrase, exact: best.exact, overlap: best.overlap } };
}

function engagementComponent(job, policy) {
  const detected = detectEmploymentModel(job);
  const preference = policy?.employment?.find(item => item.key === detected.model)?.preference;
  const base = detected.model === 'unknown' || !Number.isFinite(preference)
    ? 50
    : boundedScore(110 - Math.min(preference, 5) * 10);
  const content = normalizedText(job?.description);
  let score = base;
  const reasons = [`${detected.model.replace('_', '-')} engagement receives ${base}/100 from the configured preference order.`];
  if (detected.model === 'full_time' && /flexible|async|asynchronous/.test(content)) {
    score = 75;
    reasons.push('Flexible full-time work remains viable and receives a compatibility boost.');
  } else if (detected.model === 'full_time' && /rigid|fixed hours|business hours only/.test(content)) {
    score = 30;
    reasons.push('Rigid full-time hours receive a strong penalty.');
  }
  return { score, model: detected.model, reasons };
}

function scheduleComponent(job) {
  const content = normalizedText(job?.description);
  const positive = SCHEDULE_POSITIVE.filter(signal => content.includes(signal));
  const negative = SCHEDULE_NEGATIVE.filter(signal => content.includes(signal));
  const score = boundedScore(70 + positive.length * 10 - negative.length * 25);
  const reasons = [
    ...(positive.length ? [`Compatible schedule signals: ${positive.join(', ')}.`] : ['No explicit flexible-schedule signal; schedule remains partly unknown.']),
    ...(negative.length ? [`Schedule penalties: ${negative.join(', ')}.`] : []),
  ];
  return { score, positive, negative, reasons };
}

function strategicComponent(job, policy) {
  const content = normalizedText(job?.title, job?.description);
  const configured = policy?.workPreferences?.strategicSignals || {};
  const positive = (configured.positive || []).filter(signal => content.includes(signal));
  const negative = (configured.negative || []).filter(signal => content.includes(signal));
  const score = boundedScore(50 + positive.length * 10 - negative.length * 20);
  return {
    score, positive, negative,
    reasons: [positive.length ? `Strategic-value signals: ${positive.join(', ')}.` : 'Strategic value is not explicit.', ...(negative.length ? [`Strategic penalties: ${negative.join(', ')}.`] : [])],
  };
}

function compensationComponent(signal) {
  let score = {
    meets_threshold: 75,
    below_threshold: 0,
    not_comparable_without_inference: 40,
    at_or_above_desired: 100,
    meets_minimum: 75,
    below_minimum: 0,
    not_comparable: 40,
    no_matching_floor: 55,
    not_available: 50,
  }[signal?.comparison] ?? 50;
  if (signal?.status === 'NOT_COMPARABLE') score = Math.min(score, 40);
  const reason = signal?.status === 'KNOWN_ACCEPTABLE' ? 'Comparable compensation meets the configured market threshold.'
    : signal?.status === 'BELOW_THRESHOLD' ? 'Comparable compensation is below the configured market threshold.'
      : signal?.status === 'NOT_COMPARABLE' ? 'Compensation is present but not comparable without inference.' : 'Compensation is not stated.';
  return { score, status: signal?.status || 'UNKNOWN', comparison: signal?.comparison || 'not_available', reasons: [signal?.reason || reason] };
}

export function rankOpportunity(job, eligibility, policy, { rulesVersion = RANKING_RULES_VERSION } = {}) {
  const fit = candidateFit(job, policy);
  const engagement = engagementComponent(job, policy);
  const schedule = scheduleComponent(job);
  const strategic = strategicComponent(job, policy);
  const compensation = compensationComponent(eligibility?.signals?.compensation);
  const location = {
    score: eligibility.status === 'ELIGIBLE' ? 100 : eligibility.status === 'INELIGIBLE' ? 0 : 50,
    reasons: [eligibility.status === 'ELIGIBLE' ? 'Location is explicitly viable.' : eligibility.status === 'INELIGIBLE' ? 'A hard eligibility conflict exists.' : 'Location viability requires confirmation.'],
  };
  const opportunityScore = boundedScore(
    location.score * 0.25 + engagement.score * 0.25 + schedule.score * 0.20
    + compensation.score * 0.20 + strategic.score * 0.10,
  );
  const opportunity = {
    score: opportunityScore,
    band: scoreBand(opportunityScore),
    components: { location, engagement, schedule, compensation, strategic },
    reasons: [
      ...location.reasons, ...engagement.reasons, ...schedule.reasons,
      ...compensation.reasons, ...strategic.reasons,
    ],
  };

  const configuredAdjustment = Number(job?.rawMetadata?.discoveryStrategy?.priorityAdjustment);
  const strategyAdjustment = Number.isFinite(configuredAdjustment) ? Math.max(-100, Math.min(0, configuredAdjustment)) : 0;
  const humanPreference = job?.humanPreference || { adjustment: 0, reasons: [], evidenceRefs: [], signalIds: [] };
  const humanPreferenceAdjustment = Math.max(-15, Math.min(6, Number(humanPreference.adjustment) || 0));
  let finalScore = boundedScore(fit.score * 0.45 + opportunityScore * 0.55 + strategyAdjustment + humanPreferenceAdjustment);
  let decision;
  if (eligibility.status === 'INELIGIBLE') {
    finalScore = 0; decision = 'REJECT';
  } else if (eligibility.status === 'UNKNOWN') {
    finalScore = Math.min(finalScore, 69); decision = 'REVIEW';
  } else if (finalScore >= 75) decision = 'SHORTLIST';
  else if (finalScore >= 60) decision = 'CONSIDER';
  else decision = 'REVIEW';
  const finalPriority = {
    score: finalScore,
    decision,
    reasons: [
      `Eligibility is ${eligibility.status}.`,
      `Candidate fit is ${fit.band} (${fit.score}/100).`,
      `Opportunity quality is ${opportunity.band} (${opportunity.score}/100).`,
      ...(strategyAdjustment ? [`Discovery strategy adjustment: ${strategyAdjustment} points.`] : []),
      ...(humanPreference.reasons || []),
      `Decision: ${decision}.`,
    ],
    humanPreferenceAdjustment,
    humanPreferenceReasons: humanPreference.reasons || [],
    humanPreferenceEvidenceRefs: humanPreference.evidenceRefs || [],
    humanPreferenceSignalIds: humanPreference.signalIds || [],
  };
  return { candidateFit: fit, opportunity, finalPriority, rulesVersion };
}
