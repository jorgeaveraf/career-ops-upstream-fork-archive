import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyApplicationReconciliation, mayResumeApplicationExecution, persistApplicationReconciliation } from '../application-execution/reconciliation.mjs';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';

const NOW = '2026-08-27T19:30:00.000Z';
const unknownEvidence = [
  { source:'ATS_PAGE', outcome:'VERIFICATION_UNKNOWN', url:'https://jobs.ashbyhq.com/supabase/job/application', signal:'blank_enabled_form' },
  { source:'BROWSER_HISTORY', outcome:'VERIFICATION_UNKNOWN', signal:'repeated_application_url_only' },
  { source:'CONFIRMATION_EMAIL', outcome:'VERIFICATION_UNKNOWN', signal:'mailbox_unavailable', absenceIsFailure:false },
];

function fakeRegistry() {
  let execution = { id:'execution-1', authorizationId:'authorization-1', jobId:'job-1', status:'NEEDS_HUMAN', blocker:{code:'VERIFICATION_UNKNOWN'} };
  const calls = { finish:[], authorizations:0 };
  return {
    calls,
    getApplicationExecution(id) { return id === execution.id ? execution : null; },
    finishApplicationExecution(id, patch) { calls.finish.push(patch); execution = { ...execution, status:patch.status, currentStage:patch.stage, confirmation:patch.confirmation || {}, blocker:patch.blocker || {}, finishedAt:patch.status === 'APPLIED' ? NOW : null, updatedAt:NOW }; return execution; },
    createApplicationExecutionAuthorization() { calls.authorizations++; throw new Error('must not create an authorization'); },
  };
}

function projection(execution) {
  const job = { job:{id:'job-1',title:'Pre-Sales Solutions Architect (SA) Leader',company:'Supabase',location:'Remote',url:'https://jobs.ashbyhq.com/supabase/job',source:'ashby',lastSeenAt:NOW},assessment:{eligibilityStatus:'ELIGIBLE',finalPriorityScore:90,confidence:'high',result:{candidateFit:{reasons:['Relevant work.']}}} };
  return buildControlPlaneProjection({ jobs:[job], contacts:[], contactResearch:[], followUps:[], runs:[], syncState:null, enrichmentRequests:[{jobId:'job-1',status:'READY_FOR_REVIEW'}], applicationExecutions:[execution], humanState:[{entityType:'JOB',entityId:'job-1',field:'human_decision',value:'NEXT_STAGE'},{entityType:'JOB',entityId:'job-1',field:'application_decision',value:'APPROVE_TO_APPLY'}], candidateSelection:{activeCandidates:[{jobId:'job-1',state:'ACTIVE',source:'ashby'}],snapshot:[{jobId:'job-1',rank:1,finalPriorityScore:90,eligibilityStatus:'ELIGIBLE'}],researchNeeds:[]} }).tabs;
}

test('confirmation email and portal history are strong APPLIED evidence', () => {
  for (const evidence of [
    {source:'CONFIRMATION_EMAIL',outcome:'APPLIED_CONFIRMED',messageId:'mail-1',observedAt:NOW},
    {source:'PORTAL_HISTORY',outcome:'APPLIED_CONFIRMED',applicationId:'app-1',url:'https://portal.test/app-1',observedAt:NOW},
  ]) assert.equal(classifyApplicationReconciliation([evidence]).outcome, 'APPLIED_CONFIRMED');
});

test('absence of email and an enabled blank form do not mean failed or not applied', () => {
  const result = classifyApplicationReconciliation(unknownEvidence);
  assert.equal(result.outcome, 'VERIFICATION_UNKNOWN');
  assert.equal(mayResumeApplicationExecution({status:'NEEDS_HUMAN',blocker:{code:'VERIFICATION_UNKNOWN'}}, result), false);
});

test('only explicit NOT_APPLIED evidence permits resuming the same execution', () => {
  const result = classifyApplicationReconciliation([{source:'ATS_CONFIRMATION',outcome:'NOT_APPLIED_CONFIRMED',explicitNotApplied:true,signal:'explicit_no_application_record'}]);
  assert.equal(result.outcome, 'NOT_APPLIED_CONFIRMED');
  assert.equal(mayResumeApplicationExecution({id:'execution-1',status:'NEEDS_HUMAN'}, result), true);
});

test('positive APPLIED evidence wins over conflicting NOT_APPLIED and protects against duplicates', () => {
  const result = classifyApplicationReconciliation([
    {source:'ATS_CONFIRMATION',outcome:'NOT_APPLIED_CONFIRMED',explicitNotApplied:true},
    {source:'EXTERNAL_APPLICATION_ID',outcome:'APPLIED_CONFIRMED',applicationId:'app-1'},
  ]);
  assert.equal(result.outcome, 'APPLIED_CONFIRMED');
  assert.equal(mayResumeApplicationExecution({status:'NEEDS_HUMAN'}, result), false);
});

test('unknown reconciliation remains TODAY with manual no-resubmit wording and creates no authorization', () => {
  const registry = fakeRegistry();
  const result = classifyApplicationReconciliation(unknownEvidence);
  const execution = persistApplicationReconciliation({registry,executionId:'execution-1',reconciliation:result});
  const tabs = projection(execution);
  assert.equal(execution.status, 'NEEDS_HUMAN');
  assert.equal(execution.blocker.question, 'Application submission could not be verified');
  assert.equal(tabs.TODAY[0]['Recommended Action'], 'Verifica el ATS o el correo; elige una resolución. No reintentes el envío.');
  assert.equal(tabs.APPLICATIONS.length, 0);
  assert.equal(registry.calls.authorizations, 0);
});

test('strong confirmation persists APPLIED and moves TODAY to APPLICATIONS without a new authorization', () => {
  const registry = fakeRegistry();
  const result = classifyApplicationReconciliation([{source:'CONFIRMATION_EMAIL',outcome:'APPLIED_CONFIRMED',messageId:'mail-1',observedAt:NOW}]);
  const execution = persistApplicationReconciliation({registry,executionId:'execution-1',reconciliation:result});
  const tabs = projection(execution);
  assert.equal(execution.status, 'APPLIED');
  assert.equal(tabs.TODAY.length, 0);
  assert.equal(tabs.APPLICATIONS[0]['Entity ID'], 'job-1');
  assert.equal(tabs.APPLICATIONS[0].Confirmation, 'mail-1');
  assert.equal(registry.calls.authorizations, 0);
});
