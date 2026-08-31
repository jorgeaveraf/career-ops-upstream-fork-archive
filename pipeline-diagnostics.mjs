#!/usr/bin/env node

import 'dotenv/config';
import { pathToFileURL } from 'url';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';
import { selectPipelineAdmission } from './intelligence/pipeline-admission.mjs';
import { selectTodayMembership } from './human-control-plane/today-membership.mjs';
import { flagValue } from './lib/cli-flags.mjs';

export function buildPipelineDiagnostic(data) {
  const pipeline = selectPipelineAdmission(data);
  const today = selectTodayMembership(data, { pipeline });
  return {
    version: '4.7', generatedFrom: 'AUTHORITATIVE_JOB_REGISTRY', policyVersion: pipeline.policyVersion,
    thresholds: pipeline.thresholds, registryCount: pipeline.registryCount, activeCandidates: pipeline.activeCandidates,
    admittedPipelineCount: pipeline.admitted.length, excludedPipelineCount: pipeline.excludedCount,
    excludedByRule: pipeline.excludedByRule, metrics: pipeline.metrics,
    pipelineRanks: pipeline.admitted.map(value => ({ rank: value.pipelineRank, jobId: value.jobId,
      company: value.item.job.company, role: value.item.job.title, finalPriority: value.finalPriority,
      candidateFit: value.candidateFit, opportunityQuality: value.opportunityQuality,
      evidenceConfidence: value.evidenceConfidence, state: value.decision === 'HOLD' ? 'HOLD' : 'ACTIVE' })),
    today: { target: today.target, curatedFromPipeline: today.curated.length,
      humanCarryovers: today.carryovers.map(value => ({ jobId: value.jobId, company: value.item.job.company,
        role: value.item.job.title, reason: value.admissionDetail })), finalCount: today.members.length, outcome: today.outcome },
    trace: pipeline.trace,
  };
}

function usage() {
  console.log(`Usage:
  node pipeline-diagnostics.mjs [--db path] [--trace]

Read-only V4.7 Registry -> strong Pipeline admission trace. --trace includes
every Registry candidate and its exact admission/exclusion rule.`);
}

function main() {
  const args=process.argv.slice(2);if(args.includes('--help')||args.includes('-h')){usage();return;}
  const registry=openJobRegistry({dbPath:flagValue(args,'--db')||process.env.CAREER_OPS_DB||DEFAULT_REGISTRY_PATH});
  try { const diagnostic=buildPipelineDiagnostic(registry.getControlPlaneData({candidateScope:'decision',includeAttention:false}));
    if(!args.includes('--trace'))delete diagnostic.trace;console.log(JSON.stringify(diagnostic,null,2));
  } finally { registry.close(); }
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main();
