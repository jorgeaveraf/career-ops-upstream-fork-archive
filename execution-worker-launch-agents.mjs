#!/usr/bin/env node
import 'dotenv/config';
import path from 'path';
import os from 'os';
import {pathToFileURL} from 'url';
import {renderApplicationExecutorLaunchAgent,renderOutreachExecutorLaunchAgent,installLaunchAgent,launchAgentControl,APPLICATION_EXECUTOR_LAUNCH_AGENT_LABEL,OUTREACH_EXECUTOR_LAUNCH_AGENT_LABEL} from './operations/launch-agent.mjs';

async function main(){const command=process.argv[2]||'install',root=process.cwd(),logsRoot=path.join(root,'logs');for(const worker of [{label:APPLICATION_EXECUTOR_LAUNCH_AGENT_LABEL,render:renderApplicationExecutorLaunchAgent},{label:OUTREACH_EXECUTOR_LAUNCH_AGENT_LABEL,render:renderOutreachExecutorLaunchAgent}]){const destination=path.join(os.homedir(),'Library','LaunchAgents',`${worker.label}.plist`),installed=installLaunchAgent({plist:worker.render({projectRoot:root,logsRoot}),destination,logsRoot});if(command==='install'){try{launchAgentControl('unload',{plistPath:destination,label:worker.label});}catch{}launchAgentControl('load',{plistPath:destination,label:worker.label});}else if(['load','unload','status'].includes(command))launchAgentControl(command,{plistPath:destination,label:worker.label});else throw new Error(`unknown command: ${command}`);console.log(JSON.stringify({label:worker.label,path:installed.path,changed:installed.changed,command}));}}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
