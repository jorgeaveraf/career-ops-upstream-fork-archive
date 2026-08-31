#!/usr/bin/env node
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { openCandidateKnowledge } from './candidate-knowledge/provider.mjs';
import { OpenAIResponsesProvider } from './deep-evaluation/llm-provider.mjs';
import { ApplicationEnrichmentWorker } from './application-enrichment/worker.mjs';
import { BoundedApplicationResearchProvider } from './application-enrichment/research-provider.mjs';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';
import { BrowserSessionManager, browserSelectionFromEnv } from './research/browser-session-manager.mjs';
import { ManagedBrowserSession, managedBrowserSessionConfigFromEnv } from './research/managed-browser-session.mjs';
import { MacOsChromeWindowDriver } from './research/macos-chrome-window-driver.mjs';
import { ManagedChromeResearchAdapter } from './research/playwright-read-only-adapter.mjs';
import { drainActionableNotifications } from './notifications/runtime.mjs';
import { DailyCompletionSummaryService } from './notifications/daily-completion.mjs';
import { drainApplicationEnrichment } from './application-enrichment/drain.mjs';
import { pushCommandStatus } from './operations/command-worker.mjs';

function usage() { console.log(`Usage:
  npm run application:enrich -- pending [--job id]
  npm run application:enrich -- dry-run [--job id]
  npm run application:enrich -- next [--job id] [--llm] [--no-browser]
  npm run application:enrich -- drain [--max-items 10] [--max-runtime-minutes 30] [--llm] [--no-browser]
  npm run application:enrich -- show --request id
  npm run application:enrich -- retry --request id

Only PENDING NEXT_STAGE requests are processed. Browser access is research_only.
This worker never applies, submits, messages, uploads, follows, connects, or publishes.`); }

async function main() {
  const args = process.argv.slice(2); const command = args[0];
  if (!command || ['-h','--help'].includes(command)) { usage(); return; }
  const dbPath = flagValue(args, '--db') || process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH;
  const jobId = flagValue(args, '--job'); const requestId = flagValue(args, '--request');
  const registry = openJobRegistry({ dbPath }); let session = null; let browserAdapter = null; let managedSession = null;
  try {
    if (command === 'pending') { const requests = registry.listEnrichmentRequests({ status: 'PENDING', jobId }); console.log(JSON.stringify({ count: requests.length, requests }, null, 2)); return; }
    if (command === 'show') { if (!requestId) throw new Error('show requires --request'); console.log(JSON.stringify({ request: registry.getEnrichmentRequest(requestId), events: registry.getEnrichmentRequestEvents(requestId), evidence: registry.getApplicationEnrichmentEvidence(requestId) }, null, 2)); return; }
    if (command === 'retry') { if (!requestId) throw new Error('retry requires --request'); const current = registry.getEnrichmentRequest(requestId); if (!current) throw new Error('unknown request'); const request = registry.transitionEnrichmentRequest(requestId, 'PENDING', { reason: 'manual_retry', runId: `manual-retry-${randomUUID()}` }); console.log(JSON.stringify({ request }, null, 2)); return; }
    if (!['dry-run','next','drain'].includes(command)) throw new Error(`unknown command: ${command}`);
    const candidateProvider = openCandidateKnowledge({ projectRoot: process.cwd() }); const canonicalCv = readFileSync(flagValue(args, '--cv') || 'cv.md', 'utf8');
    if (command === 'dry-run') { const worker = new ApplicationEnrichmentWorker({ registry, candidateProvider, canonicalCv }); console.log(JSON.stringify(worker.preview({ jobId, requestId }), null, 2)); return; }
    if (!registry.listEnrichmentRequests({ status: 'PENDING', jobId }).length) { const dailySummary=new DailyCompletionSummaryService({registry}).enqueueForLatestCompletedRun();const notifications=await drainActionableNotifications({registry});console.log(JSON.stringify({ status: 'NO_WORK', processed: 0,dailySummary,notifications }, null, 2)); return; }
    if (!hasFlag(args, '--no-browser')) {
      const lockManager = new BrowserSessionManager({ lockPath: process.env.BROWSER_SESSION_LOCK || process.env.BROWSER_RESEARCH_LOCK || path.join('data','browser','.careerops-session.lock') });
      managedSession = new ManagedBrowserSession({ lockManager, windowDriver: new MacOsChromeWindowDriver(), ...managedBrowserSessionConfigFromEnv() });
      session = await managedSession.acquire(browserSelectionFromEnv());
      browserAdapter = new ManagedChromeResearchAdapter(); await browserAdapter.start(session);
    }
    const useLLM = hasFlag(args, '--llm'); const llmProvider = useLLM ? new OpenAIResponsesProvider({ model: process.env.CAREER_OPS_DEEP_MODEL || process.env.CAREER_OPS_MODEL }) : null;
    const worker = new ApplicationEnrichmentWorker({ registry, candidateProvider, canonicalCv, llmProvider, researchProvider: new BoundedApplicationResearchProvider({ browserAdapter }) });
    let lastProjection=0;const project=async({force=false}={})=>{const now=Date.now();if(!process.env.CAREER_OPS_SHEET_ID||(!force&&now-lastProjection<15_000))return;try{await pushCommandStatus({registry,spreadsheetId:process.env.CAREER_OPS_SHEET_ID,preserveHumanEdits:true});lastProjection=now;}catch(error){console.error(JSON.stringify({event:'enrichment_projection_failed',errorCode:error.code||'SHEET_PROJECTION_FAILED'}));}};
    const result=command==='drain'
      ?await drainApplicationEnrichment({worker,jobId,requestId,useLLM,maxItems:Number(flagValue(args,'--max-items')||process.env.CAREER_OPS_ENRICHMENT_MAX_ITEMS||10),maxRuntimeMs:Number(flagValue(args,'--max-runtime-minutes')||process.env.CAREER_OPS_ENRICHMENT_MAX_RUNTIME_MINUTES||30)*60_000,onClaimed:()=>project(),onTerminal:()=>project({force:true})})
      :await worker.processNext({ runId: `application-enrichment-${randomUUID()}`, jobId, requestId, useLLM,onClaimed:()=>project(),onTerminal:()=>project({force:true}) });
    if(command==='next')await project({force:true});
    const active=registry.listEnrichmentRequests().filter(x=>['PENDING','RESEARCHING','EVALUATING','GENERATING_PACKAGE'].includes(x.status)).length;
    const dailySummary=active?{status:'DEFERRED_ENRICHMENT_ACTIVE',active}:new DailyCompletionSummaryService({registry}).enqueueForLatestCompletedRun();const notifications=await drainActionableNotifications({registry});console.log(JSON.stringify({...result,dailySummary,notifications}, null, 2));
  } finally { try { await browserAdapter?.close(); } catch {} if (session && managedSession) await managedSession.release(session); registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(`Application enrichment failed: ${error.message}`); process.exitCode = 1; });
