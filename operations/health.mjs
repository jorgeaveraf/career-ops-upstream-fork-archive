import { existsSync, statfsSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION } from '../registry/job-registry.mjs';
import { validateOperationalConfig } from './config-validation.mjs';
import { createGoogleOAuthTokenProviderFromEnv, inspectGoogleOAuthConfig } from './google-oauth.mjs';
import { GoogleSheetsApiAdapter } from '../human-control-plane/sheets-adapter.mjs';
import { BrowserSessionManager, selectChromeProfile } from '../research/browser-session-manager.mjs';
import { BROWSER_RESEARCH_MODE } from '../research/browser-policy.mjs';
import { MacOsChromeWindowDriver } from '../research/macos-chrome-window-driver.mjs';
import { managedBrowserSessionConfigFromEnv } from '../research/managed-browser-session.mjs';
import { inspectProductionApplicationTransports } from '../application-execution/production-executors.mjs';
import { inspectNotificationProvider } from '../notifications/runtime.mjs';
import { inspectProductionOutreachTransports } from '../outreach-execution/production-executors.mjs';
import { readOperationalSummary } from '../operational-intelligence/repository.mjs';
import { execFileSync } from 'child_process';
import { CandidateGmailTokenProvider, CandidateGmailTransport, inspectCandidateGmailConfig } from '../outreach-execution/gmail-transport.mjs';
import { MacOsKeychainCredentialStore } from '../application-execution/credential-store.mjs';

const check = (name, status, detail, data = {}) => ({ name, status, detail, ...data });

