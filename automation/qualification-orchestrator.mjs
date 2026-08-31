import { openCandidateKnowledge } from '../candidate-knowledge/provider.mjs';
import { DeepEvaluationEngine } from '../deep-evaluation/engine.mjs';
import { selectPipelineAdmission } from '../intelligence/pipeline-admission.mjs';
import { summarizeQualificationBacklog } from '../intelligence/qualification-backlog.mjs';
import { runEligibilityEvidenceRepair } from './eligibility-evidence-repair.mjs';

export const QUALIFICATION_ORCHESTRATOR_VERSION = '4.8.0';
export const DEFAULT_QUALIFICATION_BUDGET = Object.freeze({ evaluations: 100, runtimeMs: 600_000 });

/** Bounded cheap-to-expensive drain. Eligibility assessment remains in the
 * ranking stage; this stage advances only current SHORTLIST rows lacking the
 * exact deterministic evaluation artifact. Browser/LLM research is never
 * started implicitly. */
export async function drainQualificationBacklog({
  registry, projectRoot = process.cwd(), candidateProvider = null, clock = () => new Date(),
  budget = DEFAULT_QUALIFICATION_BUDGET, fullActivePass = false, reconcileResearch = true,
  eligibilityStage = runEligibilityEvidenceRepair,
} = {}) {
  if (!registry) throw new TypeError('registry is required');
  const startedAt = clock().toISOString();
  const startedMs = clock().getTime();
  const maxEvaluations = Math.max(0, Math.min(100, Number(budget.evaluations) || 0));
  const runtimeMs = Math.max(1_000, Math.min(15 * 60_000, Number(budget.runtimeMs) || 120_000));
  const provider = candidateProvider || openCandidateKnowledge({ projectRoot });
  const engine = new DeepEvaluationEngine({ candidateProvider: provider, clock });
  const eligibility = fullActivePass ? await eligibilityStage({ registry, clock }) : null;
  const researchReconciliation = reconcileResearch && typeof registry.reconcileCandidateResearchNeeds === 'function'
    ? registry.reconcileCandidateResearchNeeds({ reconciledAt: clock().toISOString() }) : null;
  const considered = [], evaluations = [];
  let existing = 0, runtimeExhausted = false;
  for (const selected of registry.listDeepEvaluationCandidates({ limit: 1000 })) {
    if (evaluations.length >= maxEvaluations) break;
    if (clock().getTime() - startedMs >= runtimeMs) { runtimeExhausted = true; break; }
    const artifact = await engine.evaluate({ ...selected, useLLM: false });
    considered.push(selected.job.id);
    const stored = registry.recordJobEvaluation(artifact);
    if (stored.existing) existing++;
    else evaluations.push(stored);
  }
  const controlPlane = registry.getControlPlaneData({ includeAttention: false });
  const strongPool = selectPipelineAdmission(controlPlane);
  const backlog = summarizeQualificationBacklog(controlPlane, strongPool, { now: clock() });
  return Object.freeze({
    version: QUALIFICATION_ORCHESTRATOR_VERSION,
    startedAt, finishedAt: clock().toISOString(),
    budget: Object.freeze({ evaluations: maxEvaluations, runtimeMs }),
    considered: considered.length, existing, completed: evaluations.length,
    apply: evaluations.filter(item => item.status === 'VALID' && item.recommendation === 'APPLY').length,
    doNotApply: evaluations.filter(item => item.status === 'VALID' && item.recommendation === 'DO_NOT_APPLY').length,
    consider: evaluations.filter(item => item.status === 'VALID' && item.recommendation === 'CONSIDER').length,
    runtimeExhausted, evaluations: Object.freeze(evaluations), strongPoolCount: strongPool.admitted.length, backlog,
    eligibility, researchReconciliation, expensiveResearchStarted: 0,
  });
}
