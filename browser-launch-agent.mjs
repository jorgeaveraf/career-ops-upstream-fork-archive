#!/usr/bin/env node
import 'dotenv/config';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import {
  BROWSER_RESEARCH_LAUNCH_AGENT_LABEL,
  installLaunchAgent,
  launchAgentControl,
  renderBrowserResearchLaunchAgent,
  resolveNpmPath,
} from './operations/launch-agent.mjs';

function usage() {
  console.log(`Usage:
  npm run browser:launch-agent -- generate [--out path] [--hour 15] [--minute 30] [--npm path]
  npm run browser:launch-agent -- install [--hour 15] [--minute 30] [--npm path]
  npm run browser:launch-agent -- load|unload|status [--path plist]

Install only writes the plist; it never loads or starts scheduled Browser Discovery.`);
}

async function main() {
  const args = process.argv.slice(2); const command = args[0];
  if (!command || ['--help', '-h'].includes(command)) { usage(); return; }
  const projectRoot = path.resolve(process.cwd());
  const plistPath = flagValue(args, '--path') || path.join(os.homedir(), 'Library', 'LaunchAgents', `${BROWSER_RESEARCH_LAUNCH_AGENT_LABEL}.plist`);
  if (['load', 'unload', 'status'].includes(command)) {
    console.log(launchAgentControl(command, { plistPath, label: BROWSER_RESEARCH_LAUNCH_AGENT_LABEL })); return;
  }
  if (!['generate', 'install'].includes(command)) throw new Error(`unknown command: ${command}`);
  const plist = renderBrowserResearchLaunchAgent({
    projectRoot, npmPath: flagValue(args, '--npm') || resolveNpmPath(),
    hour: Number(flagValue(args, '--hour') || process.env.BROWSER_RESEARCH_SCHEDULE_HOUR || 15),
    minute: Number(flagValue(args, '--minute') || process.env.BROWSER_RESEARCH_SCHEDULE_MINUTE || 30),
  });
  if (command === 'generate') {
    const output = flagValue(args, '--out');
    if (output) { writeFileSync(path.resolve(output), plist, { encoding: 'utf8', mode: 0o600 }); console.log(path.resolve(output)); }
    else console.log(plist);
    return;
  }
  console.log(JSON.stringify(installLaunchAgent({ plist, destination: plistPath, logsRoot: path.join(projectRoot, 'logs') }), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(`Browser LaunchAgent failed: ${error.message}`); process.exitCode = 1; });
