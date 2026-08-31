export function managedBrowserSessionConfigFromEnv(env = process.env) {
  const sessionName = String(env.BROWSER_SESSION_NAME || 'career_ops').trim();
  const sessionKind = String(env.BROWSER_SESSION_KIND || 'managed_window').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/i.test(sessionName)) throw new TypeError('BROWSER_SESSION_NAME must contain only letters, digits, underscore, or hyphen');
  if (sessionKind !== 'managed_window') throw new TypeError('BROWSER_SESSION_KIND must be managed_window');
  return { sessionName, sessionKind };
}

export class ManagedBrowserSession {
  constructor({ lockManager, windowDriver, sessionName = 'career_ops', sessionKind = 'managed_window' } = {}) {
    if (!lockManager) throw new TypeError('browser session lock manager is required');
    if (!windowDriver || typeof windowDriver.openWindow !== 'function' || typeof windowDriver.closeWindow !== 'function') throw new TypeError('managed Chrome window driver is required');
    if (!/^[a-z0-9_-]{1,64}$/i.test(sessionName)) throw new TypeError('BROWSER_SESSION_NAME must contain only letters, digits, underscore, or hyphen');
    if (sessionKind !== 'managed_window') throw new TypeError('BROWSER_SESSION_KIND must be managed_window');
    this.lockManager = lockManager; this.windowDriver = windowDriver; this.sessionName = sessionName; this.sessionKind = sessionKind;
  }

  async inspect(selection) {
    const lock = this.lockManager.inspect(selection);
    return { ...lock, sessionName: this.sessionName, sessionKind: this.sessionKind, userWindowsManaged: false };
  }

  async acquire(selection) {
    const session = this.lockManager.acquire(selection);
    try {
      const window = await this.windowDriver.openWindow({ selection, sessionId: session.sessionId, sessionName: this.sessionName, sessionKind: this.sessionKind });
      session.windowId = window.windowId; session.window = window; session.windowDriver = this.windowDriver;
      this.lockManager.update(session, { windowId: window.windowId, state: 'RUNNING', sessionName: this.sessionName, sessionKind: this.sessionKind });
      return session;
    } catch (error) {
      try { this.lockManager.update(session, { state: 'FAILED' }); } catch {}
      this.lockManager.release(session);
      throw error;
    }
  }

  async release(session) {
    if (!session) return false;
    let closeError = null;
    try {
      this.lockManager.update(session, { state: 'CLOSING' });
      if (session.windowId != null) await this.windowDriver.closeWindow(session.windowId);
    } catch (error) { closeError = error; }
    finally { this.lockManager.release(session); }
    if (closeError) throw closeError;
    return true;
  }

  async pause(session) {
    if (!session) return false;
    this.lockManager.update(session, { state: 'PAUSED_FOR_HUMAN' });
    this.lockManager.release(session);
    return true;
  }

  async resume(selection, context = {}) {
    const session = this.lockManager.acquire(selection);
    try {
      const adopted = await this.windowDriver.adoptWindow(context);
      session.windowId = adopted.windowId;
      session.window = { windowId: adopted.windowId, markerUrl: adopted.markerUrl };
      session.windowDriver = this.windowDriver;
      this.lockManager.update(session, { windowId: adopted.windowId, state: 'RESUMING', sessionName: this.sessionName, sessionKind: this.sessionKind });
      return { ...session, adopted };
    } catch (error) {
      try { this.lockManager.update(session, { state: 'FAILED' }); } catch {}
      this.lockManager.release(session);
      throw error;
    }
  }
}
