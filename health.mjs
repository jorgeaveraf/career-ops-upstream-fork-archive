#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { runHealthCheck, formatHealth } from './operations/health.mjs';
import { LocalOperationalLogger } from './operations/logging.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log('Usage: npm run health -- [--json] [--db path] [--no-log]'); return;
  }
  const result = await runHealthCheck({ dbPath: flagValue(args, '--db') || process.env.CAREER_OPS_DB || 'data/career.db' });
  if (!hasFlag(args, '--no-log')) new LocalOperationalLogger().write('health', 'health-check', { status: result.status, checks: result.checks });
  console.log(hasFlag(args, '--json') ? JSON.stringify(result, null, 2) : formatHealth(result));
  process.exitCode = result.healthy ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(`Health check failed: ${error.message}`); process.exitCode = 1; });
