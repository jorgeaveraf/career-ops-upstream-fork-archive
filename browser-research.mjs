#!/usr/bin/env node
import 'dotenv/config';
import path from 'path';
import { pathToFileURL } from 'url';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { openJobRegistry } from './registry/job-registry.mjs';
import { BrowserResearchProvider } from './research/browser-research-provider.mjs';
import { BrowserSessionManager, browserSelectionFromEnv } from './research/browser-session-manager.mjs';
import { loadBrowserResearchConfig } from './research/config.mjs';
import { ManagedChromeResearchAdapter } from './research/playwright-read-only-adapter.mjs';
import { ManagedBrowserSession, managedBrowserSessionConfigFromEnv } from './research/managed-browser-session.mjs';
import { MacOsChromeWindowDriver } from './research/macos-chrome-window-driver.mjs';
import { runBrowserResearch, shouldRunBrowserDiscoveryScheduled } from './research/runner.mjs';
import { buildResearchTasks } from './research/tasks.mjs';
import { buildBrowserDiscoveryTasks } from './research/discovery-tasks.mjs';
import { browserDiscoverySourceAdapters } from './research/discovery-source-adapters.mjs';
import { runBrowserDiscoveryWindow } from './automation/browser-discovery-window.mjs';
import { LocalOperationalLogger } from './operations/logging.mjs';
import { openCandidateKnowledge } from './candidate-knowledge/provider.mjs';
import { createDiscoveryStrategy } from './discovery-strategy/engine.mjs';
import { generateDiscoveryStrategyTasks } from './discovery-strategy/tasks.mjs';
import { runBrowserEnrichment } from './research/enrichment-runner.mjs';
import { filterV1ScheduledBrowserTasks } from './research/v1-capabilities.mjs';
import { runFacebookMonitoring } from './facebook.mjs';

export function buildBrowserResearchDryRun({ config, env = process.env, companies = [] } = {}) {
  const tasks = buildResearchTasks({ config, companies });
  const managedConfig = managedBrowserSessionConfigFromEnv(env);
  return {
    status: 'DRY_RUN', exitCode: 0, mode: String(env.BROWSER_MODE || 'UNCONFIGURED').toLowerCase(),
    profile: String(env.BROWSER_PROFILE || 'UNCONFIGURED').toLowerCase(), ...managedConfig,
    tasks: tasks.map(({ id, kind, source, query, market, company, url }) => ({ id, kind, source, query, market, company, url })),
    writes: [], navigationStarted: false,
  };
}

export function buildBrowserDiscoveryDryRun({ config, env = process.env, sourceAdapters = browserDiscoverySourceAdapters(), strategyTasks = null } = {}) {
  const tasks = buildBrowserDiscoveryTasks({ config, adapters: sourceAdapters, strategyTasks });
  const managedConfig = managedBrowserSessionConfigFromEnv(env);
  return {
    status: 'DRY_RUN', mode: String(env.BROWSER_MODE || 'UNCONFIGURED').toLowerCase(),
    profile: String(env.BROWSER_PROFILE || 'UNCONFIGURED').toLowerCase(), ...managedConfig, discover: true,
    tasks, facebookMonitoring:config.browser_discovery?.sources?.facebook?.enabled!==false, writes: [], navigationStarted: false, automaticDailyIntegration: false,
  };
}

