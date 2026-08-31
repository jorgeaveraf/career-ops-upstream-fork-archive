#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { runEligibilityEvidenceRepair } from './automation/eligibility-evidence-repair.mjs';
import { createSqliteBackup } from './operations/backup.mjs';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';

function usage() {
  console.log(`Usage:
  npm run eligibility:repair -- [--dry-run] [--json]

Reassesses only the current bounded Active Candidate Set. It performs no discovery,
browser navigation, enrichment, Google Sheets changes, or outbound actions.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return usage();
  const unknown = args.filter(arg => !['--dry-run', '--json'].includes(arg));
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
  const dbPath = process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH;
  const dryRun = args.includes('--dry-run');
  if (!dryRun && dbPath !== ':memory:' && String(process.env.CAREER_OPS_BACKUP_ENABLED || 'true').toLowerCase() !== 'false') await createSqliteBackup({ dbPath });
  const registry = openJobRegistry({ dbPath });
  try {
    const result = await runEligibilityEvidenceRepair({ registry, dryRun });
    console.log(JSON.stringify({ dbPath, schemaVersion: registry.getSchemaVersion(), ...result }, null, 2));
  } finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(`Eligibility repair failed: ${error.message}`); process.exitCode = 1; });
}
