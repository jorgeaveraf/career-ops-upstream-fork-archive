#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { CandidateSelectionEngine } from './candidate-selection/engine.mjs';
import { loadCandidateSelectionPolicy } from './candidate-selection/policy.mjs';
import { rankOperationalCandidates } from './automation/operational-loop.mjs';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';
import { createSqliteBackup } from './operations/backup.mjs';

function usage() {
  console.log(`Usage:
  npm run candidate-set -- status [--json]
  npm run candidate-set -- bootstrap [--dry-run] [--json]

The bootstrap reads the complete Registry, applies cheap deterministic policy,
and persists a bounded rolling set. It never deletes raw jobs or navigates.`);
}

const localDate = clock => clock().toLocaleDateString('en-CA', { timeZone: process.env.CAREER_OPS_TIMEZONE || 'America/Mexico_City' });

export async function runCandidateBootstrap({
  registry, profilePath = process.env.CAREER_OPS_PROFILE || 'config/profile.yml',
  portalsPath = process.env.CAREER_OPS_PORTALS || 'portals.yml', clock = () => new Date(), dryRun = false,
} = {}) {
  if (!registry) throw new TypeError('registry is required');
  const selectionPolicy = loadCandidateSelectionPolicy({ profilePath, portalsPath });
  const runId = `candidate-bootstrap-${localDate(clock)}-v${selectionPolicy.rulesVersion}-${selectionPolicy.policyHash.slice(0, 8)}`;
  const candidates = registry.listCandidateSelectionInputs();
  if (dryRun) {
    const result = new CandidateSelectionEngine({ policy: selectionPolicy, clock }).select({
      candidates, previousCandidates: registry.listActiveCandidates(),
    });
    return {
      dryRun: true, runId, rulesVersion: result.rulesVersion, policyHash: result.policyHash,
      capacity: result.capacity, threshold: result.threshold, counts: result.counts,
      sources: Object.fromEntries([...new Set(result.activeCandidates.map(item => item.sourceKey))]
        .sort().map(source => [source, result.activeCandidates.filter(item => item.sourceKey === source).length])),
    };
  }
  const existing = registry.getRun(runId);
  if (existing?.status === 'SUCCESS') {
    const selection = registry.getCandidateSelectionRun(runId);
    const snapshot = registry.getDailyPrioritySnapshot(runId);
    return { reused: true, runId, selection, ranked: snapshot.length, top10: snapshot.filter(item => item.isTop10).length };
  }
  if (!existing) registry.startRun({
    id: runId, type: 'candidate-bootstrap', startedAt: clock().toISOString(),
    metadata: { rulesVersion: selectionPolicy.rulesVersion, policyHash: selectionPolicy.policyHash, rawRegistryPreserved: true },
  });
  const ranking = await rankOperationalCandidates({ registry, discoveryRunId: runId, profilePath, portalsPath, clock, limit: selectionPolicy.maxActiveCandidates });
  registry.finishRun(runId, {
    status: 'SUCCESS', finishedAt: clock().toISOString(),
    metadata: { rulesVersion: selectionPolicy.rulesVersion, policyHash: selectionPolicy.policyHash, rawRegistryPreserved: true },
  });
  const selection = registry.getCandidateSelectionRun(runId);
  return {
    reused: false, runId, selection, ranking,
    sources: Object.fromEntries([...new Set(registry.listActiveCandidates().map(item => item.sourceKey))]
      .sort().map(source => [source, registry.listActiveCandidates().filter(item => item.sourceKey === source).length])),
    semanticMetrics: registry.getSemanticFunnelMetrics(runId),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) return usage();
  const command = args[0];
  if (!['status', 'bootstrap'].includes(command)) throw new Error(`unknown command: ${command}`);
  const unknown = args.slice(1).filter(arg => !['--dry-run', '--json'].includes(arg));
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
  const dbPath = process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH;
  const registry = openJobRegistry({ dbPath });
  try {
    let output;
    if (command === 'status') {
      const operational = registry.getOperationalCandidateData();
      output = {
        dbPath, schemaVersion: registry.getSchemaVersion(), active: operational.activeCandidates.length,
        latestSnapshotRun: operational.latestSnapshotRun, ranked: operational.snapshot.length,
        top10: operational.top10.length, metrics: operational.metrics,
      };
    } else {
      const dryRun = args.includes('--dry-run');
      if (!dryRun && dbPath !== ':memory:' && String(process.env.CAREER_OPS_BACKUP_ENABLED || 'true').toLowerCase() !== 'false') {
        await createSqliteBackup({ dbPath });
      }
      output = { dbPath, ...(await runCandidateBootstrap({ registry, dryRun })) };
    }
    console.log(JSON.stringify(output, null, 2));
  } finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(`Candidate set failed: ${error.message}`); process.exitCode = 1; });
}
