#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { openJobRegistry, DEFAULT_REGISTRY_PATH } from './registry/job-registry.mjs';
import { reconcileApplicationActivation } from './application-activation/reconcile.mjs';
import { OutreachExecutionService } from './application-activation/service.mjs';
import { createProductionOutreachExecutors } from './outreach-execution/production-executors.mjs';
import { WorkerOrchestrator } from './execution-orchestration/worker-registry.mjs';
import { drainActionableNotifications } from './notifications/runtime.mjs';

async function main(){const args=process.argv.slice(2),command=args[0];if(!command||args.includes('--help')){console.log('Usage: node application-activation.mjs reconcile [--job id] [--db path]\n       node application-activation.mjs drain [--max-items 5] [--db path]');return;}const registry=openJobRegistry({dbPath:flagValue(args,'--db')||process.env.CAREER_OPS_DB||DEFAULT_REGISTRY_PATH});try{if(command==='reconcile'){const jobId=flagValue(args,'--job');console.log(JSON.stringify(await reconcileApplicationActivation({registry,jobIds:jobId?[jobId]:null}),null,2));return;}if(command==='drain'){const service=new OutreachExecutionService({registry,executors:createProductionOutreachExecutors()}),orchestrator=new WorkerOrchestrator({registry});service.schedulePending();orchestrator.materialize();const items=orchestrator.queue('OUTREACH').slice(0,Math.max(1,Number(flagValue(args,'--max-items')||5))),results=[];for(const item of items){orchestrator.claim(item.workKey);const result=await service.execute({authorizationId:item.aggregateId});orchestrator.complete(item.workKey,result);results.push(result);}const responses=await service.checkResponses(),notifications=await drainActionableNotifications({registry});console.log(JSON.stringify({status:items.length?'SUCCESS':'NO_WORK',claimed:items.length,results,responses,notifications},null,2));return;}throw new Error(`unknown command: ${command}`);}finally{registry.close();}}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(`Application activation failed: ${error.message}`);process.exitCode=1;});
