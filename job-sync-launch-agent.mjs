#!/usr/bin/env node
import 'dotenv/config';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { installLaunchAgent, JOB_SYNC_LAUNCH_AGENT_LABEL, launchAgentControl, renderJobSyncLaunchAgent, resolveNpmPath } from './operations/launch-agent.mjs';

async function main(){const args=process.argv.slice(2),command=args[0];if(!command||args.includes('--help')){console.log('Usage: npm run job-sync:launch-agent -- generate|install|load|unload|status [--path plist] [--legacy-enable]\nLegacy 60-second polling is disabled in V4.5; operator commands and event-driven projection are authoritative.');return;}const root=path.resolve(process.cwd()),plistPath=flagValue(args,'--path')||path.join(os.homedir(),'Library','LaunchAgents',`${JOB_SYNC_LAUNCH_AGENT_LABEL}.plist`);if(['load','install'].includes(command)&&!args.includes('--legacy-enable'))throw Object.assign(new Error('legacy job-sync polling is disabled; use the Career Ops command gateway'),{code:'LEGACY_POLLING_DISABLED'});if(['load','unload','status'].includes(command)){console.log(launchAgentControl(command,{plistPath,label:JOB_SYNC_LAUNCH_AGENT_LABEL}));return;}const plist=renderJobSyncLaunchAgent({projectRoot:root,npmPath:flagValue(args,'--npm')||resolveNpmPath(),intervalSeconds:Number(flagValue(args,'--interval')||60)});if(command==='generate'){const out=flagValue(args,'--out');if(out){writeFileSync(path.resolve(out),plist,{encoding:'utf8',mode:0o600});console.log(path.resolve(out));}else console.log(plist);return;}if(command!=='install')throw new Error(`unknown command: ${command}`);console.log(JSON.stringify(installLaunchAgent({plist,destination:plistPath,logsRoot:path.join(root,'logs')}),null,2));}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(`Job Sync LaunchAgent failed: ${error.message}`);process.exitCode=1;});
