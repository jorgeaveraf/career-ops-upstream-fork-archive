function sortedRecommendations(items = []) {
  return [...items].sort((a, b) => Number(b.priority || -1) - Number(a.priority || -1)
    || String(a.company).localeCompare(String(b.company)) || String(a.role).localeCompare(String(b.role)));
}

export function buildOperationalSummary({
  id, startedAt, finishedAt, status, discovery = {}, ranking = {}, evaluations = {}, packages = {},
  sheet = {}, errors = [], dashboardUrl = '', notification = {},
} = {}) {
  const start = new Date(startedAt); const finish = new Date(finishedAt);
  const topRecommendations = sortedRecommendations(ranking.recommendations || []).slice(0, 5);
  return {
    run: {
      id, status, startedAt, finishedAt,
      durationMs: Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime()) ? null : Math.max(0, finish - start),
      discoveryRunId: discovery.runId || null,
    },
    discovery: {
      observations: discovery.observations || 0, newJobs: discovery.newJobs || 0,
      changedJobs: discovery.changedJobs || 0, status: discovery.status || 'NOT_RUN',
    },
    eligibility: { processed: ranking.processed || 0, eligible: ranking.eligible || 0 },
    ranking: { shortlisted: ranking.shortlisted || 0, activeSet: ranking.activeSet || 0 },
    evaluation: { completed: evaluations.completed || 0, apply: evaluations.apply || 0 },
    packages: { ready: packages.ready || 0 },
    sheet: { synced: sheet.synced === true, spreadsheetId: sheet.spreadsheetId || null },
    topRecommendations,
    dashboardUrl,
    errors: errors.map(item => ({ stage: item.stage, severity: item.severity, code: item.code, message: item.message })),
    notification: {
      required: notification.required === true, reasons: [...(notification.reasons || [])],
      sent: notification.sent === true, status: notification.status || 'NOT_EVALUATED',
    },
  };
}

export function formatOperationalSummary(summary) {
  const lines = [
    'Career Ops Daily Report', '',
    `Run: ${summary.run.id}`,
    `Status: ${summary.run.status}`,
    `Date: ${summary.run.finishedAt.slice(0, 10)}`, '',
    'Discovery:', `  ${summary.discovery.newJobs} new jobs`,
    'Eligibility:', `  ${summary.eligibility.eligible} eligible`,
    'Ranking:', `  ${summary.ranking.shortlisted} shortlisted`,
    'Evaluation:', `  ${summary.evaluation.completed} completed`,
    'Packages:', `  ${summary.packages.ready} ready`,
    'Sheet:', `  ${summary.sheet.synced ? 'Synced successfully' : 'Not synced'}`,
    'Errors:', `  ${summary.errors.length}`,
    'Notification:', `  ${summary.notification.status}`,
  ];
  if (summary.dashboardUrl) lines.push('', `Dashboard: ${summary.dashboardUrl}`);
  return lines.join('\n');
}
