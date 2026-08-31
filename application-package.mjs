#!/usr/bin/env node

import 'dotenv/config';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { openCandidateKnowledge } from './candidate-knowledge/provider.mjs';
import { ApplicationPackageEngine } from './application-package/engine.mjs';
import { OpenAIResponsesProvider } from './deep-evaluation/llm-provider.mjs';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';

function usage() {
  console.log(`Usage:
  node application-package.mjs pending [--job id] [--limit n] [--db path]
  node application-package.mjs generate --job id [--llm] [--cv path] [--db path]
  node application-package.mjs show --job id [--db path]
  node application-package.mjs review --package id --status DRAFT|REVIEW_REQUIRED|APPROVED|ARCHIVED [--db path]

This command creates drafts only. APPROVED records human review and triggers no send, submit, or application action.
With --llm, CAREER_OPS_PACKAGE_MODEL (or CAREER_OPS_DEEP_MODEL/CAREER_OPS_MODEL) and OPENAI_API_KEY are required.`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '--help' || command === '-h') { usage(); return; }
  const dbPath = flagValue(args, '--db') || process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH;
  const jobId = flagValue(args, '--job');
  const registry = openJobRegistry({ dbPath });
  try {
    if (command === 'pending') {
      const rows = registry.listApplicationPackageCandidates({ jobId, limit: flagValue(args, '--limit') || 100 });
      console.log(JSON.stringify({ dbPath, count: rows.length, candidates: rows.map(item => ({
        jobId: item.jobId, evaluationId: item.id, recommendation: item.recommendation, overallFit: item.overallFit,
        title: item.jobAnalysis.title, company: item.jobAnalysis.company,
      })) }, null, 2));
      return;
    }
    if (command === 'review') {
      const packageId = flagValue(args, '--package');
      const status = flagValue(args, '--status');
      if (!packageId || !status) throw new Error('review requires --package <id> and --status <status>');
      console.log(JSON.stringify({ dbPath, package: registry.updateApplicationPackageStatus(packageId, status) }, null, 2));
      return;
    }
    if (!jobId) throw new Error(`${command} requires --job <job-id>`);
    if (command === 'show') {
      console.log(JSON.stringify({ dbPath, packages: registry.getApplicationPackages(jobId) }, null, 2));
      return;
    }
    if (command !== 'generate') throw new Error(`unknown command: ${command}`);
    const evaluation = registry.listApplicationPackageCandidates({ jobId, limit: 1 })[0];
    if (!evaluation) throw new Error(`no latest VALID APPLY evaluation found for job ${jobId}`);
    const canonicalCv = readFileSync(flagValue(args, '--cv') || 'cv.md', 'utf8');
    const useLLM = hasFlag(args, '--llm');
    const candidateProvider = openCandidateKnowledge({ projectRoot: process.cwd() });
    const llmProvider = useLLM ? new OpenAIResponsesProvider({
      model: process.env.CAREER_OPS_PACKAGE_MODEL || process.env.CAREER_OPS_DEEP_MODEL || process.env.CAREER_OPS_MODEL,
    }) : null;
    const artifact = await new ApplicationPackageEngine({ candidateProvider, llmProvider })
      .generate({ evaluationArtifact: evaluation, canonicalCv, useLLM });
    console.log(JSON.stringify({ dbPath, package: registry.recordApplicationPackage(artifact) }, null, 2));
  } finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}

