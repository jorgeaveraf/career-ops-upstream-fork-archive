#!/usr/bin/env node

import 'dotenv/config';
import { pathToFileURL } from 'url';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { openCandidateKnowledge } from './candidate-knowledge/provider.mjs';
import { DeepEvaluationEngine } from './deep-evaluation/engine.mjs';
import { OpenAIResponsesProvider } from './deep-evaluation/llm-provider.mjs';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';

function usage() {
  console.log(`Usage:
  node deep-evaluate.mjs pending [--job id] [--limit n] [--db path]
  node deep-evaluate.mjs evaluate --job id [--llm] [--db path]
  node deep-evaluate.mjs show --job id [--db path]

Evaluation is explicit and accepts only the latest SHORTLIST assessment.
Without --llm, evaluate persists the deterministic evidence baseline.
With --llm, CAREER_OPS_DEEP_MODEL (or CAREER_OPS_MODEL) and OPENAI_API_KEY are required.`);
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
      const candidates = registry.listDeepEvaluationCandidates({ jobId, limit: flagValue(args, '--limit') || 100 });
      console.log(JSON.stringify({ dbPath, count: candidates.length, candidates: candidates.map(item => ({
        jobId: item.job.id, observationId: item.job.observationId, assessmentId: item.assessment.id,
        title: item.job.title, company: item.job.company,
      })) }, null, 2));
      return;
    }
    if (!jobId) throw new Error(`${command} requires --job <job-id>`);
    if (command === 'show') {
      console.log(JSON.stringify({ dbPath, evaluations: registry.getJobEvaluations(jobId) }, null, 2));
      return;
    }
    if (command !== 'evaluate') throw new Error(`unknown command: ${command}`);
    const selected = registry.listDeepEvaluationCandidates({ jobId, limit: 1 })[0];
    if (!selected) throw new Error(`no latest SHORTLIST assessment found for job ${jobId}`);
    const useLLM = hasFlag(args, '--llm');
    const candidateProvider = openCandidateKnowledge({ projectRoot: process.cwd() });
    const llmProvider = useLLM ? new OpenAIResponsesProvider() : null;
    const artifact = await new DeepEvaluationEngine({ candidateProvider, llmProvider })
      .evaluate({ ...selected, useLLM });
    const stored = registry.recordJobEvaluation(artifact);
    console.log(JSON.stringify({ dbPath, stored }, null, 2));
  } finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}

