import { execFile as execFileCallback } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { BrowserSessionError } from './browser-session-manager.mjs';

const execFile = promisify(execFileCallback);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const LIST_WINDOWS = `tell application "Google Chrome"
  if not running then return ""
  return id of every window
end tell`;

const CLOSE_WINDOW = `on run argv
  set targetId to item 1 of argv as integer
  tell application "Google Chrome"
    if exists window id targetId then close window id targetId
  end tell
end run`;

const DESCRIBE_WINDOW = `on run argv
  set targetId to item 1 of argv as integer
  tell application "Google Chrome"
    if not (exists window id targetId) then error "window unavailable"
    tell window id targetId
      return (mode as text) & "|" & (URL of active tab as text)
    end tell
  end tell
end run`;

const OPEN_TAB = `on run argv
  set targetId to item 1 of argv as integer
  set targetUrl to item 2 of argv
  tell application "Google Chrome"
    if not (exists window id targetId) then error "owned window unavailable"
    tell window id targetId
      set createdTab to make new tab with properties {URL:targetUrl}
      return id of createdTab
    end tell
  end tell
end run`;

const CLOSE_TAB = `on run argv
  set targetWindowId to item 1 of argv as integer
  set targetTabId to item 2 of argv as integer
  tell application "Google Chrome"
    if exists window id targetWindowId then
      tell window id targetWindowId
        if exists tab id targetTabId then close tab id targetTabId
      end tell
    end if
  end tell
end run`;

const READ_TAB_METADATA = `on run argv
  set targetWindowId to item 1 of argv as integer
  set targetTabId to item 2 of argv as integer
  tell application "Google Chrome"
    if not (exists window id targetWindowId) then error "owned window unavailable"
    tell window id targetWindowId
      if not (exists tab id targetTabId) then error "owned tab unavailable"
      tell tab id targetTabId to return (title as text) & (ASCII character 31) & (URL as text) & (ASCII character 31) & (loading as text)
    end tell
  end tell
end run`;

const EXECUTE_JAVASCRIPT = `on run argv
  set targetWindowId to item 1 of argv as integer
  set targetTabId to item 2 of argv as integer
  set sourceCode to item 3 of argv
  tell application "Google Chrome"
    if not (exists window id targetWindowId) then error "owned window unavailable"
    tell window id targetWindowId
      if not (exists tab id targetTabId) then error "owned tab unavailable"
      return execute tab id targetTabId javascript sourceCode
    end tell
  end tell
end run`;

const ACTIVATE_WINDOW = `on run argv
  set targetWindowId to item 1 of argv as integer
  tell application "Google Chrome"
    activate
    if not (exists window id targetWindowId) then error "owned window unavailable"
    set index of window id targetWindowId to 1
  end tell
end run`;

const ADOPT_WINDOW = `on run argv
  set targetWindowId to item 1 of argv as integer
  set targetTabId to item 2 of argv as integer
  set markerUrl to item 3 of argv
  tell application "Google Chrome"
    if not (exists window id targetWindowId) then error "owned window unavailable"
    tell window id targetWindowId
      set markerFound to false
      repeat with candidateTab in every tab
        if (URL of candidateTab as text) is markerUrl then set markerFound to true
      end repeat
      if markerFound is false then error "career ops marker unavailable"
      if not (exists tab id targetTabId) then error "owned tab unavailable"
      return URL of tab id targetTabId as text
    end tell
  end tell
end run`;

const CHOOSE_FILE = `on run argv
  set targetPath to item 1 of argv
  tell application "System Events"
    keystroke "g" using {command down, shift down}
    delay 0.3
    keystroke targetPath
    key code 36
    delay 0.4
    key code 36
  end tell
end run`;

function parseIds(value) {
  return String(value || '').split(',').map(item => Number.parseInt(item.trim(), 10)).filter(Number.isInteger);
}

