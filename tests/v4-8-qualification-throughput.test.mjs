import test from 'node:test';
import assert from 'node:assert/strict';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';
import { selectTodayMembership, TODAY_REFILL_OUTCOMES } from '../human-control-plane/today-membership.mjs';
import { buildInfrastructureVisibilityRequests } from '../human-control-plane/sheet-ux.mjs';
import { drainQualificationBacklog } from '../automation/qualification-orchestrator.mjs';
import { openCandidateKnowledge } from '../candidate-knowledge/provider.mjs';

const NOW = '2026-08-31T18:00:00.000Z';
function strongData(count = 12, { research = [] } = {}) {
  const jobs = Array.from({ length: count }, (_, index) => ({
    job: { id:`job-${index}`,company:`Company ${index}`,title:`Role ${index}`,location:'Remote',description:'Senior AI systems leadership role with production engineering ownership. '.repeat(8),url:`https://example.test/${index}`,status:'DISCOVERED',lastSeenAt:NOW,source:'fixture',identityConfidence:'HIGH' },
    assessment: { eligibilityStatus:'ELIGIBLE',decision:'SHORTLIST',candidateFitScore:90,opportunityScore:85,finalPriorityScore:100-index,confidence:'HIGH',result:{candidateFit:{score:90},opportunity:{score:85},eligibility:{signals:{employmentModel:'contract',evidenceCompleteness:{description:{status:'PRESENT'},geography:{status:'SUPPORTED'},employment:{status:'PRESENT'},compensation:{status:'SUPPORTED'},schedule:{status:'SUPPORTED'},companyMarket:{status:'SUPPORTED'},posting:{status:'SUPPORTED'}}}}} },
    evaluation: { status:'VALID',recommendation:'APPLY',confidence:'HIGH',overallFit:90,evaluatedAt:NOW },
  }));
  const activeCandidates=jobs.map((item,index)=>({jobId:item.job.id,state:'ACTIVE',source:'fixture',freshnessDays:0,updatedAt:NOW,selectionRank:index+1}));
  const snapshot=jobs.map((item,index)=>({jobId:item.job.id,rank:index+1,finalPriorityScore:100-index,eligibilityStatus:'ELIGIBLE',decision:'SHORTLIST',candidateFitScore:90,opportunityScore:85,evidenceWeak:false}));
  return { jobs,humanState:[],enrichmentRequests:[],applicationExecutions:[],candidateSelection:{activeCandidates,snapshot,researchNeeds:research,reassessmentQueue:[]} };
}

test('TODAY is global Strong Pool ranks 1-10 and PIPELINE is disjoint ranks 11+', () => {
  const projection=buildControlPlaneProjection(strongData(12));
  assert.deepEqual(projection.tabs.TODAY.map(row=>row.Rank),[1,2,3,4,5,6,7,8,9,10]);
  assert.deepEqual(projection.tabs.PIPELINE.map(row=>row['Pipeline Rank']),[11,12]);
  assert.deepEqual(projection.diagnostics.todayPipelineOverlap,[]);
});

test('under-target TODAY is processing, not exhausted, while qualification work exists', () => {
  const data=strongData(5);data.jobs[4].evaluation=null;
  const result=selectTodayMembership(data);
  assert.equal(result.outcome,TODAY_REFILL_OUTCOMES.PROCESSING);
  assert.equal(result.diagnostics.exhaustionResult,'QUALIFICATION_BACKLOG_PROCESSING');
  assert.equal(result.diagnostics.qualificationBacklog.exhausted,false);
});

test('RESEARCH is hidden as infrastructure without deleting its contract', () => {
  const requests=buildInfrastructureVisibilityRequests([{properties:{title:'RESEARCH',sheetId:9,hidden:false}}]);
  assert.deepEqual(requests,[{updateSheetProperties:{properties:{sheetId:9,hidden:true},fields:'hidden'}}]);
});

test('qualification drain advances a bounded batch and starts no expensive research', async () => {
  const candidateProvider=openCandidateKnowledge({projectRoot:process.cwd()});
  const candidates=Array.from({length:3},(_,index)=>({job:{id:`job-${index}`,jobId:`job-${index}`,observationId:`obs-${index}`,company:'Acme',title:'Senior AI Engineer',location:'Remote',description:'Build production AI platforms using JavaScript, cloud systems, APIs, and engineering leadership. '.repeat(8),sourceUrl:`https://example.test/${index}`,canonicalUrl:`https://example.test/${index}`,rawMetadata:{}},assessment:{id:`assessment-${index}`,jobId:`job-${index}`,observationId:`obs-${index}`,decision:'SHORTLIST',eligibilityStatus:'ELIGIBLE',candidateFitScore:90,opportunityScore:85,finalPriorityScore:90-index}}));
  const stored=[];
  const registry={
    listDeepEvaluationCandidates:()=>candidates,
    recordJobEvaluation:artifact=>{stored.push(artifact);return artifact;},
    getControlPlaneData:()=>({jobs:[],humanState:[],applicationExecutions:[],candidateSelection:{researchNeeds:[],reassessmentQueue:[]}}),
  };
  const result=await drainQualificationBacklog({registry,candidateProvider,clock:()=>new Date(NOW),budget:{evaluations:2,runtimeMs:120000}});
  assert.equal(result.completed,2);assert.equal(stored.length,2);assert.equal(result.expensiveResearchStarted,0);
});
