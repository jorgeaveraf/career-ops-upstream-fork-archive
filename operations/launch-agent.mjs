import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

export const LAUNCH_AGENT_LABEL = 'com.careerops.daily';
export const BROWSER_RESEARCH_LAUNCH_AGENT_LABEL = 'com.careerops.browser-research';
export const APPLICATION_ENRICHMENT_LAUNCH_AGENT_LABEL = 'com.careerops.application-enrichment';
export const APPLICATION_EXECUTOR_LAUNCH_AGENT_LABEL = 'com.careerops.application-executor';
export const OUTREACH_EXECUTOR_LAUNCH_AGENT_LABEL = 'com.careerops.outreach-executor';
export const JOB_SYNC_LAUNCH_AGENT_LABEL = 'com.careerops.job-sync';
export const COMMAND_SUBSCRIBER_LAUNCH_AGENT_LABEL = 'com.careerops.command-subscriber';
export const OPERATIONAL_WATCH_LAUNCH_AGENT_LABEL = 'com.careerops.operational-watch';
export const ARTIFACT_ACCESS_LAUNCH_AGENT_LABEL = 'com.careerops.artifact-access';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function resolveNpmPath({ nodePath = process.execPath } = {}) {
  for (const candidate of ['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm']) if (existsSync(candidate)) return candidate;
  const besideNode = path.join(path.dirname(nodePath), 'npm');
  if (existsSync(besideNode)) return besideNode;
  throw new Error('npm executable not found; pass --npm with an absolute path');
}

export function renderLaunchAgent({
  projectRoot, npmPath = resolveNpmPath(), hour = 16, minute = 0,
  label = LAUNCH_AGENT_LABEL, logsRoot = path.join(projectRoot, 'logs'),
  script = 'daily:auto', scriptArgs = ['--scheduled', '--json'], logCategory = 'daily', errorLogCategory = 'errors', runAtLoad = true, programArguments = null,
} = {}) {
  if (!path.isAbsolute(projectRoot || '')) throw new TypeError('projectRoot must be absolute');
  if (!path.isAbsolute(npmPath || '')) throw new TypeError('npmPath must be absolute');
  if (!Number.isInteger(Number(hour)) || Number(hour) < 0 || Number(hour) > 23) throw new TypeError('hour must be 0-23');
  if (!Number.isInteger(Number(minute)) || Number(minute) < 0 || Number(minute) > 59) throw new TypeError('minute must be 0-59');
  const pathValue = `${path.dirname(npmPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,args=programArguments||[npmPath,'run',script,'--',...scriptArgs];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    ${args.map(item => `<string>${xml(item)}</string>`).join('')}
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(os.homedir())}</string><key>PATH</key><string>${xml(pathValue)}</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Number(hour)}</integer><key>Minute</key><integer>${Number(minute)}</integer></dict>
  <key>RunAtLoad</key>${runAtLoad?'<true/>':'<false/>'}
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logsRoot, logCategory, 'launchd.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsRoot, errorLogCategory, 'launchd.stderr.log'))}</string>
</dict>
</plist>
`;
}

export function renderBrowserResearchLaunchAgent(options = {}) {
  return renderLaunchAgent({
    ...options,
    hour: options.hour ?? 15,
    minute: options.minute ?? 30,
    label: options.label || BROWSER_RESEARCH_LAUNCH_AGENT_LABEL,
    script: 'browser:research',
    logCategory: 'browser/discovery',
    errorLogCategory: 'browser/discovery',
  });
}

export function renderApplicationEnrichmentLaunchAgent(options = {}) {
  const npmPath=options.npmPath||resolveNpmPath(),nodePath=options.nodePath||path.join(path.dirname(npmPath),'node');
  return renderLaunchAgent({
    ...options,
    npmPath,
    hour: options.hour ?? 17,
    minute: options.minute ?? 0,
    label: options.label || APPLICATION_ENRICHMENT_LAUNCH_AGENT_LABEL,
    script: 'application:enrich',
    scriptArgs: ['drain'],
    runAtLoad: false,
    programArguments:[nodePath,path.join(options.projectRoot,'application-enrich.mjs'),'drain'],
    logCategory: 'application-enrichment',
    errorLogCategory: 'application-enrichment',
  });
}

export function renderExecutionWorkerLaunchAgent({projectRoot,npmPath=resolveNpmPath(),label,entrypoint,logsRoot=path.join(projectRoot,'logs'),intervalSeconds=60}={}){
  if(!path.isAbsolute(projectRoot||''))throw new TypeError('projectRoot must be absolute');const nodePath=path.join(path.dirname(npmPath),'node'),pathValue=`${path.dirname(npmPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(path.join(projectRoot,entrypoint))}</string><string>drain</string></array><key>WorkingDirectory</key><string>${xml(projectRoot)}</string><key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(os.homedir())}</string><key>PATH</key><string>${xml(pathValue)}</string></dict><key>StartInterval</key><integer>${Math.max(30,Number(intervalSeconds)||60)}</integer><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${xml(path.join(logsRoot,label,'launchd.stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(logsRoot,label,'launchd.stderr.log'))}</string></dict></plist>\n`;
}
export const renderApplicationExecutorLaunchAgent=options=>renderExecutionWorkerLaunchAgent({...options,label:options.label||APPLICATION_EXECUTOR_LAUNCH_AGENT_LABEL,entrypoint:'application-execution.mjs'});
export const renderOutreachExecutorLaunchAgent=options=>renderExecutionWorkerLaunchAgent({...options,label:options.label||OUTREACH_EXECUTOR_LAUNCH_AGENT_LABEL,entrypoint:'application-activation.mjs'});

