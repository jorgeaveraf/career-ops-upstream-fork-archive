import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPipelineAdmission, PIPELINE_ADMISSION_THRESHOLDS, PIPELINE_POLICY_VERSION } from '../intelligence/pipeline-admission.mjs';
import { selectTodayMembership } from '../human-control-plane/today-membership.mjs';
import { buildControlPlaneProjection, rowsToMatrix } from '../human-control-plane/projection.mjs';
import { MemorySheetsAdapter, SHEET_UX_VERSION } from '../human-control-plane/sheets-adapter.mjs';
import { buildPipelineDiagnostic } from '../pipeline-diagnostics.mjs';
import { buildTodayDiagnostic } from '../today-diagnostics.mjs';
import { detectOperationalSignals } from '../operational-intelligence/detectors.mjs';

const NOW='2026-08-31T20:00:00.000Z';
const state=(id,field,value)=>({entityType:'JOB',entityId:id,field,value});
function candidate(index, overrides={}) {
  const id=overrides.id||`job-${index}`;
  const fit=overrides.fit??90,quality=overrides.quality??80,priority=overrides.priority??90-index;
  const evidence=overrides.evidence||{description:{status:'PRESENT'},geography:{status:'SUPPORTED'},employment:{status:'PRESENT'},compensation:{status:'UNKNOWN'}};
  return {
    job:{id,company:overrides.company||`Company ${index}`,title:overrides.title||`AI Role ${index}`,location:'Remote — Mexico',
      description:overrides.description??'Complete role evidence and responsibilities. '.repeat(12),identityConfidence:overrides.identityConfidence||'high',
      status:overrides.jobStatus||'DISCOVERED',url:overrides.url===undefined?`https://example.test/${index}`:overrides.url,lastSeenAt:NOW,source:'fixture'},
    assessment:overrides.assessment===null?null:{eligibilityStatus:overrides.eligibility||'ELIGIBLE',decision:overrides.shortlist||'SHORTLIST',
      finalPriorityScore:priority,candidateFitScore:fit,opportunityScore:quality,confidence:overrides.assessmentConfidence||'high',employmentModel:overrides.employmentModel??'contract',
      result:{candidateFit:{score:fit},opportunity:{score:quality},eligibility:{signals:{employmentModel:overrides.employmentModel??'contract',evidenceCompleteness:evidence}}}},
    evaluation:overrides.evaluation===null?null:{status:overrides.evaluationStatus||'VALID',recommendation:overrides.recommendation||'APPLY',
      confidence:overrides.evaluationConfidence||'HIGH',overallFit:overrides.deepFit??90},
  };
}
function dataset(jobs,{humanState=[],applicationExecutions=[],enrichmentRequests=[]}={}) {
  const snapshot=jobs.filter(x=>x.assessment).map((x,index)=>({jobId:x.job.id,rank:index+1,eligibilityStatus:x.assessment.eligibilityStatus,
    decision:x.assessment.decision,finalPriorityScore:x.assessment.finalPriorityScore}));
  return {jobs,humanState,applicationExecutions,enrichmentRequests,humanHandoffs:[],contacts:[],contactResearch:[],communities:[],workflowStatuses:[],communityWorkflowStatuses:[],
    candidateSelection:{snapshot,activeCandidates:snapshot.map(x=>({jobId:x.jobId,state:'ACTIVE'})),researchNeeds:[],top10:snapshot.slice(0,10)}};
}

test('V4.7 versioned strong admission requires all quality gates',()=>{
  const result=selectPipelineAdmission(dataset([candidate(0)]));
  assert.equal(result.policyVersion,PIPELINE_POLICY_VERSION);assert.deepEqual(result.thresholds,PIPELINE_ADMISSION_THRESHOLDS);
  assert.equal(result.admitted.length,1);assert.equal(result.trace[0].result,'ADMITTED_PIPELINE');
});

test('unresolved eligibility remains Registry/Research and never enters Pipeline or TODAY',()=>{
  const input=dataset([candidate(0,{eligibility:'UNKNOWN'})]);
  assert.equal(selectPipelineAdmission(input).trace[0].exactRule,'ELIGIBILITY_NOT_RESOLVED');
  assert.equal(selectTodayMembership(input).members.length,0);
});

test('eligible but unevaluated candidates do not enter Pipeline',()=>{
  const result=selectPipelineAdmission(dataset([candidate(0,{evaluation:null})]));
  assert.equal(result.admitted.length,0);assert.equal(result.trace[0].exactRule,'EVALUATION_NOT_READY');
});

