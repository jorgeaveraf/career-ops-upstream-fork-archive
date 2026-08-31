#!/usr/bin/env node
import 'dotenv/config';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { flagValue } from './lib/cli-flags.mjs';
import { OPERATIONAL_WATCH_LAUNCH_AGENT_LABEL, installLaunchAgent, launchAgentControl, renderOperationalWatchLaunchAgent, resolveNpmPath } from './operations/launch-agent.mjs';
async function main(){const args=process.argv.slice(2),command=args[0];if(!command||args.includes('--help')){console.log('Usage: npm run operational:launch-agent -- generate|install|load|unload|status');return;}const root=path.resolve(process.cwd()),plistPath=flagValue(args,'--path')||path.join(os.homedir(),'Library','LaunchAgents',`${OPERATIONAL_WATCH_LAUNCH_AGENT_LABEL}.plist`);if(['load','unload','status'].includes(command)){console.log(launchAgentControl(command,{plistPath,label:OPERATIONAL_WATCH_LAUNCH_AGENT_LABEL}));return;}const plist=renderOperationalWatchLaunchAgent({projectRoot:root,npmPath:flagValue(args,'--npm')||resolveNpmPath(),intervalSeconds:Number(flagValue(args,'--interval')||300)});if(command==='generate'){const out=flagValue(args,'--out');if(out){writeFileSync(path.resolve(out),plist,{encoding:'utf8',mode:0o600});console.log(path.resolve(out));}else console.log(plist);return;}if(command!=='install')throw new Error(`unknown command: ${command}`);console.log(JSON.stringify(installLaunchAgent({plist,destination:plistPath,logsRoot:path.join(root,'logs')}),null,2));}
main().catch(error=>{console.error(`Operational Watch LaunchAgent failed: ${error.message}`);process.exitCode=1;});
