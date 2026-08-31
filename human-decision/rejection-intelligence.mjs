import { hashStable, normalizeJobCompany } from '../acquisition/normalize.mjs';
import { REJECTION_INTELLIGENCE_VERSION } from './contracts.mjs';

const words = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const GENERIC_ROLE = new Set(['senior', 'staff', 'lead', 'principal', 'junior', 'manager', 'director', 'head', 'remote', 'the', 'of', 'and']);
const roleFamily = role => words(role).split(/[^a-z0-9+#.]+/).filter(token => token.length > 2 && !GENERIC_ROLE.has(token)).slice(0, 3).sort().join('+') || 'unknown';

function inferredCategories(feedback) {
  const note = words(feedback.rawNotes);
  const found = [];
  if (/\b(german|aleman|alem[aá]n|french|frances|franc[eé]s|language requirement|idioma obligatorio|requires? [a-z]+)\b/.test(note)) found.push(['LANGUAGE_REQUIREMENT', note.match(/\b(german|aleman|french|frances)\b/)?.[1] || 'language']);
  if (/\b(frontend|front-end|react|angular|vue)\b/.test(note)) found.push(['STACK_MISMATCH', 'frontend-heavy']);
  if (/\b(pool|marketplace|talent network|talent community)\b/.test(note)) found.push(['POOL_OR_MARKETPLACE', 'pool-or-marketplace']);
  if (/\b(compensation|salary|salario|pay|pago)\b/.test(note)) found.push(['COMPENSATION', 'compensation']);
  if (/\b(schedule|horario|timezone|time zone|shift)\b/.test(note)) found.push(['SCHEDULE', 'schedule']);
  if (/\b(contractor|contract|full.?time|employment model|nomina|n[oó]mina)\b/.test(note)) found.push(['EMPLOYMENT_MODEL', 'employment-model']);
  return found;
}

function evidenceItems(feedback) {
  const reason = feedback.structuredReason || null;
  const categories = reason ? [[reason, reason.toLowerCase().replaceAll('_', '-')]] : inferredCategories(feedback);
  const items = [];
  for (const [category, detail] of categories) {
    items.push({ category, scopeType: 'REASON', scopeValue: detail, reason: category });
    items.push({ category, scopeType: 'ROLE_FAMILY', scopeValue: roleFamily(feedback.role), reason: category });
    items.push({ category, scopeType: 'COMPANY', scopeValue: normalizeJobCompany(feedback.company), reason: category });
  }
  return items;
}

export function derivePreferenceSignals(feedbackRows, { version = REJECTION_INTELLIGENCE_VERSION } = {}) {
  const groups = new Map();
  for (const feedback of feedbackRows || []) {
    for (const item of evidenceItems(feedback)) {
      const key = `${version}:${item.category}:${item.scopeType}:${item.scopeValue}:${item.reason}`;
      const group = groups.get(key) || { ...item, ids: [], timestamps: [] };
      if (!group.ids.includes(feedback.id)) group.ids.push(feedback.id);
      group.timestamps.push(feedback.createdAt);
      groups.set(key, group);
    }
  }
  return [...groups.entries()].map(([key, group]) => {
    const count = group.ids.length;
    const level = count >= 5 ? 'POLICY_CANDIDATE' : count >= 3 ? 'SOFT_SIGNAL' : 'OBSERVATION';
    const confidence = Math.min(0.95, Number((0.2 + count * 0.15).toFixed(2)));
    return {
      id: `preference-${hashStable(key)}`, signalKey: hashStable(key), level,
      category: group.category, scopeType: group.scopeType, scopeValue: group.scopeValue,
      reason: group.reason, evidenceCount: count, supportingRejectionIds: group.ids.sort(),
      confidence, scoreAdjustment: level === 'OBSERVATION' ? 0 : -Math.min(10, count * 2),
      firstSeen: group.timestamps.sort()[0], lastSeen: group.timestamps.sort().at(-1), version,
    };
  }).sort((a, b) => a.signalKey.localeCompare(b.signalKey));
}

export function matchPreferenceSignals(job, signals = []) {
  const company = normalizeJobCompany(job?.company || '');
  const family = roleFamily(job?.title || '');
  const content = words(`${job?.title || ''} ${job?.description || ''}`);
  const matched = signals.filter(signal => {
    if (!['SOFT_SIGNAL', 'POLICY_CANDIDATE'].includes(signal.level)) return false;
    if (signal.scopeType === 'COMPANY') return signal.scopeValue === company;
    if (signal.scopeType === 'ROLE_FAMILY') return signal.scopeValue === family;
    if (signal.scopeType === 'REASON' && signal.category === 'LANGUAGE_REQUIREMENT') return /german|aleman|french|frances|language/.test(content);
    if (signal.scopeType === 'REASON' && signal.category === 'POOL_OR_MARKETPLACE') return /pool|marketplace|talent network|talent community/.test(content);
    return false;
  });
  const adjustment = Math.max(-15, matched.reduce((sum, signal) => sum + Number(signal.scoreAdjustment || 0), 0));
  return {
    adjustment,
    reasons: matched.map(signal => `Lower priority: ${signal.evidenceCount} prior rejections match ${signal.scopeType.toLowerCase()} ${signal.scopeValue}.`),
    evidenceRefs: matched.flatMap(signal => signal.supportingRejectionIds.map(rejectionId => ({ signalId: signal.id, rejectionId }))),
    signalIds: matched.map(signal => signal.id),
  };
}