test('DO_NOT_APPLY is excluded from Pipeline but may remain a governed Human carryover',()=>{
  const job=candidate(0,{recommendation:'DO_NOT_APPLY'}),input=dataset([job],{humanState:[state(job.job.id,'human_decision','NEXT_STAGE')],enrichmentRequests:[{jobId:job.job.id,status:'READY_FOR_REVIEW'}]});
  assert.equal(selectPipelineAdmission(input).trace[0].exactRule,'PURSUIT_DO_NOT_APPLY');
  const today=selectTodayMembership(input);assert.equal(today.curated.length,0);assert.equal(today.carryovers.length,1);assert.equal(today.carryovers[0].admissionDetail,'EVALUATION_OR_PACKAGE_REVIEW_REQUIRED');
});

test('low candidate fit rejects contradictory APPLY recommendation',()=>{
  assert.equal(selectPipelineAdmission(dataset([candidate(0,{fit:60})])).trace[0].exactRule,'FIT_BELOW_THRESHOLD');
});

test('low opportunity quality rejects otherwise strong APPLY recommendation',()=>{
  assert.equal(selectPipelineAdmission(dataset([candidate(0,{quality:60})])).trace[0].exactRule,'OPPORTUNITY_QUALITY_BELOW_THRESHOLD');
});

test('insufficient and low-confidence evidence cannot enter Pipeline',()=>{
  assert.equal(selectPipelineAdmission(dataset([candidate(0,{description:'too short'})])).trace[0].exactRule,'INSUFFICIENT_EVIDENCE');
  const low=candidate(1,{evidence:{description:{status:'PRESENT'},geography:{status:'SUPPORTED'},employment:{status:'MISSING'},compensation:{status:'UNKNOWN'}}});
  assert.equal(selectPipelineAdmission(dataset([low])).trace[0].exactRule,'EVIDENCE_CONFIDENCE_BELOW_THRESHOLD');
});

test('Pipeline uses one deterministic priority ranking with stable tie breakers',()=>{
  const result=selectPipelineAdmission(dataset([candidate(0,{priority:80}),candidate(1,{priority:95}),candidate(2,{priority:90})]));
  assert.deepEqual(result.admitted.map(x=>[x.jobId,x.pipelineRank]),[['job-1',1],['job-2',2],['job-0',3]]);
});

test('TODAY normal rows are exactly Pipeline ranks 1 through 10',()=>{
  const input=dataset(Array.from({length:12},(_,i)=>candidate(i,{priority:100-i})));
  const pipeline=selectPipelineAdmission(input),today=selectTodayMembership(input,{pipeline});
  assert.deepEqual(today.curated.map(x=>x.jobId),pipeline.admitted.slice(0,10).map(x=>x.jobId));
  const projection=buildControlPlaneProjection(input);assert.deepEqual(projection.tabs.TODAY.map(x=>x.Rank),[1,2,3,4,5,6,7,8,9,10]);
});

test('Pipeline under ten yields healthy TODAY underfill without Registry fallback',()=>{
  const input=dataset([...Array.from({length:7},(_,i)=>candidate(i)),candidate(8,{eligibility:'UNKNOWN'}),candidate(9,{evaluation:null})]);
  const today=selectTodayMembership(input);assert.equal(today.pipeline.admitted.length,7);assert.equal(today.curated.length,7);
  assert.equal(today.outcome,'EXHAUSTED');assert.equal(today.diagnostics.exhaustionResult,'PIPELINE_STRONG_CANDIDATE_UNIVERSE_EXHAUSTED');
});

test('rank 11 promotes when Pipeline rank 3 becomes APPLIED',()=>{
  const jobs=Array.from({length:11},(_,i)=>candidate(i,{priority:100-i})),input=dataset(jobs);
  const before=selectTodayMembership(input);assert.equal(before.curated.at(-1).jobId,'job-9');
  input.applicationExecutions=[{jobId:'job-2',status:'APPLIED'}];const after=selectTodayMembership(input);
  assert.equal(after.curated.length,10);assert.equal(after.curated.some(x=>x.jobId==='job-2'),false);assert.equal(after.curated.at(-1).jobId,'job-10');
});

