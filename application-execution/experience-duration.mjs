const monthIndex = value => {
  if (!value || value === 'present') return null;
  const match = String(value).match(/^(\d{4})-(\d{2})/);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
};

function mergeIntervals(intervals = []) {
  const ordered = intervals.filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const item of ordered) {
    const prior = merged.at(-1);
    if (!prior || item.start > prior.end) merged.push({ ...item, refs: [...item.refs] });
    else { prior.end = Math.max(prior.end, item.end); prior.refs.push(...item.refs); }
  }
  return merged;
}

const normalized = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function deriveExperienceDuration({ subject, experience = [], skills = [], projects = [], asOf = new Date() } = {}) {
  const wanted = normalized(subject);
  if (!wanted) return null;
  const skill = skills.find(item => [item.name, ...(item.aliases || [])].some(value => normalized(value) === wanted || normalized(value).includes(wanted) || wanted.includes(normalized(value))));
  const projectRefs = new Set(skill?.project_refs || []);
  const evidenceRefs = new Set(skill?.evidence_refs || []);
  const matchingProjects = projects.filter(project => projectRefs.has(project.id)
    || (project.technologies || []).some(value => normalized(value) === wanted)
    || normalized(`${project.category || ''} ${(project.capabilities || []).join(' ')}`).includes(wanted));
  for (const project of matchingProjects) projectRefs.add(project.id);
  const nowMonth = asOf.getUTCFullYear() * 12 + asOf.getUTCMonth() + 1;
  const intervals = experience.filter(item => {
    const text = normalized(`${item.role || ''} ${(item.domains || []).join(' ')}`);
    const wantedTokens=wanted.split(' ').filter(token=>!['engineer','engineering','experience','years'].includes(token));
    return text.includes(wanted) || (wantedTokens.length&&wantedTokens.every(token=>text.includes(token)))
      || (item.project_refs || []).some(ref => projectRefs.has(ref))
      || (item.responsibility_claim_refs || []).some(ref => evidenceRefs.has(ref));
  }).map(item => ({ start: monthIndex(item.start), end: monthIndex(item.end) ?? nowMonth, refs: [item.id, ...(item.responsibility_claim_refs || [])] }));
  const merged = mergeIntervals(intervals);
  const months = merged.reduce((sum, item) => sum + item.end - item.start, 0);
  if (!months) return null;
  return { years: Math.floor(months / 12), exactYears: Number((months / 12).toFixed(2)), months, confidence: 'HIGH', evidenceRefs: [...new Set(merged.flatMap(item => item.refs))], derivation: 'MERGED_CALENDAR_INTERVALS_CONSERVATIVE_FLOOR', asOf: asOf.toISOString().slice(0, 10) };
}
