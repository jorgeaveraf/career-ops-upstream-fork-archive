import { hashStable } from '../acquisition/normalize.mjs';
import { ApplicationPackageEngine } from '../application-package/engine.mjs';
import { ContactIntelligenceEngine } from '../contact-intelligence/engine.mjs';
import { DeepEvaluationEngine } from '../deep-evaluation/engine.mjs';
import { ApplicationArtifactWriter } from './artifact-writer.mjs';
import { buildApplicationResearchPlan } from './planner.mjs';
import { buildContactPlan, discoverApplicationPath } from './plans.mjs';
import { BoundedApplicationResearchProvider, ResearchContactProvider } from './research-provider.mjs';
import { buildEnrichmentCompletion } from './completion.mjs';
import { validateApplicationReadiness } from './readiness.mjs';
import { buildApplicationActivationPlan } from '../application-activation/planner.mjs';
import { inspectProductionOutreachTransports } from '../outreach-execution/production-executors.mjs';

const clean = value => String(value || '').trim();
function observation(row) {
  return row ? { id: row.id, externalId: row.external_id || '', description: row.description || '', sourceUrl: row.source_url || '', canonicalUrl: row.canonical_url || '', lastObservedAt: row.last_observed_at || row.retrieved_at || '' } : null;
}
function jobInput(row, latestObservation) {
  return { id: row.id, jobId: row.id, externalId: latestObservation?.externalId || '', title: row.canonical_title, company: row.canonical_company, location: row.location || '', url: row.canonical_url || latestObservation?.canonicalUrl || latestObservation?.sourceUrl || '', canonicalUrl: row.canonical_url || latestObservation?.canonicalUrl || '', sourceUrl: latestObservation?.sourceUrl || '' };
}
function outcomeRefs({ evaluation, packageRecord, contactResearch, manifest }) { return [evaluation?.id, packageRecord?.id, contactResearch?.id, ...Object.values(manifest?.files || {}).map(item => item.path)].filter(Boolean); }

export class ApplicationEnrichmentWorker {
  constructor({ registry, candidateProvider, canonicalCv, researchProvider = null, artifactWriter = null, llmProvider = null, packageLlmProvider = null, clock = () => new Date() } = {}) {
    if (!registry) throw new TypeError('registry is required');
    if (!candidateProvider) throw new TypeError('candidateProvider is required');
    this.registry = registry; this.candidateProvider = candidateProvider; this.canonicalCv = String(canonicalCv || '');
    this.researchProvider = researchProvider || new BoundedApplicationResearchProvider({ clock });
    this.artifactWriter = artifactWriter || new ApplicationArtifactWriter(); this.llmProvider = llmProvider;
    this.packageLlmProvider = packageLlmProvider || llmProvider; this.clock = clock;
  }

  preview({ requestId = null, jobId = null, budget = {} } = {}) {
    const request = this.registry.listEnrichmentRequests().find(item => (!requestId || item.id === requestId) && (!jobId || item.jobId === jobId) && item.status === 'PENDING');
    if (!request) return { status: 'NO_WORK', navigationStarted: false, writes: [] };
    const jobRow = this.registry.getJob(request.jobId); const obs = observation(this.registry.getObservations(request.jobId).find(item => item.id === request.sourceObservationId) || this.registry.getObservations(request.jobId).at(-1));
    const job = jobInput(jobRow, obs); return { status: 'DRY_RUN', request, plan: buildApplicationResearchPlan({ request, job, observation: obs, budget }), navigationStarted: false, writes: [] };
  }

