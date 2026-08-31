#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { buildOperationalDryRun, runOperationalLoop } from './automation/operational-loop.mjs';
import { formatOperationalSummary } from './automation/summary.mjs';
import { openJobRegistry } from './registry/job-registry.mjs';
import { assertStartupReady, validateStartupServiceAccess } from './operations/config-validation.mjs';
import { LocalOperationalLogger } from './operations/logging.mjs';
import { shouldRunScheduled } from './operations/schedule.mjs';
import { createSqliteBackup } from './operations/backup.mjs';

function usage() {
  console.log(`Usage:
  npm run daily:auto
  npm run daily:auto -- --json
  npm run daily:auto -- --dry-run [--json]
  npm run daily:auto -- --scheduled --json

This is the scheduler-ready daily entrypoint. It never applies, submits, or sends outreach.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { usage(); return; }
  const unknown = args.filter(arg => !['--dry-run', '--json', '--scheduled'].includes(arg));
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
  if (args.includes('--dry-run')) {
    const result = buildOperationalDryRun({ dbPath: process.env.CAREER_OPS_DB, spreadsheetId: process.env.CAREER_OPS_SHEET_ID });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.exitCode; return;
  }
  const logger = new LocalOperationalLogger({ root: process.env.CAREER_OPS_LOG_DIR || 'logs' });
  try {
    if (args.includes('--scheduled')) {
      const registry = openJobRegistry();
      let decision;
      try {
        decision = shouldRunScheduled({
          registry, timeZone: process.env.CAREER_OPS_TIMEZONE || 'America/Mexico_City',
          hour: Number(process.env.CAREER_OPS_SCHEDULE_HOUR || 15), minute: Number(process.env.CAREER_OPS_SCHEDULE_MINUTE || 30),
        });
      } finally { registry.close(); }
      if (!decision.run) {
        const skipped = { status: 'SKIPPED', exitCode: 0, scheduled: true, decision };
        logger.write('daily', 'scheduled-skip', skipped);
        console.log(JSON.stringify(skipped, null, 2)); return;
      }
    }
    assertStartupReady();
    await validateStartupServiceAccess();
    if (String(process.env.CAREER_OPS_BACKUP_ENABLED || 'true').toLowerCase() !== 'false') {
      const backup = await createSqliteBackup();
      logger.write('daily', 'sqlite-backup', { destination: backup.destination, bytes: backup.validation.bytes, retained: backup.keep, removed: backup.removed.length });
    }
    const result = await runOperationalLoop();
    logger.write('daily', 'operational-run', { status: result.status, exitCode: result.exitCode, summary: result.summary });
    if (result.summary?.errors?.length) logger.write('errors', 'operational-errors', { runId: result.summary.run.id, errors: result.summary.errors });
    console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : formatOperationalSummary(result.summary));
    process.exitCode = result.exitCode;
  } catch (error) {
    logger.write('errors', 'startup-or-operational-failure', { code: error.code || 'DAILY_AUTO_FAILED', message: error.message, validation: error.result || null });
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(`Daily Operational Loop failed: ${error.message}`); process.exitCode = 1; });
}