export class MacOsChromeWindowDriver {
  constructor({ run = execFile, sleep = delay, attempts = 50, pollMs = 100, connectionRetries = 10, platform = process.platform } = {}) {
    this.run = run; this.sleep = sleep; this.attempts = attempts; this.pollMs = pollMs;
    this.connectionRetries = connectionRetries; this.platform = platform;
    this.ownedWindows = new Set(); this.ownedTabs = new Map();
  }
  async script(source, args = []) {
    let lastError;
    for (let attempt = 0; attempt <= this.connectionRetries; attempt++) {
      try {
        const { stdout = '' } = await this.run('/usr/bin/osascript', ['-e', source, ...args.map(String)]);
        return String(stdout).trim();
      } catch (error) {
        lastError = error;
        if (!/-609|connection (?:is|was) invalid|conexi[oó]n no es v[aá]lida/i.test(String(error.stderr || error.message || ''))) throw error;
        if (attempt < this.connectionRetries) await this.sleep(this.pollMs);
      }
    }
    throw lastError;
  }
  async listWindowIds() {
    try { return parseIds(await this.script(LIST_WINDOWS)); }
    catch (error) {
      if (/-600|application (?:is not|isn't) running|aplicaci[oó]n no est[aá] abierta/i.test(String(error.stderr || error.message || ''))) return [];
      throw error;
    }
  }
  async describeWindow(windowId) {
    const [mode = '', url = ''] = (await this.script(DESCRIBE_WINDOW, [windowId])).split('|', 2);
    return { mode: mode.trim().toLowerCase(), url: url.trim() };
  }
  async isExpectedResearchWindow(windowId, markerUrl) {
    const description = await this.describeWindow(windowId);
    return description.mode === 'normal' && description.url === markerUrl;
  }
  assertOwnedWindow(windowId) {
    if (!this.ownedWindows.has(Number(windowId))) throw new BrowserSessionError('BROWSER_WINDOW_NOT_OWNED', 'refusing to control a Chrome window not owned by Career Ops', { windowId });
  }
  assertOwnedTab(windowId, tabId) {
    this.assertOwnedWindow(windowId);
    if (!this.ownedTabs.get(Number(windowId))?.has(Number(tabId))) throw new BrowserSessionError('BROWSER_TAB_NOT_OWNED', 'refusing to control a Chrome tab not owned by Career Ops', { windowId, tabId });
  }
  async openWindow({ selection, sessionId, sessionName = 'career_ops', sessionKind = 'managed_window' } = {}) {
    if (this.platform !== 'darwin') throw new BrowserSessionError('BROWSER_DRIVER_UNAVAILABLE', 'managed Chrome window driver currently requires macOS');
    if (sessionKind !== 'managed_window') throw new BrowserSessionError('BROWSER_SESSION_KIND_DENIED', 'managed Chrome window driver requires a normal managed_window session');
    if (!sessionId) throw new TypeError('Career Ops browser session ID is required');
    const before = new Set(await this.listWindowIds());
    const markerUrl = `file:///dev/null#career-ops-${encodeURIComponent(sessionName)}-${encodeURIComponent(sessionId)}`;
    const args = ['-n', '-a', 'Google Chrome', '--args', `--profile-directory=${selection.profileDirectory}`, '--new-window'];
    args.push(markerUrl);
    let launched = false;
    try {
      await this.run('/usr/bin/open', args); launched = true;
      for (let attempt = 0; attempt < this.attempts; attempt++) {
        const ids = await this.listWindowIds(); const newIds = ids.filter(id => !before.has(id));
        if (newIds.length === 1) {
          const [windowId] = newIds;
          if (!(await this.isExpectedResearchWindow(windowId, markerUrl))) {
            throw new BrowserSessionError('BROWSER_WINDOW_UNVERIFIED', 'new Chrome window does not match the requested normal managed research window; refusing to claim it', { windowId });
          }
          this.ownedWindows.add(windowId); this.ownedTabs.set(windowId, new Set());
          return { windowId, sessionKind, markerUrl, preexistingWindowIds: [...before] };
        }
        if (newIds.length > 1) throw new BrowserSessionError('BROWSER_WINDOW_AMBIGUOUS', 'more than one Chrome window appeared; refusing to claim any window', { newIds });
        await this.sleep(this.pollMs);
      }
      throw new BrowserSessionError('BROWSER_WINDOW_UNAVAILABLE', 'Chrome did not create a distinct Career Ops research window');
    } catch (error) {
      if (launched) {
        try {
          const newIds = (await this.listWindowIds()).filter(id => !before.has(id));
          if (newIds.length === 1 && await this.isExpectedResearchWindow(newIds[0], markerUrl)) {
            const [windowId] = newIds; this.ownedWindows.add(windowId); this.ownedTabs.set(windowId, new Set());
            await this.closeWindow(windowId);
          }
        } catch {}
      }
      throw error;
    }
  }
  async openTab(windowId, url) {
    this.assertOwnedWindow(windowId);
    const parsed = new URL(url); if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) throw new TypeError('managed browser tab URL must be HTTP(S) or about:');
    const tabId = Number.parseInt(await this.script(OPEN_TAB, [windowId, parsed.toString()]), 10);
    if (!Number.isInteger(tabId)) throw new BrowserSessionError('BROWSER_TAB_UNAVAILABLE', 'Chrome did not return an owned tab ID');
    this.ownedTabs.get(Number(windowId)).add(tabId); return tabId;
  }
  async adoptWindow({ windowId, tabId, markerUrl } = {}) {
    const ownedWindowId = Number(windowId), ownedTabId = Number(tabId);
    if (!Number.isInteger(ownedWindowId) || !Number.isInteger(ownedTabId) || !String(markerUrl || '').startsWith('file:///dev/null#career-ops-')) throw new BrowserSessionError('BROWSER_SESSION_CONTEXT_INVALID', 'paused browser context is incomplete');
    const url = await this.script(ADOPT_WINDOW, [ownedWindowId, ownedTabId, markerUrl]);
    this.ownedWindows.add(ownedWindowId); this.ownedTabs.set(ownedWindowId, new Set([ownedTabId]));
    return { windowId: ownedWindowId, tabId: ownedTabId, markerUrl, url };
  }
  async activateWindow(windowId) { this.assertOwnedWindow(windowId); await this.script(ACTIVATE_WINDOW, [windowId]); }
  async executeJavaScript(windowId, tabId, source) {
    this.assertOwnedTab(windowId, tabId);
    try { return await this.script(EXECUTE_JAVASCRIPT, [windowId, tabId, source]); }
    catch (error) { throw new BrowserSessionError('BROWSER_JAVASCRIPT_UNAVAILABLE', 'Chrome JavaScript from Apple Events is unavailable', { message: error.message }); }
  }
  async uploadFile(windowId,tabId,selector,filePath){this.assertOwnedTab(windowId,tabId);const absolute=path.resolve(String(filePath||''));if(!existsSync(absolute))throw new BrowserSessionError('BROWSER_UPLOAD_FILE_MISSING','approved upload file is unavailable');await this.script(ACTIVATE_WINDOW,[windowId]);const click=`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.type!=='file')return 'false';e.click();return 'true'})()`;if(await this.executeJavaScript(windowId,tabId,click)!=='true')throw new BrowserSessionError('BROWSER_UPLOAD_CONTROL_UNAVAILABLE','approved file input is unavailable');await this.sleep(300);await this.script(CHOOSE_FILE,[absolute]);await this.sleep(700);return{path:absolute};}
  async readTabMetadata(windowId, tabId) {
    this.assertOwnedTab(windowId, tabId);
    const value = await this.script(READ_TAB_METADATA, [windowId, tabId]);
    const [title = '', url = '', loading = 'false'] = value.split(String.fromCharCode(31), 3);
    return { title, url, loading: loading.trim().toLowerCase() === 'true' };
  }
  async closeTab(windowId, tabId) {
    this.assertOwnedTab(windowId, tabId);
    try { await this.script(CLOSE_TAB, [windowId, tabId]); }
    finally { this.ownedTabs.get(Number(windowId))?.delete(Number(tabId)); }
  }
  async closeWindow(windowId) {
    this.assertOwnedWindow(windowId);
    try { await this.script(CLOSE_WINDOW, [windowId]); }
    finally { this.ownedWindows.delete(Number(windowId)); this.ownedTabs.delete(Number(windowId)); }
  }
}
