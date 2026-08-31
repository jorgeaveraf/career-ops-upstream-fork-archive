#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { inferExternalJobId } from './acquisition/normalize.mjs';
import { openJobRegistry, DEFAULT_REGISTRY_PATH } from './registry/job-registry.mjs';

const BOOTSTRAP_FORMAT_VERSION = 1;

function usage() {
  console.log(`Usage:
  node job-registry.mjs schema [--db path]
  node job-registry.mjs jobs [--db path]
  node job-registry.mjs summary <run-id> [--db path]
  node job-registry.mjs bootstrap [--db path] [--history path] [--pipeline path]

bootstrap is explicit, additive, and idempotent. It never changes Markdown.`);
}

function safeIsoDate(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? `${value}T00:00:00.000Z` : fallback;
}

export function parseScanHistory(text) {
  const rows = [];
  const lines = String(text ?? '').replace(/\r/g, '').split('\n').filter(Boolean);
  if (lines.length === 0) return rows;
  const header = lines[0].split('\t');
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const sourceUrl = cells[index.url] || '';
    const title = cells[index.title] || '';
    const company = cells[index.company] || '';
    if (!sourceUrl || !title || !company) continue;
    const provider = cells[index.portal] || 'legacy-scan-history';
    rows.push({
      provider,
      externalId: inferExternalJobId(provider, sourceUrl),
      sourceUrl,
      canonicalUrl: sourceUrl,
      title,
      company,
      location: cells[index.location] || '',
      postedAt: safeIsoDate(cells[index.posted_at], undefined),
      retrievedAt: safeIsoDate(cells[index.first_seen], undefined),
      extractionMethod: 'legacy_import',
      confidence: 'high',
      rawMetadata: {
        source: 'data/scan-history.tsv',
        legacyStatus: cells[index.status] || '',
        legacyFingerprint: cells[index.fingerprint] || '',
        trustScore: cells[index.trust_score] || '',
        trustFlags: cells[index.trust_flags] || '',
      },
    });
  }
  return rows;
}

export function parsePipeline(text, retrievedAt) {
  const rows = [];
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!/^- \[[ x]\]/.test(line)) continue;
    const parts = line.split('|').map(part => part.trim());
    const urlIndex = parts.findIndex(part => /https?:\/\/\S+/.test(part));
    const sourceUrl = urlIndex >= 0 ? parts[urlIndex].match(/https?:\/\/\S+/)?.[0] || '' : '';
    const company = urlIndex >= 0 ? parts[urlIndex + 1] || '' : '';
    const title = urlIndex >= 0 ? parts[urlIndex + 2] || '' : '';
    if (!sourceUrl || !company || !title) continue;
    const dispositionText = line.match(/\b(?:note:\s*)?(EVALUADA|EVALUATED|DESCARTADA|DISCARDED|SKIP)\b/i)?.[1]?.toUpperCase() || '';
    const legacyDisposition = dispositionText === 'EVALUADA' ? 'EVALUATED'
      : dispositionText === 'DESCARTADA' ? 'DISCARDED'
        : dispositionText;
    rows.push({
      provider: 'legacy-pipeline',
      sourceUrl,
      canonicalUrl: sourceUrl,
      title,
      company,
      location: parts[urlIndex + 3] && !/^(posted|trust|note):/i.test(parts[urlIndex + 3]) ? parts[urlIndex + 3] : '',
      retrievedAt,
      extractionMethod: 'legacy_import',
      confidence: 'medium',
      rawMetadata: {
        source: 'data/pipeline.md',
        processed: line.startsWith('- [x]'),
        legacyDisposition: legacyDisposition || null,
        originalLine: line,
      },
    });
  }
  return rows;
}

export function bootstrapRegistry(registry, {
  historyPath = 'data/scan-history.tsv',
  pipelinePath = 'data/pipeline.md',
  now = new Date().toISOString(),
} = {}) {
  const historyText = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
  const pipelineText = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf8') : '';
  const digest = createHash('sha256')
    .update(`job-registry-bootstrap-v${BOOTSTRAP_FORMAT_VERSION}\0`)
    .update(historyText).update('\0').update(pipelineText).digest('hex');
  const runId = `bootstrap-${digest.slice(0, 24)}`;
  const existing = registry.getRun(runId);
  if (existing?.status === 'SUCCESS') return { ...registry.getRunSummary(runId), reused: true };
  registry.startRun({
    id: runId,
    type: 'bootstrap',
    startedAt: now,
    metadata: { historyPath, pipelinePath, sourceHash: digest, bootstrapFormatVersion: BOOTSTRAP_FORMAT_VERSION },
  });

  const history = parseScanHistory(historyText).map(row => ({ ...row, retrievedAt: row.retrievedAt || now }));
  const pipeline = parsePipeline(pipelineText, now);
  const results = registry.recordObservations(runId, [...history, ...pipeline]);
  for (let i = 0; i < pipeline.length; i++) {
    const disposition = pipeline[i].rawMetadata.legacyDisposition;
    if (disposition) registry.setJobStatus(results[history.length + i].jobId, disposition, now);
  }
  return { ...registry.finishRun(runId), imported: { history: history.length, pipeline: pipeline.length }, reused: false };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }
  const dbPath = flagValue(args, '--db') || process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH;
  const registry = openJobRegistry({ dbPath });
  try {
    if (command === 'schema') {
      console.log(JSON.stringify({ dbPath, schemaVersion: registry.getSchemaVersion() }, null, 2));
    } else if (command === 'jobs') {
      const jobs = registry.db.prepare(`
        SELECT j.*, COUNT(o.id) AS observations
        FROM jobs j LEFT JOIN job_observations o ON o.job_id = j.id
        GROUP BY j.id ORDER BY j.last_seen_at DESC
      `).all();
      console.log(JSON.stringify({ dbPath, count: jobs.length, jobs }, null, 2));
    } else if (command === 'summary') {
      const runId = args[1];
      if (!runId || runId.startsWith('--')) throw new Error('summary requires a run ID');
      const summary = registry.getRunSummary(runId);
      if (!summary) throw new Error(`run not found: ${runId}`);
      console.log(JSON.stringify(summary, null, 2));
    } else if (command === 'bootstrap') {
      const result = bootstrapRegistry(registry, {
        historyPath: flagValue(args, '--history') || 'data/scan-history.tsv',
        pipelinePath: flagValue(args, '--pipeline') || 'data/pipeline.md',
      });
      console.log(JSON.stringify({ dbPath, ...result }, null, 2));
    } else {
      throw new Error(`unknown command: ${command}`);
    }
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
