import { readFileSync } from 'fs';
import { ApplicationArtifactWriter } from '../application-enrichment/artifact-writer.mjs';
import { buildEnrichmentCompletion } from '../application-enrichment/completion.mjs';
import { buildContactPlan } from '../application-enrichment/plans.mjs';
import { ResearchContactProvider } from '../application-enrichment/research-provider.mjs';
import { validateApplicationReadiness } from '../application-enrichment/readiness.mjs';
import { ContactIntelligenceEngine } from '../contact-intelligence/engine.mjs';
import { buildApplicationActivationPlan } from './planner.mjs';
import { inspectProductionOutreachTransports } from '../outreach-execution/production-executors.mjs';

function jobInput(job, observation) { return { id: job.id, jobId: job.id, title: job.canonical_title, company: job.canonical_company, location: job.location || '', url: job.canonical_url || observation?.canonical_url || observation?.source_url || '', canonicalUrl: job.canonical_url || observation?.canonical_url || '', sourceUrl: observation?.source_url || '' }; }
function observationInput(row, job) { return row ? { id:row.id,company:job.canonical_company,sourceUrl:row.source_url,canonicalUrl:row.canonical_url,contentHash:row.content_hash,snapshotHash:row.snapshot_hash,retrievedAt:row.last_observed_at } : null; }

export async function reconcileApplicationActivation({ registry, jobIds = null, canonicalCv = null, artifactWriter = null, clock = () => new Date() } = {}) {
  if (!registry) throw new TypeError('registry is required');
  const ids = jobIds ? new Set(jobIds) : null;
  const requests = registry.listEnrichmentRequests({ status: 'READY_FOR_REVIEW' }).filter(request => !ids || ids.has(request.jobId));
  const results = [];
  for (const request of requests) {
    const evaluation = registry.getLatestJobEvaluation(request.jobId);
    if (evaluation?.recommendation !== 'APPLY') { results.push({ jobId:request.jobId,status:'SKIPPED_NON_APPLY' }); continue; }
    const jobRow=registry.getJob(request.jobId),observation=registry.getObservations(request.jobId).at(-1),job=jobInput(jobRow,observation),packageRecord=registry.getLatestApplicationPackage(request.jobId);
    let contactResearch=registry.getLatestContactResearch(request.jobId);
    if (!['COMPLETE_WITH_CONTACT','COMPLETE_NONE_VERIFIED','BLOCKED'].includes(String(contactResearch?.completionStatus||''))) {
      const provider=new ResearchContactProvider({researchResult:{report:request.researchReport,contacts:[]},id:'v4-3-legacy-reconciliation',version:'2.0'});
      const artifact=await new ContactIntelligenceEngine({provider,clock}).research({job,observation:observationInput(observation,jobRow),applicationPackage:packageRecord});
      if (!['COMPLETE_WITH_CONTACT','COMPLETE_NONE_VERIFIED','BLOCKED'].includes(artifact.completionStatus)) { results.push({jobId:request.jobId,status:'BLOCKED',reason:'legacy contact research did not reach a terminal bounded result'});continue; }
      contactResearch=registry.recordContactResearch(artifact);
    }
    const contactPlan=buildContactPlan({contactResearch,packageArtifact:packageRecord});
    const transports=inspectProductionOutreachTransports();const activation=buildApplicationActivationPlan({job,evaluation,applicationPath:request.applicationPlan,packageRecord,contactIntelligence:contactResearch,companyResearch:request.researchReport?.company||{},hiringResearch:request.researchReport?.hiring||{},sourceProvenance:{enrichmentRequestId:request.id},candidatePreferences:{source:'candidate-kb'},channelCapabilities:{emailOutreachConfigured:transports.gmail.status==='READY',linkedinExactMessaging:transports.linkedin.status==='READY',platformMessage:false}},{clock});
    const applicationPlan={...request.applicationPlan,activation};
    const cv=canonicalCv??readFileSync('cv.md','utf8'),writer=artifactWriter||new ApplicationArtifactWriter();
    const manifest=writer.write({job,packageRecord,canonicalCv:cv,applicationPlan,contactPlan,activationPlan:activation,researchReport:request.researchReport,coverLetterRequired:request.artifactManifest?.coverLetterStatus!=='NOT_NEEDED'});
    const evidence=registry.getApplicationEnrichmentEvidence(request.id);
    const completion=buildEnrichmentCompletion({report:request.researchReport,evidence,contactResearch,applicationPlan,finishedAt:clock().toISOString()});
    registry.updateEnrichmentRequestData(request.id,{evaluationId:evaluation.id,packageId:packageRecord.id,contactResearchId:contactResearch.id,packageState:packageRecord.status,applicationPlan,contactPlan,enrichmentCompletion:completion,artifactManifest:manifest,outputRefs:[evaluation.id,packageRecord.id,contactResearch.id,...Object.values(manifest.files||{}).map(file=>file.path)]});
    const readiness=validateApplicationReadiness({evaluation,applicationPlan,applicationPackage:packageRecord,latestApplicationPackage:packageRecord,artifactManifest:manifest,completion,packageState:packageRecord.status});
    results.push({jobId:request.jobId,company:job.company,status:readiness.ready?'ACTIVATION_READY':'BLOCKED',outreachStrategy:activation.outreachStrategy,channel:activation.outreachPlan.channel,timing:activation.timing,primaryContact:activation.primaryContact,readinessFailures:readiness.failures,artifact:manifest.files?.['outreach-plan.json']?.path||null});
  }
  return { processed:results.length, results };
}
