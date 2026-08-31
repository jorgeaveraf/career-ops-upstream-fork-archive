#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { createSqliteBackup, validateBackup } from './operations/backup.mjs';

function usage() {
  console.log(`Usage:
  npm run backup -- create [--db path] [--out directory] [--keep number]
  npm run backup -- validate <backup.db>`);
}

async function main() {
  const args = process.argv.slice(2); const command = args[0];
  if (!command || ['--help', '-h'].includes(command)) { usage(); return; }
  if (command === 'validate') {
    if (!args[1]) throw new Error('validate requires a backup path');
    const result = validateBackup(args[1]); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.valid ? 0 : 1; return;
  }
  if (command !== 'create') throw new Error(`unknown command: ${command}`);
  const result = await createSqliteBackup({
    dbPath: flagValue(args, '--db') || process.env.CAREER_OPS_DB || 'data/career.db',
    outputDir: flagValue(args, '--out') || process.env.CAREER_OPS_BACKUP_DIR || 'backups/sqlite',
    keep: Number.parseInt(flagValue(args, '--keep') || process.env.CAREER_OPS_BACKUP_KEEP || '30', 10),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; });
