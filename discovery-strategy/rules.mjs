const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const list = value => Array.isArray(value) ? value : [];
import { resolvePostingNature } from '../intelligence/evidence-resolver.mjs';
import { DEFAULT_HARD_REJECT_COMPANIES, DEFAULT_POOL_PHRASES, normalizeCompanyPolicyIdentity } from '../intelligence/unified-candidate-policy.mjs';

export const COMPENSATION_STATES = Object.freeze(['KNOWN', 'UNKNOWN', 'BELOW_THRESHOLD']);

export function detectPoolSignals(value, rules = {}) {
  const content = normalize(typeof value === 'string' ? value : `${value?.title || ''} ${value?.company || ''} ${value?.description || ''}`);
  const matched = list(rules.phrases).filter(phrase => content.includes(normalize(phrase)));
  return { detected: matched.length > 0, matched, action: rules.action || 'penalize', priorityPenalty: Number(rules.priority_penalty) || 0 };
}

export function evaluateCompensation({ salary, companyMarket = 'unknown', exceptional = false } = {}, policy = {}) {
  const market = normalize(companyMarket);
  const threshold = market === 'mexico' || market === 'méxico' ? policy.mexico : market === 'foreign' || market === 'extranjera' ? policy.foreign : null;
  const unknown = reason => ({ state: 'UNKNOWN', threshold: threshold || null, salary: salary || null, hardReject: false, reason });
  if (!threshold) return unknown('Company market is not evidenced, so the applicable compensation floor is unknown.');
  if (!salary || !Number.isFinite(Number(salary.amount))) return unknown('Compensation is not stated or lacks sufficient evidence.');
  const comparable = String(salary.currency || '').toUpperCase() === String(threshold.currency || '').toUpperCase()
    && normalize(salary.period) === normalize(threshold.period) && normalize(salary.basis) === normalize(threshold.basis);
  if (!comparable) return unknown('Compensation currency, period, or basis is not directly comparable without conversion.');
  if (Number(salary.amount) < Number(threshold.minimum)) {
    return {
      state: 'BELOW_THRESHOLD', threshold, salary, exceptional,
      hardReject: policy.below_threshold_action === 'reject' && !exceptional,
      reason: exceptional ? 'Compensation is below threshold, but the explicit exceptional-opportunity override prevents automatic rejection.' : 'Compensation is below the evidenced market threshold.',
    };
  }
  return { state: 'KNOWN', threshold, salary, hardReject: false, reason: 'Compensation meets the evidenced market threshold.' };
}

export function evaluateDiscoveryCandidate(job, strategy, context = {}) {
  const company = normalizeCompanyPolicyIdentity(job?.company);
  const companies = [...DEFAULT_HARD_REJECT_COMPANIES, ...list(strategy?.rejectionRules?.companies)];
  const rejectedCompany = companies.find(item => normalizeCompanyPolicyIdentity(item) === company) || '';
  const poolRules = strategy?.rejectionRules?.pool_signals || {};
  const posting = resolvePostingNature(job, { poolSignals: { phrases: [...DEFAULT_POOL_PHRASES, ...list(poolRules.phrases)], penalty: Number(poolRules.priority_penalty) || 0 } });
  const pool = { detected: posting.status !== 'REAL_OR_UNSPECIFIED', matched: posting.poolSignal ? [posting.poolSignal] : [],
    action: posting.status === 'CONFIRMED_POOL_ONLY' ? 'reject' : 'penalize', priorityPenalty: posting.penalty };
  const compensation = evaluateCompensation({
    salary: context.salary || job?.salary || job?.rawMetadata?.salary,
    companyMarket: context.companyMarket || job?.rawMetadata?.companyMarket || 'unknown',
    exceptional: context.exceptional === true || job?.rawMetadata?.exceptionalOpportunity === true,
  }, strategy?.compensationPolicy);
  const poolReject = posting.status === 'CONFIRMED_POOL_ONLY';
  const hardReject = Boolean(rejectedCompany) || poolReject || compensation.hardReject;
  const reasons = [
    ...(rejectedCompany ? [`Company ${rejectedCompany} is on the configured hard-reject list.`] : []),
    ...(pool.detected ? [`Pool/marketplace language detected: ${pool.matched.join(', ')}.`] : []),
    compensation.reason,
  ];
  return {
    accepted: !hardReject, hardReject,
    priorityAdjustment: pool.detected && pool.action === 'penalize' ? -Math.abs(pool.priorityPenalty) : 0,
    rejectedCompany: rejectedCompany || null, pool, compensation, reasons,
  };
}
