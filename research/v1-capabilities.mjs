export const V1_BROWSER_CAPABILITIES = Object.freeze({
  linkedinTargetedSearch: 'SUPPORTED',
  linkedinPersonalizedFeed: 'NOT_INCLUDED_IN_V1',
  indeedDiscovery: 'NOT_INCLUDED_IN_V1',
  occDiscovery: 'NOT_INCLUDED_IN_V1',
  priorityEvidenceEnrichment: 'SUPPORTED',
  facebookCommunityDiscovery: 'NOT_INCLUDED_IN_V1',
});

export function supportedV1BrowserCapabilities() {
  return Object.entries(V1_BROWSER_CAPABILITIES).filter(([, status]) => status === 'SUPPORTED').map(([id]) => id);
}

export function filterV1ScheduledBrowserTasks(tasks = []) {
  return tasks.filter(task => task.source === 'linkedin'
    && task.strategyId === 'linkedin_search'
    && task.mode === 'targeted_search');
}
