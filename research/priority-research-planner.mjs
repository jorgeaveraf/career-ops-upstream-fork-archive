export const NAVIGABLE_RESEARCH_NEEDS = Object.freeze([
  'FETCH_FULL_DESCRIPTION', 'CONFIRM_MEXICO_ELIGIBILITY', 'CONFIRM_REMOTE_SCOPE',
  'CONFIRM_EMPLOYMENT_MODEL', 'CONFIRM_COMPENSATION', 'CONFIRM_COMPANY_MARKET',
  'CONFIRM_SCHEDULE', 'RESOLVE_LOCATION_CONFLICT', 'CONFIRM_POSTING_IS_REAL',
]);
export const QUALIFICATION_RESEARCH_NEEDS = Object.freeze(new Set([
  'FETCH_FULL_DESCRIPTION', 'CONFIRM_MEXICO_ELIGIBILITY', 'CONFIRM_REMOTE_SCOPE',
  'CONFIRM_EMPLOYMENT_MODEL', 'RESOLVE_LOCATION_CONFLICT', 'CONFIRM_POSTING_IS_REAL',
]));

const PRIORITY = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1 });
const completenessCount = value => Object.values(value || {}).filter(item => item?.status === 'COMPLETE').length;

export class PriorityResearchPlanner {
  constructor({ maxTasks = 5, maxNeedsPerTask = 9, qualificationOnly = true } = {}) { this.maxTasks = maxTasks; this.maxNeedsPerTask = maxNeedsPerTask; this.qualificationOnly = qualificationOnly; }
  plan({ needs = [], candidates = [], snapshot = [] } = {}) {
    const candidateByJob = new Map(candidates.map(item => [item.jobId, item]));
    const snapshotByJob = new Map(snapshot.map(item => [item.jobId, item]));
    const grouped = new Map();
    for (const need of needs.filter(item => item.status === 'OPEN' && NAVIGABLE_RESEARCH_NEEDS.includes(item.type)
      && (!this.qualificationOnly || QUALIFICATION_RESEARCH_NEEDS.has(item.type)))) {
      const candidate = candidateByJob.get(need.jobId); if (!candidate) continue;
      const current = grouped.get(need.jobId) || { candidate, needs: [], snapshot: snapshotByJob.get(need.jobId) || null };
      current.needs.push(need); grouped.set(need.jobId, current);
    }
    return [...grouped.values()].sort((a, b) => Number(Boolean(b.snapshot?.isTop10)) - Number(Boolean(a.snapshot?.isTop10))
      || Math.max(...b.needs.map(item => PRIORITY[item.priority] || 0)) - Math.max(...a.needs.map(item => PRIORITY[item.priority] || 0))
      || (b.snapshot?.finalPriorityScore || b.candidate.preliminaryScore || 0) - (a.snapshot?.finalPriorityScore || a.candidate.preliminaryScore || 0)
      || completenessCount(a.snapshot?.evidenceCompleteness) - completenessCount(b.snapshot?.evidenceCompleteness)
      || new Date(b.candidate.lastObservedAt || 0) - new Date(a.candidate.lastObservedAt || 0)
      || String(a.candidate.jobId).localeCompare(String(b.candidate.jobId)))
      .slice(0, this.maxTasks).map(({ candidate, needs: candidateNeeds, snapshot: priority }, index) => ({
        id: `browser-enrichment:${candidate.jobId}`, type: 'CANDIDATE_ENRICHMENT', mode: 'enrichment',
        source: String(candidate.provider || 'web').replace(/^browser:/, '') || 'web', strategyId: 'priority_candidate_enrichment',
        jobId: candidate.jobId, observationId: candidate.observationId, url: candidate.canonicalUrl || candidate.sourceUrl,
        title: candidate.title, company: candidate.company, rank: priority?.rank || null, isTop10: Boolean(priority?.isTop10),
        needs: candidateNeeds.sort((a, b) => b.priorityScore - a.priorityScore).slice(0, this.maxNeedsPerTask),
        priorityOrder: index + 1,
      })).filter(item => /^https?:\/\//i.test(item.url || ''));
  }
}
