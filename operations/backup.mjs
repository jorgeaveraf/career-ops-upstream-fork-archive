import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION } from '../registry/job-registry.mjs';

const backupName = date => `career-${date.toISOString().replace(/[:.]/g, '-')}.db`;

export function validateBackup(file) {
  const absolute = path.resolve(file);
  if (!existsSync(absolute)) return { valid: false, path: absolute, error: 'backup not found' };
  let db;
  try {
    db = new Database(absolute, { readonly: true, fileMustExist: true });
    const quickCheck = db.pragma('quick_check', { simple: true });
    const schemaVersion = db.pragma('user_version', { simple: true });
    const requiredTables = ['jobs', 'job_evaluations', 'application_packages', 'human_actions', 'operational_runs'];
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    const missingTables = requiredTables.filter(name => !tables.has(name));
    return { valid: quickCheck === 'ok' && missingTables.length === 0, path: absolute, quickCheck, schemaVersion, currentSchema: schemaVersion === CURRENT_SCHEMA_VERSION, missingTables, bytes: statSync(absolute).size };
  } catch (error) { return { valid: false, path: absolute, error: error.message }; }
  finally { db?.close(); }
}

export async function createSqliteBackup({
  dbPath = process.env.CAREER_OPS_DB || 'data/career.db', outputDir = process.env.CAREER_OPS_BACKUP_DIR || 'backups/sqlite',
  keep = Number.parseInt(process.env.CAREER_OPS_BACKUP_KEEP || '30', 10), clock = () => new Date(),
} = {}) {
  const source = path.resolve(dbPath); const destinationDir = path.resolve(outputDir);
  if (!existsSync(source)) throw new Error(`SQLite database not found: ${source}`);
  if (!Number.isInteger(keep) || keep < 1) throw new TypeError('backup retention must be a positive integer');
  mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  const base = backupName(clock()); let destination = path.join(destinationDir, base);
  for (let suffix = 1; existsSync(destination); suffix++) destination = path.join(destinationDir, base.replace(/\.db$/, `-${suffix}.db`));
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try { await db.backup(destination); } finally { db.close(); }
  chmodSync(destination, 0o600);
  const validation = validateBackup(destination);
  if (!validation.valid) throw new Error(`created backup failed validation: ${validation.error || validation.quickCheck}`);
  const candidates = readdirSync(destinationDir).filter(name => /^career-.+\.db$/.test(name)).sort().reverse();
  const removed = [];
  for (const name of candidates.slice(keep)) { const target = path.join(destinationDir, name); unlinkSync(target); removed.push(target); }
  return { source, destination, keep, removed, validation };
}
