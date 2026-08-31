#!/usr/bin/env node
import 'dotenv/config';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { installLaunchAgent, launchAgentControl, LAUNCH_AGENT_LABEL, renderLaunchAgent, resolveNpmPath } from './operations/launch-agent.mjs';

function usage() {
  console.log(`Usage:
  npm run launch-agent -- generate [--out path] [--hour 16] [--minute 0] [--npm path]
  npm run launch-agent -- install [--hour 16] [--minute 0] [--npm path]
  npm run launch-agent -- load|unload|status [--path plist]

Install writes the plist idempotently but does not load it. Load/unload are explicit.`);
}

async function main() {
  const args = process.argv.slice(2); const command = args[0];
  if (!command || ['--help', '-h'].includes(command)) { usage(); return; }
  const projectRoot = path.resolve(process.cwd());
  const plistPath = flagValue(args, '--path') || path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  if (['load', 'unload', 'status'].includes(command)) { console.log(launchAgentControl(command, { plistPath })); return; }
  if (!['generate', 'install'].includes(command)) throw new Error(`unknown command: ${command}`);
  const plist = renderLaunchAgent({
    projectRoot, npmPath: flagValue(args, '--npm') || resolveNpmPath(),
    hour: Number(flagValue(args, '--hour') || process.env.CAREER_OPS_SCHEDULE_HOUR || 16),
    minute: Number(flagValue(args, '--minute') || process.env.CAREER_OPS_SCHEDULE_MINUTE || 0),
  });
  if (command === 'generate') {
    const output = flagValue(args, '--out');
    if (output) { writeFileSync(path.resolve(output), plist, { encoding: 'utf8', mode: 0o600 }); console.log(path.resolve(output)); }
    else console.log(plist);
    return;
  }
  console.log(JSON.stringify(installLaunchAgent({ plist, destination: plistPath, logsRoot: path.join(projectRoot, 'logs') }), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(`LaunchAgent failed: ${error.message}`); process.exitCode = 1; });
