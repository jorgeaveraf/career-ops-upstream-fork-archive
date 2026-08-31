import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export const DEFAULT_DAILY_LOCK_PATH = 'data/daily-run.lock';
export const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export class DailyLockError extends Error {
  constructor(message, owner = null) {
    super(message);
    this.name = 'DailyLockError';
    this.code = 'DAILY_RUN_LOCKED';
    this.owner = owner;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function lockIsStale(owner, { nowMs, staleAfterMs, processAlive }) {
  if (!owner) return true;
  const heartbeatMs = new Date(owner.heartbeatAt || owner.acquiredAt).getTime();
  const expired = !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > staleAfterMs;
  return expired || !processAlive(owner.pid);
}

export function acquireDailyLock({
  lockPath = DEFAULT_DAILY_LOCK_PATH,
  runId,
  pid = process.pid,
  now = new Date(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  processAlive = isProcessAlive,
} = {}) {
  const absolutePath = path.resolve(lockPath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  const token = randomUUID();
  const at = new Date(now).toISOString();
  const owner = { version: 1, token, runId, pid, acquiredAt: at, heartbeatAt: at };
  let recoveredOwner = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(absolutePath, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8');
      closeSync(fd);
      return { lockPath: absolutePath, owner, recoveredOwner };
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      if (error?.code !== 'EEXIST') throw error;
      const current = readOwner(absolutePath);
      if (attempt > 0 || !lockIsStale(current, {
        nowMs: new Date(now).getTime(), staleAfterMs, processAlive,
      })) {
        throw new DailyLockError('another daily run owns the lock', current);
      }
      recoveredOwner = current;
      try {
        unlinkSync(absolutePath);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  throw new DailyLockError('could not acquire daily run lock');
}

export function heartbeatDailyLock(lock, now = new Date()) {
  const current = readOwner(lock.lockPath);
  if (!current || current.token !== lock.owner.token) {
    throw new DailyLockError('daily run lock ownership changed', current);
  }
  const next = { ...current, heartbeatAt: new Date(now).toISOString() };
  const temporaryPath = `${lock.lockPath}.${lock.owner.token}.heartbeat`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, lock.lockPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* absent or already renamed */ }
    throw error;
  }
  lock.owner = next;
  return next;
}

export function releaseDailyLock(lock) {
  if (!lock) return false;
  const current = readOwner(lock.lockPath);
  if (!current || current.token !== lock.owner.token) return false;
  try {
    unlinkSync(lock.lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
