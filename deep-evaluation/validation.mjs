import { EVALUATION_CONFIDENCE, GAP_KINDS, RECOMMENDATIONS } from './contracts.mjs';

function strings(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) value.forEach(item => strings(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => strings(item, result));
  return result;
}
function metricTokens(value) {
  return new Set(strings(value).flatMap(item => item.match(/\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?x\b/gi) || []).map(item => item.replace(/\s/g, '').toLowerCase()));
}
function arr(value) { return Array.isArray(value) ? value : []; }

export function validateEvaluationOutput(output, evidenceMatches) {
  const errors = [];
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { valid: false, errors: ['output must be an object'] };
  if (!RECOMMENDATIONS.includes(output.recommendation)) errors.push('invalid recommendation');
  if (!EVALUATION_CONFIDENCE.includes(output.confidence)) errors.push('invalid confidence');
  if (!Number.isInteger(output.overall_fit) || output.overall_fit < 0 || output.overall_fit > 100) errors.push('overall_fit must be an integer from 0 to 100');
  for (const field of ['summary', 'strengths', 'evidence_used', 'gaps', 'positioning', 'interview_focus', 'risks']) {
    if (!(field in output)) errors.push(`missing field: ${field}`);
  }
  const matches = new Map(evidenceMatches.map(item => [item.requirementId, item]));
  const allEvidence = new Set(evidenceMatches.flatMap(item => item.evidenceIds));
  const positiveEvidence = new Set(evidenceMatches.flatMap(item => [
    ...item.claimIds, ...item.projectIds, ...item.skillIds, ...item.storyIds,
  ]));
  const checkIds = (ids, allowed, context) => {
    for (const id of arr(ids)) if (!allowed.has(id)) errors.push(`${context} references unsupported evidence: ${id}`);
  };
  checkIds(output.evidence_used, positiveEvidence, 'evidence_used');
  for (const strength of arr(output.strengths)) {
    const match = matches.get(strength?.requirement_id);
    if (!match) { errors.push(`strength references unknown requirement: ${strength?.requirement_id}`); continue; }
    if (['NO_EVIDENCE', 'CONFLICTING_EVIDENCE'].includes(match.status)) errors.push(`strength has no supporting evidence: ${match.requirementId}`);
    if (!arr(strength.evidence_ids).length) errors.push(`strength requires evidence: ${match.requirementId}`);
    checkIds(strength.evidence_ids, new Set([
      ...match.claimIds, ...match.projectIds, ...match.skillIds, ...match.storyIds,
    ]), `strength ${match.requirementId}`);
    if (['PARTIAL_MATCH', 'TRANSFERABLE_EXPERIENCE'].includes(match.status)
      && new RegExp(`${match.requirement.label}.*(?:expert|expertise|proficient|extensive|production experience)|(?:expert|expertise|proficient|extensive).*${match.requirement.label}`, 'i').test(strength.summary || '')) {
      errors.push(`strength overstates partial evidence: ${match.requirementId}`);
    }
  }
  for (const gap of arr(output.gaps)) {
    if (!matches.has(gap?.requirement_id)) errors.push(`gap references unknown requirement: ${gap?.requirement_id}`);
    if (!GAP_KINDS.includes(gap?.status)) errors.push(`gap has invalid status: ${gap?.requirement_id}`);
    checkIds(gap?.gap_ids, new Set(matches.get(gap?.requirement_id)?.gapIds || []), `gap ${gap?.requirement_id}`);
  }
  for (const item of arr(output.positioning?.emphasize)) checkIds(item?.evidence_ids, positiveEvidence, 'positioning');
  for (const item of arr(output.interview_focus)) checkIds(item?.evidence_ids, allEvidence, 'interview_focus');
  for (const risk of arr(output.risks)) {
    checkIds(risk?.evidence_ids, allEvidence, 'risk');
    for (const id of arr(risk?.requirement_ids)) if (!matches.has(id)) errors.push(`risk references unknown requirement: ${id}`);
  }
  const allowedMetrics = metricTokens(evidenceMatches.flatMap(item => [...item.evidence, ...item.projects]));
  for (const metric of metricTokens(output)) if (!allowedMetrics.has(metric)) errors.push(`output invents unsupported metric: ${metric}`);
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}
