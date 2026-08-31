#!/usr/bin/env node
import 'dotenv/config';import{pathToFileURL}from'url';import{openJobRegistry,DEFAULT_REGISTRY_PATH}from'./registry/job-registry.mjs';import{FeedbackCalibrationEngine}from'./feedback-calibration/engine.mjs';
async function main(){const registry=openJobRegistry({dbPath:process.env.CAREER_OPS_DB||DEFAULT_REGISTRY_PATH});try{console.log(JSON.stringify(new FeedbackCalibrationEngine({registry}).rebuild(),null,2));}finally{registry.close();}}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{console.error(`Feedback calibration failed: ${e.message}`);process.exitCode=1;});