function usage() {
  console.log(`Usage:
  npm run browser:research
  npm run browser:research -- --dry-run [--json] [--config path]
  npm run browser:research -- --json
  npm run browser:research -- --discover [--json]
  npm run browser:research -- --discover --dry-run [--json]
  npm run browser:research -- --discover --source linkedin --query "AI Systems Engineer" --max-results 5
  npm run browser:research -- --mode DISCOVERY --source linkedin --query "AI Systems Engineer" --max-results 5
  npm run browser:research -- --mode ENRICHMENT --max-tasks 5 --json
  npm run browser:research -- --report [--run-id id] --json
  npm run browser:research -- --scheduled --json
  npm run browser:research -- --session-check --json
  npm run browser:research -- --help

--scheduled runs the guarded Browser Discovery window; it does not run daily:auto.
When enrichment is enabled it continues sequentially with the bounded priority research queue.
All browser modes enforce research_only. Navigation/search/read/filter interactions are allowed;
applications, messages, connections, social actions, uploads, and form submissions are denied.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { usage(); return; }
  const allowed = new Set(['--dry-run', '--json', '--scheduled', '--session-check', '--config', '--discover', '--source', '--query', '--max-results', '--mode', '--enrich', '--max-tasks', '--report', '--run-id', '--no-sheet', '--feed-only']);
  const unknown = args.filter((arg, index) => arg.startsWith('--') && ![...allowed].some(flag => arg === flag || arg.startsWith(`${flag}=`)) && args[index - 1] !== '--config');
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
  if (hasFlag(args, '--config') && !flagValue(args, '--config')) throw new Error('--config requires a path');
  for (const flag of ['--source', '--query', '--max-results', '--mode', '--max-tasks', '--run-id']) if (hasFlag(args, flag) && !flagValue(args, flag)) throw new Error(`${flag} requires a value`);
  const explicitMode = String(flagValue(args, '--mode') || (args.includes('--enrich') ? 'ENRICHMENT' : '')).toUpperCase();
  if (explicitMode && !['DISCOVERY', 'ENRICHMENT'].includes(explicitMode)) throw new Error('--mode must be DISCOVERY or ENRICHMENT');
  const discoveryMode = explicitMode === 'DISCOVERY' || args.includes('--discover') || args.includes('--scheduled');
  const enrichmentMode = explicitMode === 'ENRICHMENT' || args.includes('--enrich');
  if (!discoveryMode && ['--source', '--query', '--max-results'].some(flag => hasFlag(args, flag))) throw new Error('discovery filters require --discover or --mode DISCOVERY');
  const maxTasks = Number(flagValue(args, '--max-tasks') || 5);
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 25) throw new Error('--max-tasks must be an integer from 1 to 25');
  if (args.includes('--report')) {
    const reportRegistry = openJobRegistry();
    try { console.log(JSON.stringify(reportRegistry.getBrowserObservabilityReport({ runId: flagValue(args, '--run-id') || null }), null, 2)); }
    finally { reportRegistry.close(); }
    return;
  }
  const configFile = flagValue(args, '--config') || process.env.BROWSER_RESEARCH_CONFIG || (args.includes('--dry-run') ? 'config/browser-research.example.json' : 'config/browser-research.json');
  const config = loadBrowserResearchConfig(configFile);
  if (discoveryMode) {
    config.browser_discovery = { ...(config.browser_discovery || config.discovery || {}) };
    if (flagValue(args, '--source')) {
      const source = flagValue(args, '--source').toLowerCase();
      config.browser_discovery.sources = { [source]: { ...(config.browser_discovery.sources?.[source] || {}), enabled: true } };
    }
    if (flagValue(args, '--query')) {
      const query = flagValue(args, '--query');
      config.browser_discovery.queries = [query];
      config.browser_discovery.sources = Object.fromEntries(Object.entries(config.browser_discovery.sources || {})
        .map(([source, sourceConfig]) => [source, { ...sourceConfig, queries: [query] }]));
    }
    if (flagValue(args, '--max-results')) {
      const maximum = Number(flagValue(args, '--max-results'));
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 50) throw new Error('--max-results must be an integer from 1 to 50');
      config.browser_discovery.maxResultsPerTask = maximum;
    }
  }
  let strategy = null; let strategyTasks = null;
  if (discoveryMode && config.browser_discovery?.useDiscoveryStrategy !== false && !hasFlag(args, '--query')) {
    strategy = createDiscoveryStrategy({ candidateProvider: openCandidateKnowledge({ projectRoot: process.cwd() }) });
    strategyTasks = generateDiscoveryStrategyTasks(strategy);
    const source = flagValue(args, '--source')?.toLowerCase();
    if (source) strategyTasks = strategyTasks.filter(task => task.source === source);
    if (args.includes('--feed-only')) strategyTasks = strategyTasks.filter(task => task.mode === 'personalized_feed');
    if (args.includes('--scheduled')) strategyTasks = filterV1ScheduledBrowserTasks(strategyTasks);
  }
  if (args.includes('--dry-run')) {
    const result = enrichmentMode
      ? { status: 'DRY_RUN', mode: 'ENRICHMENT', maxTasks, navigationStarted: false, writes: [], packagesGenerated: 0, sheetUpdated: false }
      : discoveryMode ? { ...buildBrowserDiscoveryDryRun({ config, strategyTasks }), mode: 'DISCOVERY',
        sequence: args.includes('--scheduled') ? ['DISCOVERY', 'ENRICHMENT'] : ['DISCOVERY'], enrichmentMaxTasks: maxTasks } : buildBrowserResearchDryRun({ config });
    if (strategy) result.strategy = { revision: strategy.revision, candidateKbRevision: strategy.candidateKbRevision };
    console.log(JSON.stringify(result, null, 2)); return;
  }

  const lockManager = new BrowserSessionManager({ lockPath: process.env.BROWSER_SESSION_LOCK || process.env.BROWSER_RESEARCH_LOCK || path.join('data', 'browser', '.careerops-session.lock') });
  const windowDriver = new MacOsChromeWindowDriver();
  const managedConfig = managedBrowserSessionConfigFromEnv();
  const managedSession = new ManagedBrowserSession({
    lockManager, windowDriver,
    ...managedConfig,
  });
  if (args.includes('--session-check')) {
    const selection = browserSelectionFromEnv(); let session = null;
    try {
      session = await managedSession.acquire(selection);
      console.log(JSON.stringify({ status: 'SUCCESS', sessionId: session.sessionId, windowCreated: true, windowId: session.windowId, profile: session.profile, mode: session.mode, ...managedConfig, navigationStarted: false, userWindowsManaged: false }, null, 2));
    } finally { if (session) await managedSession.release(session); }
    return;
  }

  const logger = new LocalOperationalLogger({ root: process.env.CAREER_OPS_LOG_DIR || 'logs' });
  const registry = openJobRegistry();
  try {
    if (enrichmentMode) {
      const result = await runBrowserEnrichment({ registry, sessionManager: managedSession,
        selectionResolver: () => browserSelectionFromEnv(), browserAdapter: new ManagedChromeResearchAdapter(), maxTasks, executionBudget: config.browser_execution || {},
        onTask: event => logger.write('browser', 'enrichment-task', event) });
      logger.write('browser', 'enrichment-finish', result);
      console.log(JSON.stringify(result, null, args.includes('--json') ? 2 : 0));
      process.exitCode = result.status === 'SUCCESS' ? 0 : result.status === 'PARTIAL' ? 2 : 1; return;
    }
    if (discoveryMode) {
      const sourceAdapters = browserDiscoverySourceAdapters();
      const tasks = buildBrowserDiscoveryTasks({ config, adapters: sourceAdapters, strategyTasks });
      const browserAdapter = new ManagedChromeResearchAdapter();
      const sessionManager = managedSession;
      const discoveryLogger = new LocalOperationalLogger({ root: path.join(process.env.CAREER_OPS_LOG_DIR || 'logs', 'browser'), categories: ['discovery'] });
      if (args.includes('--scheduled')) {
        const decision = shouldRunBrowserDiscoveryScheduled({
          registry, enabled: config.browser_discovery?.enabled !== false,
          timeZone: process.env.CAREER_OPS_TIMEZONE || 'America/Mexico_City',
          hour: Number(process.env.BROWSER_RESEARCH_SCHEDULE_HOUR || 16), minute: Number(process.env.BROWSER_RESEARCH_SCHEDULE_MINUTE || 0),
        });
        if (!decision.run) {
          const skipped = { status: 'SKIPPED', exitCode: 0, scheduled: true, discover: true, decision };
          discoveryLogger.write('discovery', 'scheduled-skip', skipped); console.log(JSON.stringify(skipped, null, 2)); return;
        }
      }
      if (!tasks.length) throw new Error('Browser Discovery is enabled but has no configured tasks');
      discoveryLogger.write('discovery', 'discovery-start', { profile: process.env.BROWSER_PROFILE || 'unconfigured', mode: process.env.BROWSER_MODE || 'unconfigured', tasks: tasks.length });
      const result = await runBrowserDiscoveryWindow({
        registry,
        spreadsheetId: args.includes('--no-sheet') ? '' : process.env.CAREER_OPS_SHEET_ID || '',
        discoveryOptions: {
          sessionManager, selectionResolver: () => browserSelectionFromEnv(), browserAdapter, sourceAdapters, tasks, strategy,
          onTask: event => discoveryLogger.write('discovery', 'discovery-task', event),
        },
      });
      discoveryLogger.write('discovery', 'discovery-finish', { status: result.status, providers: result.runMetrics, strategies: result.strategyMetrics, ranking: result.ranking, sheet: result.sheet, errors: result.errors, failures: result.discovery.failures });
      if (args.includes('--scheduled') && result.status !== 'FAILED' && config.browser_enrichment?.enabled !== false) {
        const enrichment = await runBrowserEnrichment({ registry, sessionManager: managedSession,
          selectionResolver: () => browserSelectionFromEnv(), browserAdapter: new ManagedChromeResearchAdapter(),
          maxTasks: Number(config.browser_enrichment?.maxTasks || maxTasks),
          executionBudget: config.browser_execution || {},
          onTask: event => discoveryLogger.write('discovery', 'enrichment-task', event) });
        let facebook={status:'SKIPPED',reason:'disabled'};if(config.browser_discovery?.sources?.facebook?.enabled!==false){try{facebook=await runFacebookMonitoring({registry});}catch(error){facebook={status:'FAILED',error:{code:error.code||'FACEBOOK_MONITOR_FAILED',message:error.message},mutations:{joins:0,comments:0,dms:0,posts:0}};}}
        const partial=enrichment.status==='FAILED'||result.status==='PARTIAL'||facebook.status==='FAILED';const combined = { status: partial ? 'PARTIAL' : result.status, exitCode: partial ? 2 : 0,
          scheduled: true, sequence: ['DISCOVERY', 'FACEBOOK_MONITORING', 'ENRICHMENT'], discovery: result, facebook, enrichment,
          automaticDailyIntegration: true, concurrentChromeSessions: false };
        discoveryLogger.write('discovery', 'research-window-finish', combined);
        console.log(JSON.stringify(combined, null, args.includes('--json') ? 2 : 0)); process.exitCode = combined.exitCode; return;
      }
      if(args.includes('--scheduled')&&config.browser_discovery?.sources?.facebook?.enabled!==false){let facebook;try{facebook=await runFacebookMonitoring({registry});}catch(error){facebook={status:'FAILED',error:{code:error.code||'FACEBOOK_MONITOR_FAILED',message:error.message},mutations:{joins:0,comments:0,dms:0,posts:0}};}const combined={...result,status:facebook.status==='FAILED'?'PARTIAL':result.status,exitCode:facebook.status==='FAILED'||result.status==='PARTIAL'?2:result.exitCode,scheduled:true,sequence:['DISCOVERY','FACEBOOK_MONITORING'],facebook,automaticDailyIntegration:true};console.log(JSON.stringify(combined,null,args.includes('--json')?2:0));process.exitCode=combined.exitCode;return;}
      console.log(JSON.stringify(result, null, args.includes('--json') ? 2 : 0)); process.exitCode = result.exitCode; return;
    }
    const tasks = buildResearchTasks({ config, companies: registry.listResearchCompanies(config.companyLimit) });
    const adapter = new ManagedChromeResearchAdapter();
    const provider = new BrowserResearchProvider({ adapter });
    const sessionManager = managedSession;
    logger.write('browser', 'research-start', {
      profile: process.env.BROWSER_PROFILE || 'unconfigured', mode: process.env.BROWSER_MODE || 'unconfigured', tasks: tasks.length,
      pages: tasks.map(({ id, kind, source, url }) => ({ id, kind, source, url })),
    });
    const result = await runBrowserResearch({ registry, sessionManager, selectionResolver: () => browserSelectionFromEnv(), provider, tasks });
    logger.write('browser', 'research-finish', { status: result.status, pages: result.browser.pages, evidence: result.browser.observations, failures: result.failures.length });
    if (result.failures.length) logger.write('browser', 'research-errors', { runId: result.run.id, failures: result.failures });
    console.log(JSON.stringify(result, null, args.includes('--json') ? 2 : 0)); process.exitCode = result.exitCode;
  } finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => {
  try { new LocalOperationalLogger({ root: process.env.CAREER_OPS_LOG_DIR || 'logs' }).write('browser', 'startup-failure', { code: error.code || 'BROWSER_RESEARCH_FAILED', message: error.message }); } catch {}
  console.error(`Browser Research failed: ${error.message}`); process.exitCode = 1;
});
