export const ARTIFACT_REQUIREMENTS = Object.freeze(['REQUIRED', 'OPTIONAL', 'NOT_NEEDED']);
export const ARTIFACT_STATUSES = Object.freeze(['READY', 'NOT_GENERATED', 'INVALID', 'SUPERSEDED', 'NOT_NEEDED']);
export const CONTACT_COMPLETION_STATUSES = Object.freeze([
  'COMPLETE_WITH_CONTACT', 'COMPLETE_NONE_VERIFIED', 'BLOCKED', 'NOT_REQUIRED',
]);

const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();

export function resolveArtifactRequirements({ recommendation, manifest = {} } = {}) {
  const apply = upper(recommendation) === 'APPLY';
  const coverStatus = upper(manifest.coverLetterStatus);
  return {
    resume: apply ? 'REQUIRED' : 'NOT_NEEDED',
    coverLetter: !apply ? 'NOT_NEEDED' : coverStatus === 'NOT_NEEDED' ? 'NOT_NEEDED' : 'REQUIRED',
  };
}

export function normalizeContactCompletion(value, { required = true } = {}) {
  if (!required) return 'NOT_REQUIRED';
  const status = upper(value);
  if (status === 'COMPLETE_WITH_CONTACT') return 'COMPLETE_WITH_CONTACT';
  if (status === 'COMPLETE_NONE_VERIFIED') return 'COMPLETE_NONE_VERIFIED';
  if (status === 'BLOCKED') return 'BLOCKED';
  return 'NOT_RUN';
}

function artifactCheck(name, requirement, status) {
  const normalized = upper(status) || 'NOT_GENERATED';
  if (requirement === 'NOT_NEEDED') return { name, requirement, status: 'NOT_NEEDED', valid: true };
  if (requirement === 'OPTIONAL') return { name, requirement, status: normalized, valid: !['INVALID', 'SUPERSEDED'].includes(normalized) };
  return { name, requirement, status: normalized, valid: normalized === 'READY' };
}

/**
 * The single authoritative preparation-readiness invariant.
 * It is intentionally pure so workers, persistence, projections, and tests all
 * use the same decision rather than reimplementing READY independently.
 */
export class ApplicationReadinessValidator {
  constructor({ contactResearchRequired = true, minimumEvidence = 1 } = {}) {
    this.contactResearchRequired = Boolean(contactResearchRequired);
    this.minimumEvidence = Math.max(0, Number(minimumEvidence) || 0);
  }

  validate({ evaluation, applicationPlan, applicationPackage, latestApplicationPackage = applicationPackage,
    artifactManifest = {}, completion = {}, blockers = [], mandatoryHumanFactsMissing = [], packageState = '' } = {}) {
    const recommendation = upper(evaluation?.recommendation);
    const applying = recommendation === 'APPLY';
    const requirements = resolveArtifactRequirements({ recommendation, manifest: artifactManifest });
    const artifacts = [
      artifactCheck('Resume', requirements.resume, artifactManifest.resumeStatus),
      artifactCheck('Cover Letter', requirements.coverLetter, artifactManifest.coverLetterStatus),
    ];
    const contactRequired = applying && this.contactResearchRequired;
    const contactCompletion = normalizeContactCompletion(completion.contactResearch, { required: contactRequired });
    const failures = [];

    if (!evaluation || upper(evaluation.status) !== 'VALID') failures.push({ code: 'EVALUATION_INVALID', reason: 'Deep evaluation is missing or invalid.' });
    if (!recommendation) failures.push({ code: 'RECOMMENDATION_MISSING', reason: 'Evaluation recommendation is missing.' });
    if (upper(applicationPlan?.status) !== 'READY' || upper(applicationPlan?.primaryPath) === 'UNKNOWN') failures.push({ code: 'APPLICATION_PATH_MISSING', reason: 'The official application path is unresolved.' });
    for (const artifact of artifacts) if (!artifact.valid) failures.push({ code: `${artifact.name.toUpperCase().replaceAll(' ', '_')}_${artifact.status}`, reason: `${artifact.name} is ${artifact.requirement} but ${artifact.status}.` });
    if (applying) {
      if (!applicationPackage || upper(applicationPackage.validationStatus) !== 'VALID') failures.push({ code: 'PACKAGE_INVALID', reason: 'A valid application package is required.' });
      if (applicationPackage && latestApplicationPackage && applicationPackage.id !== latestApplicationPackage.id) failures.push({ code: 'PACKAGE_SUPERSEDED', reason: 'The prepared package is not the current package.' });
      if (applicationPackage && artifactManifest.packageVersion && Number(artifactManifest.packageVersion) !== Number(applicationPackage.packageVersion)) failures.push({ code: 'PACKAGE_VERSION_MISMATCH', reason: 'Artifact and package versions do not match.' });
      if (packageState && !['DRAFT', 'APPROVED'].includes(upper(packageState))) failures.push({ code: 'PACKAGE_STATE_INVALID', reason: `Package state ${upper(packageState)} is not reviewable.` });
    }
    if (Number(completion.evidenceCount || 0) < this.minimumEvidence) failures.push({ code: 'EVIDENCE_THRESHOLD_NOT_MET', reason: `At least ${this.minimumEvidence} evidence item is required.` });
    if (contactRequired && !CONTACT_COMPLETION_STATUSES.includes(contactCompletion)) failures.push({ code: 'CONTACT_RESEARCH_INCOMPLETE', reason: 'Bounded Contact Intelligence has not completed.' });
    if (applying && applicationPlan?.activation && upper(applicationPlan.activation.status) !== 'ACTIVATION_READY') failures.push({ code: 'ACTIVATION_STRATEGY_INCOMPLETE', reason: 'The application/outreach activation strategy is unresolved.' });
    if ((blockers || []).filter(Boolean).length) failures.push({ code: 'PREPARATION_BLOCKED', reason: text(blockers[0]) || 'Preparation has an unresolved blocker.' });
    if ((mandatoryHumanFactsMissing || []).filter(Boolean).length) failures.push({ code: 'MANDATORY_HUMAN_FACT_MISSING', reason: text(mandatoryHumanFactsMissing[0]) || 'A mandatory human fact is missing.' });

    return {
      ready: failures.length === 0,
      status: failures.length ? 'NOT_READY' : 'READY',
      recommendation,
      requirements,
      artifacts,
      contactRequired,
      contactCompletion,
      failures,
      checkedAt: new Date().toISOString(),
    };
  }
}

export function validateApplicationReadiness(input, options) {
  return new ApplicationReadinessValidator(options).validate(input);
}
