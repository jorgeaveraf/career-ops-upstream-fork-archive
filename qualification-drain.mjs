#!/usr/bin/env node
import { openJobRegistry } from './registry/job-registry.mjs';
import { drainQualificationBacklog } from './automation/qualification-orchestrator.mjs';

const numberFlag = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? Number(process.argv[index + 1]) : fallback; };
const registry = openJobRegistry();
try {
  const result = await drainQualificationBacklog({
    registry,
    fullActivePass: process.argv.includes('--full-active-pass'),
    budget: { evaluations: numberFlag('--evaluations', 100), runtimeMs: numberFlag('--runtime-ms', 600_000) },
  });
  const { evaluations: _evaluations, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
} finally { registry.close(); }