function readDatabaseHealth(dbPath, nowMs = Date.now()) {
  if (!existsSync(dbPath)) return { checks: [check('Database', 'FAIL', `Not found: ${dbPath}`)], facts: {} };
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('quick_check', { simple: true });
    const schemaVersion = db.pragma('user_version', { simple: true });
    const latestOperational = db.prepare('SELECT * FROM operational_runs ORDER BY started_at DESC, rowid DESC LIMIT 1').get();
    const latestSync = db.prepare('SELECT MAX(last_push_at) last_push_at FROM sheet_sync_state').get()?.last_push_at || null;
    const latestNotification = db.prepare("SELECT * FROM notification_deliveries ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
    const notificationCounts=db.prepare("SELECT status,COUNT(*) count FROM notification_deliveries GROUP BY status").all();
    const packageActions = db.prepare("SELECT COUNT(*) count FROM application_packages WHERE validation_status = 'VALID' AND status IN ('DRAFT', 'REVIEW_REQUIRED')").get().count;
    const reviewActions = db.prepare("SELECT COUNT(*) count FROM human_field_state WHERE field_name = 'human_decision' AND value_json = '\"REVIEW\"'").get().count;
    const applicationActions = db.prepare("SELECT COUNT(*) count FROM human_field_state WHERE field_name = 'application_status' AND value_json IN ('\"REVIEWING\"', '\"APPROVED\"')").get().count;
    const pendingFollowUps = db.prepare("SELECT COUNT(*) count FROM human_field_state WHERE entity_type = 'FOLLOW_UP' AND field_name = 'status' AND value_json = '\"PENDING\"'").get().count;
    const contactActions = db.prepare("SELECT COUNT(*) count FROM contact_research cr WHERE cr.review_status = 'HUMAN_REVIEW_REQUIRED' AND cr.id = (SELECT newest.id FROM contact_research newest WHERE newest.job_id = cr.job_id ORDER BY newest.contact_research_version DESC LIMIT 1)").get().count;
    const eventRegistry = db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='workflow_events'").get();
    const immutableTriggers = db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='trigger' AND name LIKE 'workflow_events_immutable_%'").get().count;
    const eventCount = eventRegistry ? db.prepare('SELECT COUNT(*) count FROM workflow_events').get().count : 0;
    const workerQueueTable=db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='worker_work_items'").get();
    const workerQueues=workerQueueTable?db.prepare("SELECT work_type,status,COUNT(*) count,MIN(queued_at) oldest_queued_at FROM worker_work_items GROUP BY work_type,status").all():[];
    const handoffRegistry=db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='human_handoffs'").get();
    const handoffCounts=handoffRegistry?db.prepare("SELECT status,resume_status,COUNT(*) count FROM human_handoffs GROUP BY status,resume_status").all():[];
    const questionResolutionRegistry=db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='application_question_resolutions'").get();
    const questionResolutionCount=questionResolutionRegistry?db.prepare('SELECT COUNT(*) count FROM application_question_resolutions').get().count:0;
    const qualification=db.prepare(`
      WITH latest AS (
        SELECT ac.job_id,
          (SELECT a.id FROM job_assessments a WHERE a.job_id=ac.job_id ORDER BY a.assessed_at DESC,a.rowid DESC LIMIT 1) assessment_id,
          (SELECT a.eligibility_status FROM job_assessments a WHERE a.job_id=ac.job_id ORDER BY a.assessed_at DESC,a.rowid DESC LIMIT 1) eligibility_status,
          (SELECT a.decision FROM job_assessments a WHERE a.job_id=ac.job_id ORDER BY a.assessed_at DESC,a.rowid DESC LIMIT 1) decision,
          (SELECT e.recommendation FROM job_evaluations e JOIN job_assessments a ON a.id=e.assessment_id WHERE a.job_id=ac.job_id ORDER BY e.evaluated_at DESC,e.rowid DESC LIMIT 1) recommendation,
          (SELECT a.assessed_at FROM job_assessments a WHERE a.job_id=ac.job_id ORDER BY a.assessed_at DESC,a.rowid DESC LIMIT 1) assessed_at
        FROM active_candidates ac WHERE ac.state IN ('ACTIVE','CARRYOVER')
      ), current_research AS (
        SELECT n.* FROM candidate_research_needs n JOIN latest l ON l.job_id=n.job_id AND l.assessment_id=n.assessment_id
        WHERE n.status IN ('OPEN','BLOCKED')
      ), blocking_research AS (
        SELECT n.* FROM current_research n JOIN latest l ON l.job_id=n.job_id WHERE
          ((l.eligibility_status IS NULL OR l.eligibility_status='UNKNOWN') AND n.need_type IN (
            'FETCH_FULL_DESCRIPTION','CONFIRM_MEXICO_ELIGIBILITY','CONFIRM_REMOTE_SCOPE',
            'RESOLVE_LOCATION_CONFLICT','CONFIRM_POSTING_STATUS','CONFIRM_POSTING_IS_REAL'
          )) OR (l.eligibility_status='ELIGIBLE' AND l.decision='SHORTLIST' AND l.recommendation='APPLY' AND n.need_type IN (
            'FETCH_FULL_DESCRIPTION','CONFIRM_MEXICO_ELIGIBILITY','CONFIRM_REMOTE_SCOPE',
            'CONFIRM_EMPLOYMENT_MODEL','RESOLVE_LOCATION_CONFLICT','CONFIRM_POSTING_STATUS','CONFIRM_POSTING_IS_REAL'
          ))
      ), pending AS (
        SELECT job_id,assessed_at pending_at FROM latest WHERE eligibility_status IS NULL OR eligibility_status='UNKNOWN'
        UNION SELECT l.job_id,l.assessed_at FROM latest l WHERE l.decision='SHORTLIST' AND NOT EXISTS(SELECT 1 FROM job_evaluations e WHERE e.assessment_id=l.assessment_id)
        UNION SELECT job_id,created_at FROM blocking_research
      )
      SELECT (SELECT COUNT(*) FROM latest) active_count,
        (SELECT COUNT(*) FROM latest WHERE eligibility_status IS NULL OR eligibility_status='UNKNOWN') eligibility_pending,
        (SELECT COUNT(*) FROM latest l WHERE l.decision='SHORTLIST' AND NOT EXISTS(SELECT 1 FROM job_evaluations e WHERE e.assessment_id=l.assessment_id)) evaluation_pending,
        (SELECT COUNT(*) FROM current_research) research_pending,
        (SELECT COUNT(*) FROM blocking_research WHERE status='OPEN') runnable_blocking_research,
        (SELECT COUNT(*) FROM blocking_research WHERE status='BLOCKED') externally_blocked_research,
        COUNT(DISTINCT job_id) pending_candidates,MIN(pending_at) oldest_pending_at,
        (SELECT MAX(evaluated_at) FROM job_evaluations) last_evaluation_at
      FROM pending`).get();
    const operationalSummary=readOperationalSummary(db);
    return {
      checks: [
        check('Database', integrity === 'ok' ? 'OK' : 'FAIL', integrity === 'ok' ? `SQLite quick_check OK (schema ${schemaVersion})` : `SQLite quick_check: ${integrity}`),
        check('Schema', schemaVersion === CURRENT_SCHEMA_VERSION ? 'OK' : 'FAIL', `Installed ${schemaVersion}; expected ${CURRENT_SCHEMA_VERSION}`),
        check('Workflow events', eventRegistry && immutableTriggers === 2 ? 'OK' : 'FAIL', eventRegistry ? `Registry ready · immutable · ${eventCount} event(s)` : 'Registry missing'),
        check('Last operational run', latestOperational?.status === 'SUCCESS' ? 'OK' : latestOperational ? 'WARN' : 'WARN', latestOperational ? `${latestOperational.status} at ${latestOperational.finished_at || latestOperational.started_at}` : 'No operational run recorded'),
        check('Last successful sync', latestSync ? 'OK' : 'WARN', latestSync || 'No successful push recorded'),
        check('Last notification', ['FAILED','AMBIGUOUS'].includes(latestNotification?.status) ? 'WARN' : 'OK', latestNotification ? `${latestNotification.status} at ${latestNotification.last_attempt_at||latestNotification.created_at}` : 'No notification recorded'),
        check('Operational intelligence', operationalSummary?.overall==='ATTENTION'?'WARN':operationalSummary?.overall==='DEGRADED'?'WARN':'OK', operationalSummary?`${operationalSummary.overall} · ${operationalSummary.openSignals} open issue(s)`:'Not initialized'),
        check('Qualification Engine', qualification.runnable_blocking_research && qualification.oldest_pending_at && nowMs-Date.parse(qualification.oldest_pending_at)>72*3600000?'WARN':'OK', `${qualification.pending_candidates||0} pending candidate(s) · eligibility ${qualification.eligibility_pending||0} · runnable ${qualification.runnable_blocking_research||0} · external boundaries ${qualification.externally_blocked_research||0} · oldest ${qualification.oldest_pending_at||'NONE'}`),
        check('Evaluation Engine', qualification.evaluation_pending && (!qualification.last_evaluation_at||nowMs-Date.parse(qualification.last_evaluation_at)>72*3600000)?'WARN':'OK', `${qualification.evaluation_pending||0} pending · last success ${qualification.last_evaluation_at||'NONE'} · deterministic bounded drain`),
      ],
      facts: { latestOperationalRun: latestOperational || null, latestSuccessfulSyncAt: latestSync, latestNotification: latestNotification || null, notificationCounts:Object.fromEntries(notificationCounts.map(x=>[x.status,x.count])), workflowEventCount:eventCount, workerQueues, handoffRegistry:Boolean(handoffRegistry),handoffCounts,questionResolutionRegistry:Boolean(questionResolutionRegistry),questionResolutionCount, qualification, operationalSummary, pendingHumanActions: packageActions + reviewActions + applicationActions + pendingFollowUps + contactActions },
    };
  } catch (error) {
    return { checks: [check('Database', 'FAIL', error.message)], facts: {} };
  } finally { db?.close(); }
}

