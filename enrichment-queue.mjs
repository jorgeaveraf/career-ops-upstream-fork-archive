#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { openJobRegistry } from './registry/job-registry.mjs';

async function main() {
  const command = process.argv[2] || 'pending';
  if (!['pending', 'all'].includes(command)) throw new Error('command must be pending or all');
  const registry = openJobRegistry();
  try {
    const requests = registry.listEnrichmentRequests({ status: command === 'pending' ? 'PENDING' : null });
    console.log(JSON.stringify({ count: requests.length, requests }, null, 2));
  } finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(`Enrichment queue diagnostic failed: ${error.message}`); process.exitCode = 1; });
