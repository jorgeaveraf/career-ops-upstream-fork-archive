#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { openJobRegistry } from './registry/job-registry.mjs';

export function feedbackDiagnostic(registry, command = 'summary') {
  if (command === 'rejected') return { rejected: registry.listRejectionFeedback() };
  if (command === 'signals') return { signals: registry.listPreferenceSignals({ activeOnly: false }) };
  const rejected = registry.listRejectionFeedback();
  const signals = registry.listPreferenceSignals();
  return {
    rejected: rejected.length,
    incorporated: rejected.filter(item => item.incorporatedAt).length,
    signals: signals.length,
    observations: signals.filter(item => item.level === 'OBSERVATION').length,
    softSignals: signals.filter(item => item.level === 'SOFT_SIGNAL').length,
    policyCandidates: signals.filter(item => item.level === 'POLICY_CANDIDATE').length,
    hardRules: signals.filter(item => item.level === 'HARD_RULE').length,
  };
}

async function main() {
  const command = process.argv[2] || 'summary';
  if (!['summary', 'rejected', 'signals'].includes(command)) throw new Error('command must be summary, rejected, or signals');
  const registry = openJobRegistry();
  try { console.log(JSON.stringify(feedbackDiagnostic(registry, command), null, 2)); }
  finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(`Feedback diagnostic failed: ${error.message}`); process.exitCode = 1; });
