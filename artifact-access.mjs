#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { openJobRegistry } from './registry/job-registry.mjs';
import { startArtifactAccessServer } from './artifact-access/service.mjs';

async function main(){if(process.argv.includes('--help')){console.log('Usage: npm run artifact:serve\nServes only the current READY_FOR_REVIEW resume and cover letter on 127.0.0.1.');return;}const registry=openJobRegistry(),port=Number(process.env.CAREER_OPS_ARTIFACT_ACCESS_PORT||4319);const server=await startArtifactAccessServer({registry,port});const stop=()=>server.close(()=>{registry.close();process.exit(0);});process.on('SIGTERM',stop);process.on('SIGINT',stop);console.log(JSON.stringify({status:'READY',host:'127.0.0.1',port}));}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(`Artifact access failed: ${error.message}`);process.exitCode=1;});