  async processNext({ runId, requestId = null, jobId = null, budget = {}, useLLM = false, onClaimed = null, onTerminal = null } = {}) {
    const claimed = this.registry.claimNextEnrichmentRequest({ runId, requestId, jobId });
    if (!claimed) return { status: 'NO_WORK', processed: 0 };
    await onClaimed?.(claimed);
    const requestIdValue = claimed.id;
    try {
      const jobRow = this.registry.getJob(claimed.jobId); const rows = this.registry.getObservations(claimed.jobId);
      const obs = observation(rows.find(item => item.id === claimed.sourceObservationId) || rows.at(-1)); const job = jobInput(jobRow, obs);
      const selected = this.registry.listDeepEvaluationCandidates({ jobId: claimed.jobId, limit: 1 })[0];
      if (!selected) return this.block(requestIdValue, runId, 'INSUFFICIENT_EVIDENCE', 'latest assessment is not SHORTLIST');
      const plan = buildApplicationResearchPlan({ request: claimed, job, observation: obs, budget });
      this.registry.updateEnrichmentRequestData(requestIdValue, { researchPlan: plan });
      const research = await this.researchProvider.research({ request: claimed, job, observation: obs, plan });
      research.contacts = (research.contacts || []).slice(0, plan.budget.maxContactCandidates);
      const persistedEvidence = this.registry.recordApplicationEnrichmentEvidence(requestIdValue, research.evidence || []);
      this.registry.updateEnrichmentRequestData(requestIdValue, { researchReport: research.report });
      if (research.status === 'BLOCKED') { const completion=buildEnrichmentCompletion({report:{...research.report,contactResearchBlocked:true},evidence:persistedEvidence,finishedAt:this.clock().toISOString()});this.registry.updateEnrichmentRequestData(requestIdValue,{enrichmentCompletion:completion});return this.block(requestIdValue, runId, research.failureCode || 'RESEARCH_BLOCKED', 'research source blocked', persistedEvidence.map(item => item.id)); }
      if (research.status === 'INSUFFICIENT_EVIDENCE') { const completion=buildEnrichmentCompletion({report:research.report,evidence:persistedEvidence,finishedAt:this.clock().toISOString()});this.registry.updateEnrichmentRequestData(requestIdValue,{enrichmentCompletion:completion});return this.block(requestIdValue, runId, 'INSUFFICIENT_EVIDENCE', 'research produced insufficient evidence', persistedEvidence.map(item => item.id)); }
      if (this.registry.getEnrichmentRequest(requestIdValue)?.status === 'CANCELLED') return { status: 'CANCELLED', requestId: requestIdValue, processed: 1 };

      const description = [...persistedEvidence].reverse().find(item => item.normalizedField === 'description' && item.identityStatus === 'CONFIRMED')?.value;
      const evaluationJob = { ...selected.job, description: clean(description) || selected.job.description };
      const inputHash = hashStable(JSON.stringify({ observationId: selected.job.observationId, description: evaluationJob.description, evidence: persistedEvidence.map(item => item.rawHash).sort(), candidateKbHash: this.candidateProvider.getMetadata().hash, assessmentId: selected.assessment.id }));
      this.registry.updateEnrichmentRequestData(requestIdValue, { inputHash });
      this.registry.transitionEnrichmentRequest(requestIdValue, 'EVALUATING', { reason: 'research_complete', runId, evidenceRefs: persistedEvidence.map(item => item.id) });
      const evaluationArtifact = await new DeepEvaluationEngine({ candidateProvider: this.candidateProvider, llmProvider: this.llmProvider, clock: this.clock }).evaluate({ job: evaluationJob, assessment: selected.assessment, useLLM });
      const evaluation = this.registry.recordJobEvaluation(evaluationArtifact);
      const applicationPlan = discoverApplicationPath({ job, evidence: persistedEvidence });
      if (evaluation.status !== 'VALID') return this.block(requestIdValue, runId, 'LLM_FAILED', 'deep evaluation failed validation', persistedEvidence.map(item => item.id));
      if (evaluation.recommendation !== 'APPLY') {
        const contactPlan = buildContactPlan(); const manifest = this.artifactWriter.write({ job, canonicalCv: this.canonicalCv, applicationPlan, contactPlan, researchReport: research.report, coverLetterRequired: false });
        const refs = outcomeRefs({ evaluation, manifest });
        const completion=buildEnrichmentCompletion({report:research.report,evidence:persistedEvidence,applicationPlan,finishedAt:this.clock().toISOString()});
        this.registry.updateEnrichmentRequestData(requestIdValue, { evaluationId: evaluation.id, packageState: 'NOT_GENERATED', applicationPlan, contactPlan, enrichmentCompletion:completion, artifactManifest: manifest, outputRefs: refs });
        const readiness=validateApplicationReadiness({evaluation,applicationPlan,artifactManifest:manifest,completion,packageState:'NOT_GENERATED'});
        if(!readiness.ready)return this.block(requestIdValue,runId,readiness.failures[0].code,readiness.failures[0].reason,persistedEvidence.map(item=>item.id));
        const ready = this.registry.transitionEnrichmentRequest(requestIdValue, 'READY_FOR_REVIEW', { reason: `evaluation_${evaluation.recommendation.toLowerCase()}`, runId, evidenceRefs: persistedEvidence.map(item => item.id), outputRefs: refs });
        const result={ status: ready.status, requestId: requestIdValue, recommendation: evaluation.recommendation, packageGenerated: false, processed: 1 };await onTerminal?.(result);return result;
      }

      if (this.registry.getEnrichmentRequest(requestIdValue)?.status === 'CANCELLED') return { status: 'CANCELLED', requestId: requestIdValue, processed: 1 };
      this.registry.transitionEnrichmentRequest(requestIdValue, 'GENERATING_PACKAGE', { reason: 'evaluation_apply', runId, evidenceRefs: persistedEvidence.map(item => item.id), outputRefs: [evaluation.id] });
      const packageArtifact = await new ApplicationPackageEngine({ candidateProvider: this.candidateProvider, llmProvider: this.packageLlmProvider, clock: this.clock }).generate({ evaluationArtifact: { ...evaluation, evaluationKey: evaluation.evaluationKey }, canonicalCv: this.canonicalCv, useLLM });
      const packageRecord = this.registry.recordApplicationPackage(packageArtifact);
      if (packageRecord.validationStatus !== 'VALID') return this.block(requestIdValue, runId, 'PACKAGE_FAILED', 'application package failed evidence validation', persistedEvidence.map(item => item.id));
      const contactArtifact = await new ContactIntelligenceEngine({ provider: new ResearchContactProvider({ researchResult: research }), clock: this.clock }).research({ job: { ...job, id: job.id }, observation: obs, applicationPackage: packageRecord });
      const contactResearch = this.registry.recordContactResearch(contactArtifact);
      const contactPlan = buildContactPlan({ contactResearch, packageArtifact: packageRecord });
      const transports=inspectProductionOutreachTransports();const activationPlan = buildApplicationActivationPlan({ job, evaluation, applicationPath: applicationPlan, packageRecord, contactIntelligence: contactResearch, companyResearch: research.report?.company || {}, hiringResearch: research.report?.hiring || {}, sourceProvenance: { evidenceIds: persistedEvidence.map(item => item.id) }, candidatePreferences: this.candidateProvider.getMetadata?.() || {}, channelCapabilities: { emailOutreachConfigured: transports.gmail.status==='READY', linkedinExactMessaging: transports.linkedin.status==='READY', platformMessage: false } }, { clock: this.clock });
      const activatedApplicationPlan = { ...applicationPlan, activation: activationPlan };
      const manifest = this.artifactWriter.write({ job, packageRecord, canonicalCv: this.canonicalCv, applicationPlan: activatedApplicationPlan, contactPlan, activationPlan, researchReport: research.report, coverLetterRequired: research.coverLetterRequired !== false });
      const refs = outcomeRefs({ evaluation, packageRecord, contactResearch, manifest });
      const completion=buildEnrichmentCompletion({report:research.report,evidence:persistedEvidence,contactResearch,applicationPlan,finishedAt:this.clock().toISOString()});
      this.registry.updateEnrichmentRequestData(requestIdValue, { evaluationId: evaluation.id, packageId: packageRecord.id, contactResearchId: contactResearch.id, packageState: packageRecord.status, applicationPlan: activatedApplicationPlan, contactPlan, enrichmentCompletion:completion, artifactManifest: manifest, outputRefs: refs });
      const readiness=validateApplicationReadiness({evaluation,applicationPlan:activatedApplicationPlan,applicationPackage:packageRecord,latestApplicationPackage:packageRecord,artifactManifest:manifest,completion,packageState:packageRecord.status});
      if(!readiness.ready)return this.block(requestIdValue,runId,readiness.failures[0].code,readiness.failures[0].reason,persistedEvidence.map(item=>item.id));
      const ready = this.registry.transitionEnrichmentRequest(requestIdValue, 'READY_FOR_REVIEW', { reason: 'package_ready_for_human_review', runId, evidenceRefs: persistedEvidence.map(item => item.id), outputRefs: refs });
      const result={ status: ready.status, requestId: requestIdValue, recommendation: evaluation.recommendation, evaluationId: evaluation.id, packageId: packageRecord.id, contactResearchId: contactResearch.id, manifest, applicationPlan:activatedApplicationPlan, contactPlan, activationPlan, packageGenerated: true, processed: 1 };await onTerminal?.(result);return result;
    } catch (error) {
      const request = this.registry.getEnrichmentRequest(requestIdValue);
      if (request && !['READY_FOR_REVIEW','BLOCKED','FAILED','CANCELLED'].includes(request.status)) this.registry.transitionEnrichmentRequest(requestIdValue, 'FAILED', { reason: error.message, runId, errorCode: error.code || (/LLM/i.test(error.message) ? 'LLM_FAILED' : 'PACKAGE_FAILED') });
      const result={ status: 'FAILED', requestId: requestIdValue, error: { code: error.code || 'APPLICATION_ENRICHMENT_FAILED', message: error.message }, processed: 1 };await onTerminal?.(result);return result;
    }
  }

  block(requestId, runId, code, reason, evidenceRefs = []) {
    const row = this.registry.transitionEnrichmentRequest(requestId, 'BLOCKED', { reason, runId, errorCode: code, evidenceRefs });
    return { status: row.status, requestId, failureCode: code, processed: 1 };
  }
}