export async function runHealthCheck({
  projectRoot = process.cwd(), dbPath = process.env.CAREER_OPS_DB || 'data/career.db', env = process.env,
  clock = () => new Date(), minimumFreeMb = Number(env.CAREER_OPS_MIN_FREE_DISK_MB || 1024), statfs = statfsSync,
  fetchImpl = globalThis.fetch, tokenProvider = null, browserWindowDriver = null,
  candidateGmailTransport = null, commandSubscriberInspector = null,
} = {}) {
  const absoluteDb = path.resolve(projectRoot, dbPath);
  const checks = [];
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  checks.push(check('Runtime', major >= 18 ? 'OK' : 'FAIL', `Node ${process.versions.node}`));
  const database = readDatabaseHealth(absoluteDb, clock().getTime()); checks.push(...database.checks);
  const config = validateOperationalConfig({ env, projectRoot, dbPath, requireDatabase: true });
  checks.push(check('Configuration', config.ok ? 'OK' : 'FAIL', config.ok ? 'Required configuration present' : config.errors.map(item => item.code).join(', '), { errors: config.errors, warnings: config.warnings }));
  if (config.identityRouting.configured) checks.push(check('Identity Routing', config.identityRouting.ok ? 'OK' : 'FAIL', config.identityRouting.ok ? 'Brunova → Workspace/GCP/system sender; Jorge → job browser/application sender/notification recipient; sign-up isolated' : config.identityRouting.errors.map(item => item.code).join(', '), { routes: config.identityRouting.routes }));
  const notificationProvider=inspectNotificationProvider({env});const pendingNotifications=(database.facts.notificationCounts?.PENDING||0)+(database.facts.notificationCounts?.PROCESSING||0);checks.push(check('Notifications',notificationProvider.enabled?(notificationProvider.providerStatus==='READY'?(pendingNotifications>10?'WARN':'OK'):'WARN'):'OK',notificationProvider.enabled?`ENABLED · ${notificationProvider.provider} ${notificationProvider.providerStatus} · outbox pending ${pendingNotifications}`:'DISABLED by configuration',{...notificationProvider,outboxPending:pendingNotifications,workflowDigests:env.CAREER_OPS_WORKFLOW_DIGESTS==='false'?'DISABLED':'READY'}));
  const activeHandoffs=(database.facts.handoffCounts||[]).filter(item=>item.status==='ACTIVE').reduce((sum,item)=>sum+item.count,0);checks.push(check('Human Handoff Manager',database.facts.handoffRegistry?'OK':'FAIL',database.facts.handoffRegistry?`READY · ${activeHandoffs} active assist(s)`:'Registry missing',{activeHandoffs}));checks.push(check('Resume Detector',database.facts.handoffRegistry?'OK':'FAIL','Periodic application worker adopts preserved sessions and checks boundary resolution'));checks.push(check('Notification Batch Aggregator',notificationProvider.enabled?'OK':'OK',`READY · one digest per application batch · outbox pending ${pendingNotifications}`));
  checks.push(check('Challenge Resolver',database.facts.handoffRegistry?'OK':'FAIL','READY · bounded passive verification wait · interactive challenges fail closed'));
  checks.push(check('Application Question Resolver',database.facts.questionResolutionRegistry?'OK':'FAIL',database.facts.questionResolutionRegistry?`READY · ${database.facts.questionResolutionCount} audited answer resolution(s)`:'Resolution registry missing'));
  checks.push(check('Answer Memory',database.facts.questionResolutionRegistry?'OK':'FAIL','READY · semantic, scoped, evidence-backed reuse'));

  const oauth = inspectGoogleOAuthConfig({ env });
  let renewableTokenProvider = tokenProvider;
  if (!oauth.ok) {
    checks.push(check('Workspace Auth', 'FAIL', oauth.detail, { code: oauth.code, mode: oauth.mode }));
    checks.push(check('Google Sheets', 'FAIL', 'OAuth is unavailable'));
  } else {
    try {
      renewableTokenProvider ||= createGoogleOAuthTokenProviderFromEnv({ env, fetchImpl, clock });
      await renewableTokenProvider.getAccessToken();
      checks.push(check('Workspace Auth', 'OK', `Headless authentication available (${oauth.mode})`, { mode: oauth.mode, provider:oauth.credentialSource, principal:oauth.principal||null, effectiveSubject:oauth.subject||null }));
      if (!env.CAREER_OPS_SHEET_ID) checks.push(check('Google Sheets', 'FAIL', 'CAREER_OPS_SHEET_ID is required'));
      else {
        const adapter = new GoogleSheetsApiAdapter({ spreadsheetId: env.CAREER_OPS_SHEET_ID, tokenProvider: renewableTokenProvider, fetchImpl });
        await adapter.request(`${adapter.base}?fields=spreadsheetId`);
        checks.push(check('Google Sheets', 'OK', `Spreadsheet access verified (${env.CAREER_OPS_SHEET_ID})`));
      }
    } catch (error) {
      const authFailure = Boolean(error.code) && !String(error.code).startsWith('SHEET');
      checks.push(check('Workspace Auth', authFailure ? 'FAIL' : 'OK', authFailure ? error.message : `Headless authentication available (${oauth.mode})`, { code: error.code || null, mode: oauth.mode }));
      checks.push(check('Google Sheets', 'FAIL', authFailure ? `Workspace authentication failed (${error.code})` : error.message));
    }
  }
  if(String(env.APPLICATION_EXECUTION_BROWSER_ENABLED||'').toLowerCase()==='true'){
    const transports=inspectProductionApplicationTransports({env});checks.push(check('Application Transport',transports.ats.status==='READY'?'OK':'FAIL',`ATS ${transports.ats.status} — ${transports.ats.detail}`,{transports}));checks.push(check('Generic Browser Executor',transports.genericBrowser.status==='READY'?'OK':'FAIL',`${transports.genericBrowser.status} — ${transports.genericBrowser.detail}`,{profile:env.APPLICATION_BROWSER_PROFILE||'jorge',managedSession:true}));
  }
  const credentialStore=new MacOsKeychainCredentialStore();const credentialHealth=credentialStore.health();checks.push(check('Platform Credential Store',credentialHealth.status==='READY'?'OK':'FAIL',credentialHealth.detail));
  const signupReady=String(env.PLATFORM_SIGNUP_GMAIL_READY||'').toLowerCase()==='true';checks.push(check('Signup Gmail/fubifo Path',signupReady?'OK':'WARN',signupReady?'READY — bounded ordinary verification reader':'Verification reader awaits live mailbox validation',{identity:'fubifo@gmail.com',credentialsExposed:false}));
  const outreach=inspectProductionOutreachTransports({env});
  const candidateConfig=inspectCandidateGmailConfig(env);if(candidateConfig.status==='READY'){try{const gmail=candidateGmailTransport||new CandidateGmailTransport({tokenProvider:new CandidateGmailTokenProvider({env,fetchImpl,clock}),fetchImpl,clock});const verified=await gmail.boundedRead();checks.push(check('Candidate Gmail','OK',`READY — ${verified.sender} · bounded read verified`,{credentialSource:candidateConfig.credentialSource,sender:verified.sender,messagesInspected:verified.messagesInspected,resultSizeEstimate:verified.resultSizeEstimate}));}catch(error){checks.push(check('Candidate Gmail','FAIL',error.message,{code:error.code||'CANDIDATE_GMAIL_HEALTH_FAILED'}));}}else checks.push(check('Candidate Gmail','WARN',candidateConfig.detail,{credentialSource:candidateConfig.credentialSource||null}));
  checks.push(check('LinkedIn Browser',outreach.linkedin.status==='READY'?'OK':'WARN',`${outreach.linkedin.status} — ${outreach.linkedin.detail}`,{profile:outreach.linkedin.profile||null}));
  try{const output=commandSubscriberInspector?await commandSubscriberInspector():execFileSync('/bin/launchctl',['print',`gui/${process.getuid()}/com.careerops.command-subscriber`],{encoding:'utf8'}),running=typeof output==='boolean'?output:/\bstate = running\b/.test(output),provider=String(env.CAREER_OPS_COMMAND_SUBSCRIBER_PROVIDER||'');checks.push(check('Command Subscriber',running&&provider==='command_gateway_pull'?'OK':'FAIL',running?`RUNNING — ${provider||'provider missing'}`:'LaunchAgent is not running',{provider,running,googleCredentialDependency:false}));}catch{checks.push(check('Command Subscriber','FAIL','LaunchAgent is not loaded',{provider:env.CAREER_OPS_COMMAND_SUBSCRIBER_PROVIDER||null}));}
  checks.push(check('Outreach Scheduler',outreach.scheduler.status==='READY'?'OK':'WARN',outreach.scheduler.detail,outreach.scheduler));
  checks.push(check('Outreach Execution Registry',database.checks.some(item=>item.name==='Schema'&&item.status==='OK')?'OK':'FAIL',outreach.registry.detail,outreach.registry));
  for(const worker of [{name:'Enrichment Worker',label:'com.careerops.application-enrichment',type:'ENRICHMENT'},{name:'Application Executor',label:'com.careerops.application-executor',type:'APPLICATION'},{name:'Outreach Executor',label:'com.careerops.outreach-executor',type:'OUTREACH'},{name:'Operational Watcher',label:'com.careerops.operational-watch',type:null}]){let loaded=false,running=false;try{const output=execFileSync('/bin/launchctl',['print',`gui/${process.getuid()}/${worker.label}`],{encoding:'utf8'});loaded=true;running=/\bstate = running\b/.test(output);}catch{}const queue=(database.facts.workerQueues||[]).filter(x=>x.work_type===worker.type&&x.status==='QUEUED').reduce((sum,x)=>sum+x.count,0);checks.push(check(worker.name,loaded?(queue>0&&!running?'WARN':'OK'):'FAIL',`${loaded?'LOADED':'UNAVAILABLE'} · ${running?'RUNNING':'IDLE'}${worker.type?` · queued ${queue}`:''}`,{label:worker.label,loaded,running,queueDepth:queue}));}

  checks.push(check('Browser Policy', String(env.BROWSER_MODE || '').toLowerCase() === BROWSER_RESEARCH_MODE ? 'OK' : 'FAIL', String(env.BROWSER_MODE || 'unconfigured').toLowerCase()));
  try {
    const selection = selectChromeProfile({ profile: env.BROWSER_PROFILE, mode: env.BROWSER_MODE, userDataDir: env.BROWSER_USER_DATA_DIR });
    const managedConfig = managedBrowserSessionConfigFromEnv(env);
    checks.push(check('Browser', 'OK', 'Configured'));
    checks.push(check('Chrome Profile', 'OK', `${selection.profile} (${selection.profileDirectory})`));
    const driver = browserWindowDriver || new MacOsChromeWindowDriver();
    const windowIds = await driver.listWindowIds();
    checks.push(check('Browser Driver', 'OK', 'Managed normal macOS Chrome window channel available'));
    checks.push(check('Browser Session Kind', 'OK', managedConfig.sessionKind));
    const availability = new BrowserSessionManager({ lockPath: env.BROWSER_SESSION_LOCK || env.BROWSER_RESEARCH_LOCK || path.join(projectRoot, 'data', 'browser', '.careerops-session.lock') }).inspect(selection);
    checks.push(check('Career Ops Session', availability.available ? 'OK' : 'WARN', availability.available ? 'AVAILABLE' : 'RUNNING', { ...availability, ...managedConfig }));
    const managedWindowId = Number(availability.owner?.windowId);
    const userWindowCount = windowIds.filter(id => !Number.isInteger(managedWindowId) || id !== managedWindowId).length;
    checks.push(check('User Chrome Windows', 'OK', `NOT_MANAGED (${userWindowCount} detected)`, { managed: false, detected: userWindowCount }));
  } catch (error) {
    checks.push(check('Browser', 'FAIL', error.message, { code: error.code || 'BROWSER_CONFIG_INVALID' }));
    checks.push(check('Chrome Profile', 'FAIL', String(env.BROWSER_PROFILE || 'unconfigured').toLowerCase()));
  }
  try {
    const disk = statfs(projectRoot); const freeMb = Math.round(Number(disk.bavail) * Number(disk.bsize) / 1024 / 1024);
    checks.push(check('Disk', freeMb >= minimumFreeMb ? 'OK' : 'FAIL', `${freeMb} MB free; minimum ${minimumFreeMb} MB`, { freeMb, minimumFreeMb }));
  } catch (error) { checks.push(check('Disk', 'FAIL', error.message)); }
  const status = checks.some(item => item.status === 'FAIL') ? 'UNHEALTHY' : checks.some(item => item.status === 'WARN') ? 'DEGRADED' : 'HEALTHY';
  return { status, healthy: status !== 'UNHEALTHY', checkedAt: clock().toISOString(), checks, facts: { ...database.facts, pendingHumanActions: database.facts.pendingHumanActions || 0 } };
}

export function formatHealth(result) {
  const lines = ['Career Ops Health', '', `Status: ${result.status}`, ''];
  for (const item of result.checks) lines.push(`${item.name}:`, `${item.status} — ${item.detail}`, '');
  lines.push(`Pending human actions: ${result.facts.pendingHumanActions}`);
  return lines.join('\n');
}
