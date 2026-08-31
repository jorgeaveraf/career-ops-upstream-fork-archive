#!/usr/bin/env node
import 'dotenv/config';
import { writeFileSync } from 'fs';
import os from 'os';import path from 'path';
import { flagValue } from './lib/cli-flags.mjs';
import { ARTIFACT_ACCESS_LAUNCH_AGENT_LABEL,installLaunchAgent,launchAgentControl,renderArtifactAccessLaunchAgent,resolveNpmPath } from './operations/launch-agent.mjs';
async function main(){const args=process.argv.slice(2),command=args[0];if(!command||args.includes('--help')){console.log('Usage: npm run artifact:launch-agent -- generate|install|load|unload|status');return;}const root=path.resolve(process.cwd()),plistPath=flagValue(args,'--path')||path.join(os.homedir(),'Library','LaunchAgents',`${ARTIFACT_ACCESS_LAUNCH_AGENT_LABEL}.plist`);if(['load','unload','status'].includes(command)){console.log(launchAgentControl(command,{plistPath,label:ARTIFACT_ACCESS_LAUNCH_AGENT_LABEL}));return;}const plist=renderArtifactAccessLaunchAgent({projectRoot:root,npmPath:flagValue(args,'--npm')||resolveNpmPath()});if(command==='generate'){const out=flagValue(args,'--out');if(out){writeFileSync(path.resolve(out),plist,{encoding:'utf8',mode:0o600});console.log(path.resolve(out));}else console.log(plist);return;}if(command!=='install')throw new Error(`unknown command: ${command}`);console.log(JSON.stringify(installLaunchAgent({plist,destination:plistPath,logsRoot:path.join(root,'logs')}),null,2));}
main().catch(error=>{console.error(`Artifact Access LaunchAgent failed: ${error.message}`);process.exitCode=1;});
