#!/usr/bin/env node

import 'dotenv/config';
import { pathToFileURL } from 'url';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';
import { selectTodayMembership } from './human-control-plane/today-membership.mjs';
import { flagValue } from './lib/cli-flags.mjs';

export function buildTodayDiagnostic(data, options = {}) {
  const membership = selectTodayMembership(data, options);
  return {
    version:'4.6', generatedFrom:'AUTHORITATIVE_JOB_REGISTRY',
    ...membership.diagnostics,
  };
}

function usage() {
  console.log(`Usage:
  node today-diagnostics.mjs [--db path] [--trace]

Read-only V4.6 TODAY admission/refill diagnostic. --trace includes every
Registry candidate considered and its exact admission/exclusion rule.`);
}

function main() {
  const args=process.argv.slice(2);if(args.includes('--help')||args.includes('-h')){usage();return;}
  const dbPath=flagValue(args,'--db')||process.env.CAREER_OPS_DB||DEFAULT_REGISTRY_PATH;
  const registry=openJobRegistry({dbPath});
  try {
    const diagnostic=buildTodayDiagnostic(registry.getControlPlaneData({candidateScope:'decision',includeAttention:false}));
    if(!args.includes('--trace'))delete diagnostic.trace;
    console.log(JSON.stringify(diagnostic,null,2));
  } finally { registry.close(); }
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main();
