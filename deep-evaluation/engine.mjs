import { hashStable } from '../acquisition/normalize.mjs';
import { DEEP_EVALUATION_ENGINE_VERSION, DEEP_EVALUATION_PROMPT_VERSION } from './contracts.mjs';
import { analyzeJob } from './job-analysis.mjs';
import { matchCandidateEvidence } from './evidence-matcher.mjs';
import { buildEvaluationPrompt } from './prompt.mjs';
import { validateEvaluationOutput } from './validation.mjs';

function decision(assessment) { return assessment?.decision || assessment?.finalPriority?.decision || assessment?.result?.finalPriority?.decision; }
function uniq(values) { return [...new Set(values)].sort(); }

function deterministicEvaluation(matches) {
  const points = { STRONG_MATCH: 100, PARTIAL_MATCH: 55, TRANSFERABLE_EXPERIENCE: 45, NO_EVIDENCE: 0, CONFLICTING_EVIDENCE: 0 };
  const weights = matches.map(item => item.requirement.importance === 'high' ? 2 : 1);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const fit = Math.round(matches.reduce((sum, item, index) => sum + points[item.status] * weights[index], 0) / totalWeight);
  const hardGaps = matches.filter(item => item.requirement.priority === 'must_have' && ['NO_EVIDENCE', 'CONFLICTING_EVIDENCE'].includes(item.status));
  const recommendation = hardGaps.length ? 'DO_NOT_APPLY' : fit >= 70 ? 'APPLY' : fit >= 45 ? 'CONSIDER' : 'DO_NOT_APPLY';
  const strong = matches.filter(item => item.status === 'STRONG_MATCH');
  const gaps = matches.filter(item => item.gap);
  return {
    recommendation, confidence: matches.length ? 'MEDIUM' : 'LOW', overall_fit: fit,
    summary: `Deterministic evidence coverage: ${strong.length} strong of ${matches.length} extracted requirements.`,
    strengths: strong.map(item => ({ requirement_id: item.requirementId, evidence_ids: item.evidenceIds.filter(id => !id.startsWith('gap.')), summary: `Approved evidence supports ${item.requirement.label}.` })),
    evidence_used: uniq(strong.flatMap(item => item.evidenceIds).filter(id => !id.startsWith('gap.'))),
    gaps: gaps.map(item => ({ requirement_id: item.requirementId, gap_ids: item.gap.gapIds, status: item.gap.kind, recommendation: item.gap.explanation })),
    positioning: {
      emphasize: strong.map(item => ({ text: item.requirement.label, evidence_ids: item.evidenceIds.filter(id => !id.startsWith('gap.')) })),
      avoid: gaps.map(item => `Do not overstate ${item.requirement.label}.`),
    },
    interview_focus: gaps.map(item => ({ topic: item.requirement.label, evidence_ids: item.evidenceIds })),
    risks: hardGaps.map(item => ({ text: `Must-have has no approved evidence: ${item.requirement.label}.`, requirement_ids: [item.requirementId], evidence_ids: item.evidenceIds })),
  };
}

export class DeepEvaluationEngine {
  constructor({
    candidateProvider, llmProvider = null, engineVersion = DEEP_EVALUATION_ENGINE_VERSION,
    promptVersion = DEEP_EVALUATION_PROMPT_VERSION, clock = () => new Date(),
  } = {}) {
    if (!candidateProvider) throw new TypeError('candidateProvider is required');
    this.candidateProvider = candidateProvider;
    this.llmProvider = llmProvider;
    this.engineVersion = String(engineVersion);
    this.promptVersion = String(promptVersion);
    this.clock = clock;
  }

  async evaluate({ job, assessment, useLLM = Boolean(this.llmProvider) }) {
    if (decision(assessment) !== 'SHORTLIST') {
      const error = new Error('Deep evaluation is allowed only for SHORTLIST opportunities');
      error.code = 'DEEP_EVALUATION_NOT_SHORTLISTED';
      throw error;
    }
    const candidateMetadata = this.candidateProvider.getMetadata();
    const jobAnalysis = analyzeJob(job);
    const evidenceMatches = matchCandidateEvidence(jobAnalysis, this.candidateProvider);
    const opportunityContext = {
      assessmentId: assessment?.id || null, decision: decision(assessment),
      eligibilityStatus: assessment?.eligibilityStatus || assessment?.eligibility?.status || assessment?.result?.eligibility?.status || null,
      candidateFitScore: assessment?.candidateFitScore ?? assessment?.candidateFit?.score ?? assessment?.result?.candidateFit?.score ?? null,
      opportunityScore: assessment?.opportunityScore ?? assessment?.opportunity?.score ?? assessment?.result?.opportunity?.score ?? null,
      finalPriorityScore: assessment?.finalPriorityScore ?? assessment?.finalPriority?.score ?? assessment?.result?.finalPriority?.score ?? null,
    };
    const prompt = buildEvaluationPrompt({ jobAnalysis, evidenceMatches, candidateMetadata, opportunityContext });
    let generation = null;
    let output = deterministicEvaluation(evidenceMatches);
    if (useLLM) {
      if (!this.llmProvider) throw new Error('useLLM requires an LLM provider');
      generation = await this.llmProvider.generateStructured({ ...prompt, name: 'career_ops_deep_evaluation' });
      output = generation.data;
    }
    const validation = validateEvaluationOutput(output, evidenceMatches);
    const providerId = useLLM ? this.llmProvider.id : 'deterministic';
    const model = useLLM ? this.llmProvider.model : 'none';
    const identityInput = {
      jobId: job.id || job.jobId || null, observationId: job.observationId || assessment?.observationId || null,
      assessmentId: assessment?.id || null, candidateKbHash: candidateMetadata.hash,
      engineVersion: this.engineVersion, promptVersion: this.promptVersion, providerId, model,
      jobAnalysisHash: jobAnalysis.hash,
    };
    const artifact = {
      artifactVersion: 1, evaluationKey: hashStable(JSON.stringify(identityInput)), status: validation.valid ? 'VALID' : 'REJECTED',
      jobId: identityInput.jobId, observationId: identityInput.observationId, assessmentId: identityInput.assessmentId,
      jobAnalysis, evidenceMatches, evaluation: validation.valid ? output : null,
      rejectedOutput: validation.valid ? null : output, validation,
      provenance: {
        candidateKbVersion: candidateMetadata.version, candidateKbHash: candidateMetadata.hash,
        candidateKbRevision: candidateMetadata.revision, engineVersion: this.engineVersion,
        promptVersion: this.promptVersion, providerId, model, jobAnalysisHash: jobAnalysis.hash,
        responseId: generation?.responseId || null, usage: generation?.usage || null,
      },
      evaluatedAt: this.clock().toISOString(),
    };
    return artifact;
  }
}
