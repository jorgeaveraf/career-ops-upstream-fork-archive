import { hashStable } from '../acquisition/normalize.mjs';

const list = value => Array.isArray(value) ? value : [];
const clean = value => String(value ?? '').trim();

function explanation({ strategy, source, phase, query, signals }) {
  const reason = phase.mode === 'personalized_feed'
    ? 'Uses the candidate-personalized LinkedIn recommendations before broad targeted searches.'
    : phase.mode === 'group_discovery'
      ? 'Looks for high-signal communities that can surface opportunities outside traditional job boards.'
      : phase.mode === 'group_monitoring'
        ? 'Monitors an explicitly configured community for public opportunity posts.'
        : `Searches “${query}” because it is explicitly configured by the ${source} runbook or derived from a candidate target role.`;
  return {
    reason,
    signals,
    candidateKbRevision: strategy.candidateKbRevision,
    strategyRevision: strategy.revision,
  };
}

function phaseQueries(strategy, phase) {
  if (phase.mode === 'personalized_feed') return [''];
  if (phase.query_source === 'candidate_roles') return [...strategy.roles.primary, ...strategy.roles.secondary];
  if (phase.query_source === 'candidate_roles_and_technologies') return [...strategy.roles.primary, ...strategy.roles.secondary, ...strategy.technologies];
  if (phase.mode === 'group_discovery') return list(phase.communities);
  if (phase.mode === 'group_monitoring') return list(phase.groups);
  return list(phase.queries);
}

export function generateDiscoveryStrategyTasks(strategy) {
  if (!strategy?.enabled) return [];
  const tasks = [];
  for (const [source, runbook] of Object.entries(strategy.platforms || {})) {
    if (runbook.enabled === false) continue;
    for (const phase of runbook.phases || []) {
      if (phase.enabled === false) continue;
      for (const query of phaseQueries(strategy, phase)) {
        const phaseFilters = phase.filters || {};
        const { regions: _regions, ...normalizedPhaseFilters } = phaseFilters;
        const signals = [
          ...strategy.roles.primary.filter(role => clean(query).toLowerCase().includes(role.toLowerCase())),
          ...strategy.roles.secondary.filter(role => clean(query).toLowerCase().includes(role.toLowerCase())),
          ...strategy.technologies.filter(technology => clean(query).toLowerCase().includes(technology.toLowerCase())),
          ...(strategy.preferences.remoteOnly ? ['remote only'] : []),
          ...(strategy.preferences.contractorPreferred ? ['contractor preferred'] : []),
        ];
        const identity = `${source}:${phase.id}:${query || phase.objective}`;
        tasks.push({
          id: `strategy:${hashStable(identity).slice(0, 16)}`,
          type: phase.mode === 'group_discovery' || phase.mode === 'group_monitoring' ? 'OPPORTUNITY_SIGNAL_DISCOVERY' : 'JOB_DISCOVERY',
          source, strategyId: phase.id, mode: phase.mode, objective: phase.objective,
          query: clean(query), priority: phase.priority || runbook.priority || 'medium',
          priorityDimension: phase.priority_dimension || runbook.priority_dimension || 'discovery_volume',
          execution: phase.execution || runbook.execution || 'browser_discovery',
          filters: {
            remote: strategy.preferences.remoteOnly,
            seniority: 'senior', contractor: strategy.preferences.contractorPreferred ? 'preferred' : 'accepted',
            technology: true, markets: phaseFilters.markets || phaseFilters.regions || strategy.preferences.regions,
            ...normalizedPhaseFilters,
          },
          explanation: explanation({ strategy, source, phase, query: clean(query), signals }),
        });
      }
    }
  }
  return tasks;
}