test('Human REJECT removes from Pipeline and promotes the next rank',()=>{
  const jobs=Array.from({length:11},(_,i)=>candidate(i,{priority:100-i})),input=dataset(jobs,{humanState:[state('job-2','human_decision','REJECT')]});
  const result=selectTodayMembership(input);assert.equal(result.curated.length,10);assert.equal(result.memberJobIds.includes('job-2'),false);assert.equal(result.curated.at(-1).jobId,'job-10');
});

test('strong HOLD remains a ranked Pipeline member but produces no Human attention',()=>{
  const input=dataset([candidate(0)],{humanState:[state('job-0','human_decision','HOLD')]});
  const projection=buildControlPlaneProjection(input);assert.equal(projection.tabs.PIPELINE[0].State,'HOLD');assert.equal(projection.tabs.TODAY[0].Rank,1);
  assert.equal(projection.tabs.TODAY[0].Status,'ON_HOLD');assert.equal(projection.tabs.SETTINGS.find(x=>x.Key==='Needs Your Attention').Value,0);
});

test('reauthorization remains a Human carryover without contaminating Pipeline',()=>{
  const job=candidate(0,{eligibility:'UNKNOWN'}),input=dataset([job],{humanState:[state('job-0','human_decision','NEXT_STAGE'),state('job-0','application_decision','HOLD')],enrichmentRequests:[{jobId:'job-0',status:'READY_FOR_REVIEW'}],applicationExecutions:[{jobId:'job-0',status:'CANCELLED'}]});
  const result=selectTodayMembership(input);assert.equal(result.pipeline.admitted.length,0);assert.equal(result.carryovers[0].admissionDetail,'REAUTHORIZATION_REQUIRED');
});

test('candidate re-enters when evidence and evaluation become sufficient',()=>{
  const weak=dataset([candidate(0,{evaluation:null})]);assert.equal(selectPipelineAdmission(weak).admitted.length,0);
  const repaired=dataset([candidate(0)]);assert.equal(selectPipelineAdmission(repaired).admitted.length,1);
});

test('canonical job identity prevents duplicate active Pipeline rows',()=>{
  const same=candidate(0),duplicate=structuredClone(same);duplicate.job.title='duplicate observation';
  const result=selectPipelineAdmission(dataset([same,duplicate]));assert.equal(result.registryCount,1);assert.equal(result.admitted.length,1);
});

test('stable Pipeline projection writes zero data on the second pass',async()=>{
  const projection=buildControlPlaneProjection(dataset([candidate(0),candidate(1)]));
  const adapter=new MemorySheetsAdapter({layoutVersion:SHEET_UX_VERSION});await adapter.initialize();
  await adapter.writeTab('PIPELINE',rowsToMatrix('PIPELINE',projection.tabs.PIPELINE));
  const second=await adapter.writeTab('PIPELINE',rowsToMatrix('PIPELINE',projection.tabs.PIPELINE));
  assert.equal(second.dataMutations,0);assert.equal(second.structuralMutations,0);
});

test('Pipeline and TODAY diagnostics expose bounded deterministic traces',()=>{
  const input=dataset([candidate(0),candidate(1,{evaluation:null})]);
  const pipeline=buildPipelineDiagnostic(input),today=buildTodayDiagnostic(input);
  assert.equal(pipeline.registryCount,2);assert.equal(pipeline.admittedPipelineCount,1);assert.equal(pipeline.trace.length,2);
  assert.equal(today.pipelineStrongCandidates,1);assert.equal(today.todayCuratedFromPipeline,1);assert.equal(today.generatedFrom,'STRONG_PIPELINE_PLUS_GOVERNED_HUMAN_CARRYOVERS');
});

test('legitimate small Pipeline is healthy while invariant failures signal',()=>{
  assert.equal(detectOperationalSignals({pipeline:{admittedCount:4,admissibleNotProjected:0,rankInvariant:true,duplicateActive:[],terminalPresent:[],policyContradictions:[]},today:{outcome:'EXHAUSTED'}}).some(x=>x.signalType.startsWith('PIPELINE_')),false);
  const signals=detectOperationalSignals({pipeline:{admissibleNotProjected:1,rankInvariant:false,duplicateActive:['dup'],terminalPresent:['terminal'],policyContradictions:['conflict']}});
  for(const type of ['PIPELINE_ADMISSIBLE_NOT_PROJECTED','PIPELINE_RANK_INVARIANT_FAILED','PIPELINE_DUPLICATE_ACTIVE','PIPELINE_TERMINAL_PRESENT','PIPELINE_POLICY_CONTRADICTION'])assert.ok(signals.some(x=>x.signalType===type));
});
