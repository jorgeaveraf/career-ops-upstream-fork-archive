#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';
import { ELIGIBILITY_RULES_VERSION, RANKING_RULES_VERSION } from './intelligence/contracts.mjs';
import { assessOpportunity } from './intelligence/funnel.mjs';
import { loadOpportunityPolicy } from './intelligence/profile-policy.mjs';

function usage() {
  console.log(`Usage:
  node opportunity-funnel.mjs assess [--job id | --run id] [--limit n] [--db path]
  node opportunity-funnel.mjs pending [--run id] [--limit n] [--db path]
  node opportunity-funnel.mjs show <job-id> [--db path]

Assessment is explicit. Nothing runs automatically from scan.mjs or Daily Runner.`);
}

export function assessCandidates(registry, candidates, policy, { calculatedAt } = {}) {
  return candidates.map(candidate => registry.recordAssessment(
    candidate.jobId,
    candidate.observationId,
    assessOpportunity(candidate, policy, { calculatedAt }),
  ));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '--help' || command === '-h') return usage();
  const dbPath = flagValue(args, '--db') || process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH;
  const registry = openJobRegistry({ dbPath });
  try {
    if (command === 'show') {
      const jobId = args[1];
      if (!jobId || jobId.startsWith('--')) throw new Error('show requires a job ID');
      console.log(JSON.stringify({ jobId, assessments: registry.getAssessments(jobId) }, null, 2));
      return;
    }
    if (!['assess', 'pending'].includes(command)) throw new Error(`unknown command: ${command}`);
    const policy = loadOpportunityPolicy({
      profilePath: flagValue(args, '--profile') || process.env.CAREER_OPS_PROFILE || 'config/profile.yml',
      portalsPath: flagValue(args, '--portals') || process.env.CAREER_OPS_PORTALS || 'portals.yml',
    });
    const jobId = flagValue(args, '--job');
    const runId = flagValue(args, '--run');
    const limit = Number.parseInt(flagValue(args, '--limit') || '100', 10);
    let candidates = registry.listAssessmentCandidates({
      eligibilityRulesVersion: ELIGIBILITY_RULES_VERSION,
      rankingRulesVersion: RANKING_RULES_VERSION,
      profileHash: policy.profileHash,
      runId,
      jobId,
      limit,
    });
    if (command === 'pending') {
      console.log(JSON.stringify({
        dbPath, count: candidates.length,
        rules: { eligibility: ELIGIBILITY_RULES_VERSION, ranking: RANKING_RULES_VERSION },
        profileHash: policy.profileHash,
        candidates,
      }, null, 2));
      return;
    }
    const assessments = assessCandidates(registry, candidates, policy);
    console.log(JSON.stringify({ dbPath, count: assessments.length, assessments }, null, 2));
  } finally {
    registry.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
