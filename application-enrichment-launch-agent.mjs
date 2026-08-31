#!/usr/bin/env node
import 'dotenv/config';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { APPLICATION_ENRICHMENT_LAUNCH_AGENT_LABEL, installLaunchAgent, launchAgentControl, renderApplicationEnrichmentLaunchAgent, resolveNpmPath } from './operations/launch-agent.mjs';

function usage() { console.log(`Usage:
  npm run application:launch-agent -- generate [--out path] [--hour 17] [--minute 0] [--npm path]
  npm run application:launch-agent -- install [--hour 17] [--minute 0] [--npm path]
  npm run application:launch-agent -- load|unload|status [--path plist]

This schedules bounded V2B enrichment only. Application submission is never scheduled.`); }

async function main() {
  const args = process.argv.slice(2); const command = args[0];
  if (!command || ['--help','-h'].includes(command)) return usage();
  const projectRoot = path.resolve(process.cwd());
  const plistPath = flagValue(args,'--path') || path.join(os.homedir(),'Library','LaunchAgents',`${APPLICATION_ENRICHMENT_LAUNCH_AGENT_LABEL}.plist`);
  if (['load','unload','status'].includes(command)) { console.log(launchAgentControl(command,{plistPath,label:APPLICATION_ENRICHMENT_LAUNCH_AGENT_LABEL})); return; }
  if (!['generate','install'].includes(command)) throw new Error(`unknown command: ${command}`);
  const plist = renderApplicationEnrichmentLaunchAgent({ projectRoot, npmPath: flagValue(args,'--npm') || resolveNpmPath(), hour: Number(flagValue(args,'--hour') || 17), minute: Number(flagValue(args,'--minute') || 0) });
  if (command === 'generate') { const output=flagValue(args,'--out'); if(output){writeFileSync(path.resolve(output),plist,{encoding:'utf8',mode:0o600});console.log(path.resolve(output));}else console.log(plist); return; }
  console.log(JSON.stringify(installLaunchAgent({plist,destination:plistPath,logsRoot:path.join(projectRoot,'logs')}),null,2));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(`Application Enrichment LaunchAgent failed: ${error.message}`);process.exitCode=1;});
