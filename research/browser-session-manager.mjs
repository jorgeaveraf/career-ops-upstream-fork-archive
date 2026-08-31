import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { BROWSER_RESEARCH_MODE } from './browser-policy.mjs';

function exists(file) { try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function normalize(value) { return String(value || '').trim().toLowerCase(); }
function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }

export class BrowserSessionError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'BrowserSessionError'; this.code = code; this.details = details; }
}

export function selectChromeProfile({ profile, mode, userDataDir } = {}) {
  if (normalize(profile) !== 'jorge') throw new BrowserSessionError('BROWSER_PROFILE_DENIED', 'BROWSER_PROFILE must be jorge');
  if (normalize(mode) !== BROWSER_RESEARCH_MODE) throw new BrowserSessionError('BROWSER_MODE_DENIED', `BROWSER_MODE must be ${BROWSER_RESEARCH_MODE}`);
  const root = path.resolve(String(userDataDir || ''));
  if (!userDataDir || !exists(root)) throw new BrowserSessionError('BROWSER_PROFILE_UNAVAILABLE', 'BROWSER_USER_DATA_DIR is unavailable');
  let state;
  try { state = JSON.parse(readFileSync(path.join(root, 'Local State'), 'utf8')); }
  catch (error) { throw new BrowserSessionError('BROWSER_PROFILE_UNAVAILABLE', `cannot read Chrome Local State: ${error.message}`); }
  const matches = Object.entries(state?.profile?.info_cache || {}).filter(([, item]) => normalize(item?.name) === 'jorge');
  if (matches.length !== 1) throw new BrowserSessionError('BROWSER_PROFILE_UNAVAILABLE', `expected exactly one Chrome profile named Jorge; found ${matches.length}`);
  const [profileDirectory, metadata] = matches[0];
  const profilePath = path.resolve(root, profileDirectory);
  if (!profilePath.startsWith(`${root}${path.sep}`) || !exists(profilePath)) throw new BrowserSessionError('BROWSER_PROFILE_UNAVAILABLE', 'resolved Jorge profile directory is unavailable');
  return { profile: 'jorge', mode: BROWSER_RESEARCH_MODE, userDataDir: root, profileDirectory, profilePath, profileName: metadata.name };
}

export class BrowserSessionManager {
  constructor({ lockPath = 'data/browser/.careerops-session.lock', pid = process.pid, processAlive = alive, clock = () => new Date() } = {}) {
    this.lockPath = path.resolve(lockPath); this.pid = pid; this.processAlive = processAlive; this.clock = clock;
  }
  chromeLocks(selection) {
    return [
      path.join(selection.userDataDir, 'SingletonLock'), path.join(selection.userDataDir, 'SingletonSocket'),
      path.join(selection.userDataDir, 'SingletonCookie'), path.join(selection.profilePath, 'LOCK'),
    ].filter(exists);
  }
  inspect(selection) {
    if (exists(this.lockPath)) {
      let owner = null; try { owner = JSON.parse(readFileSync(this.lockPath, 'utf8')); } catch {}
      if (!owner || this.processAlive(owner.pid)) return { available: false, code: 'BROWSER_SESSION_RUNNING', state: owner?.state || 'UNKNOWN', owner };
    }
    return { available: true, code: 'AVAILABLE', state: 'AVAILABLE', userChromeOpen: this.chromeLocks(selection).length > 0 };
  }
  acquire(selection) {
    mkdirSync(path.dirname(this.lockPath), { recursive: true });
    if (exists(this.lockPath)) {
      let owner = null; try { owner = JSON.parse(readFileSync(this.lockPath, 'utf8')); } catch {}
      if (owner && this.processAlive(owner.pid)) throw new BrowserSessionError('BROWSER_SESSION_LOCKED', 'another Career Ops Browser Research session is active', { owner });
      try { unlinkSync(this.lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const sessionId = randomUUID();
    const owner = { version: 2, sessionId, token: randomUUID(), pid: this.pid, profile: selection.profile, acquiredAt: this.clock().toISOString(), windowId: null, state: 'STARTING' };
    let fd; let created = false;
    try {
      fd = openSync(this.lockPath, 'wx', 0o600); created = true; writeFileSync(fd, `${JSON.stringify(owner)}\n`); closeSync(fd); fd = undefined;
      return { ...selection, sessionId, lockPath: this.lockPath, owner };
    } catch (error) {
      if (fd !== undefined) try { closeSync(fd); } catch {}
      if (created) {
        let current = null; try { current = JSON.parse(readFileSync(this.lockPath, 'utf8')); } catch {}
        if (current?.token === owner.token) try { unlinkSync(this.lockPath); } catch {}
      }
      if (error.code === 'EEXIST') throw new BrowserSessionError('BROWSER_SESSION_LOCKED', 'another Career Ops Browser Research session acquired the lock');
      throw error;
    }
  }
  update(session, patch = {}) {
    if (!session?.owner?.token) throw new TypeError('owned browser session is required');
    let current; try { current = JSON.parse(readFileSync(this.lockPath, 'utf8')); }
    catch { throw new BrowserSessionError('BROWSER_SESSION_LOCK_LOST', 'Career Ops browser session lock is unavailable'); }
    if (current.token !== session.owner.token) throw new BrowserSessionError('BROWSER_SESSION_LOCK_LOST', 'Career Ops browser session lock ownership changed');
    const owner = { ...current, ...patch, updatedAt: this.clock().toISOString() };
    writeFileSync(this.lockPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    session.owner = owner; session.windowId = owner.windowId ?? session.windowId ?? null; session.state = owner.state;
    return session;
  }
  release(session) {
    if (!session) return false;
    let current; try { current = JSON.parse(readFileSync(this.lockPath, 'utf8')); } catch { return false; }
    if (current.token !== session.owner.token) return false;
    try { unlinkSync(this.lockPath); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
}

export function browserSelectionFromEnv(env = process.env) {
  return selectChromeProfile({ profile: env.BROWSER_PROFILE, mode: env.BROWSER_MODE, userDataDir: env.BROWSER_USER_DATA_DIR });
}