export function renderJobSyncLaunchAgent({projectRoot,npmPath=resolveNpmPath(),label=JOB_SYNC_LAUNCH_AGENT_LABEL,logsRoot=path.join(projectRoot,'logs'),intervalSeconds=60}={}){
  if(!path.isAbsolute(projectRoot||''))throw new TypeError('projectRoot must be absolute');
  if(!path.isAbsolute(npmPath||''))throw new TypeError('npmPath must be absolute');
  const pathValue=`${path.dirname(npmPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(npmPath)}</string><string>run</string><string>sync:jobs</string><string>--</string><string>--require-request</string></array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathValue)}</string></dict>
  <key>StartInterval</key><integer>${Math.max(30,Number(intervalSeconds)||60)}</integer>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>60</integer><key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logsRoot,'job-sync','launchd.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsRoot,'job-sync','launchd.stderr.log'))}</string>
</dict></plist>\n`;
}

export function renderCommandSubscriberLaunchAgent({projectRoot,npmPath=resolveNpmPath(),label=COMMAND_SUBSCRIBER_LAUNCH_AGENT_LABEL,logsRoot=path.join(projectRoot,'logs')}={}){
  if(!path.isAbsolute(projectRoot||''))throw new TypeError('projectRoot must be absolute');
  if(!path.isAbsolute(npmPath||''))throw new TypeError('npmPath must be absolute');
  const pathValue=`${path.dirname(npmPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(npmPath)}</string><string>run</string><string>command:subscriber</string></array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathValue)}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logsRoot,'command-subscriber','launchd.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsRoot,'command-subscriber','launchd.stderr.log'))}</string>
</dict></plist>\n`;
}

export function renderOperationalWatchLaunchAgent({projectRoot,npmPath=resolveNpmPath(),label=OPERATIONAL_WATCH_LAUNCH_AGENT_LABEL,logsRoot=path.join(projectRoot,'logs'),intervalSeconds=300}={}){
  if(!path.isAbsolute(projectRoot||''))throw new TypeError('projectRoot must be absolute');
  if(!path.isAbsolute(npmPath||''))throw new TypeError('npmPath must be absolute');
  const pathValue=`${path.dirname(npmPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(label)}</string>\n  <key>ProgramArguments</key><array><string>${xml(npmPath)}</string><string>run</string><string>operational:watch</string></array>\n  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>\n  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathValue)}</string></dict>\n  <key>StartInterval</key><integer>${Math.max(60,Number(intervalSeconds)||300)}</integer>\n  <key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>60</integer><key>Umask</key><integer>63</integer>\n  <key>StandardOutPath</key><string>${xml(path.join(logsRoot,'operational-watch','launchd.stdout.log'))}</string>\n  <key>StandardErrorPath</key><string>${xml(path.join(logsRoot,'operational-watch','launchd.stderr.log'))}</string>\n</dict></plist>\n`;
}

export function renderArtifactAccessLaunchAgent({projectRoot,npmPath=resolveNpmPath(),label=ARTIFACT_ACCESS_LAUNCH_AGENT_LABEL,logsRoot=path.join(projectRoot,'logs')}={}){
  if(!path.isAbsolute(projectRoot||''))throw new TypeError('projectRoot must be absolute');if(!path.isAbsolute(npmPath||''))throw new TypeError('npmPath must be absolute');const pathValue=`${path.dirname(npmPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(label)}</string>\n  <key>ProgramArguments</key><array><string>${xml(npmPath)}</string><string>run</string><string>artifact:serve</string></array>\n  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>\n  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathValue)}</string></dict>\n  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>\n  <key>StandardOutPath</key><string>${xml(path.join(logsRoot,'artifact-access','launchd.stdout.log'))}</string>\n  <key>StandardErrorPath</key><string>${xml(path.join(logsRoot,'artifact-access','launchd.stderr.log'))}</string>\n</dict></plist>\n`;
}

export function installLaunchAgent({
  plist, destination = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
  logsRoot,
} = {}) {
  if (!plist) throw new TypeError('plist is required');
  const target = path.resolve(destination); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (logsRoot) for (const category of ['daily', 'browser', 'browser/discovery', 'application-enrichment', 'com.careerops.application-executor', 'com.careerops.outreach-executor', 'job-sync', 'command-subscriber', 'operational-watch', 'artifact-access', 'errors', 'health']) mkdirSync(path.join(logsRoot, category), { recursive: true, mode: 0o700 });
  if (existsSync(target) && readFileSync(target, 'utf8') === plist) return { path: target, changed: false, existing: true };
  const temporary = `${target}.tmp-${process.pid}`;
  try { writeFileSync(temporary, plist, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); renameSync(temporary, target); chmodSync(target, 0o600); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
  return { path: target, changed: true, existing: false };
}

export function launchAgentControl(command, { plistPath, label = LAUNCH_AGENT_LABEL, uid = process.getuid?.(), exec = execFileSync } = {}) {
  if (!Number.isInteger(uid)) throw new Error('launchctl user domain requires a numeric UID');
  const domain = `gui/${uid}`;
  if (command === 'load') return exec('/bin/launchctl', ['bootstrap', domain, path.resolve(plistPath)], { encoding: 'utf8' });
  if (command === 'unload') return exec('/bin/launchctl', ['bootout', domain, path.resolve(plistPath)], { encoding: 'utf8' });
  if (command === 'status') return exec('/bin/launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
  throw new Error(`unknown launch agent command: ${command}`);
}
