#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { runDaily } from './runner/daily-runner.mjs';

export function formatDailySummary(result) {
  if (result.dryRun) {
    return [
      'Career Ops Daily Runner — dry run',
      '',
      'Would:',
      ...result.plan.map(item => `  ✓ ${item}`),
      '',
      'Skipped:',
      ...result.skipped.map(item => `  - ${item}`),
    ].join('\n');
  }
  if (!result.summary) return `Career Ops Daily Run\n\nStatus: ${result.status}\n${result.error?.message || 'No run was created.'}`;
  const { run, discovery, providers, failures, recovery } = result.summary;
  const lines = [
    'Career Ops Daily Run', '',
    `Run: ${run.id}`,
    `Status: ${run.status}`,
    `Started: ${run.startedAt}`,
    `Finished: ${run.finishedAt}`,
    `Duration: ${run.durationMs}ms`, '',
    'Discovery:',
    `  Observations: ${discovery.observations}`,
    `  New jobs: ${discovery.newJobs}`,
    `  Changed jobs: ${discovery.changedJobs}`,
    `  Known: ${discovery.knownJobs}`,
  ];
  if (providers.length) {
    lines.push('', 'Providers:', ...providers.map(item => `  ${item.provider} ${item.status} (${item.targets} targets, ${item.observations} observations)`));
  }
  if (failures.length) {
    lines.push('', 'Failures:', ...failures.map(item => `  ${item.code}: ${item.message}`));
  }
  if (recovery.interruptedRunIds.length) {
    lines.push('', `Recovered interrupted runs: ${recovery.interruptedRunIds.join(', ')}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');
  const unknown = args.filter(arg => !['--dry-run', '--json'].includes(arg));
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
  const result = await runDaily({ dryRun, scannerStdio: json ? 'ignore' : undefined });
  console.log(json ? JSON.stringify(result, null, 2) : formatDailySummary(result));
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(`Daily Runner failed: ${error.message}`);
    process.exitCode = 1;
  });
}
