#!/usr/bin/env node

import 'dotenv/config';
import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { ContactIntelligenceEngine } from './contact-intelligence/engine.mjs';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';

function usage() {
  console.log(`Usage:
  node contact-intelligence.mjs pending [--job id] [--limit n] [--db path]
  node contact-intelligence.mjs research --job id [--db path]
  node contact-intelligence.mjs show --job id [--db path]

Research uses only evidence already in the registry. No external provider is configured in Increment 7.
Output is context for human review; this command performs no external action.`);
}

function observationInput(row) {
  return row ? {
    id: row.id, company: row.company, sourceUrl: row.source_url, canonicalUrl: row.canonical_url,
    contentHash: row.content_hash, snapshotHash: row.snapshot_hash, retrievedAt: row.last_observed_at,
  } : null;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || ['-h', '--help'].includes(command)) { usage(); return; }
  const dbPath = flagValue(args, '--db') || process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH;
  const jobId = flagValue(args, '--job');
  const registry = openJobRegistry({ dbPath });
  try {
    if (command === 'pending') {
      const candidates = registry.listContactResearchCandidates({ jobId, limit: flagValue(args, '--limit') || 100 });
      console.log(JSON.stringify({ dbPath, count: candidates.length, candidates: candidates.map(item => ({ jobId: item.jobId, applicationPackageId: item.id, packageVersion: item.packageVersion, status: item.status })) }, null, 2));
      return;
    }
    if (!jobId) throw new Error(`${command} requires --job <job-id>`);
    if (command === 'show') {
      console.log(JSON.stringify({ dbPath, research: registry.getContactResearch(jobId) }, null, 2));
      return;
    }
    if (command !== 'research') throw new Error(`unknown command: ${command}`);
    const applicationPackage = registry.listContactResearchCandidates({ jobId, limit: 1 })[0];
    if (!applicationPackage) throw new Error(`no latest VALID DRAFT/APPROVED application package found for job ${jobId}`);
    const job = registry.getJob(jobId);
    const observation = registry.getObservations(jobId).at(-1);
    const artifact = await new ContactIntelligenceEngine().research({
      job: { id: job.id, company: job.canonical_company }, observation: observationInput(observation), applicationPackage,
    });
    console.log(JSON.stringify({ dbPath, research: registry.recordContactResearch(artifact) }, null, 2));
  } finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}

