import { hashStable } from '../acquisition/normalize.mjs';
import { APPLICATION_PACKAGE_ENGINE_VERSION, APPLICATION_PACKAGE_PROMPT_VERSION } from './contracts.mjs';
import { canonicalCvMetadata } from './cv-source.mjs';
import { selectPackageEvidence } from './evidence-context.mjs';
import { buildApplicationPackagePrompt } from './prompt.mjs';
import { validateApplicationPackage } from './validation.mjs';

function uniq(values) { return [...new Set(values.filter(Boolean))].sort(); }
function firstPerson(claim, name) {
  const value = String(claim || '').trim().replace(new RegExp(`^${String(name || 'Jorge').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:'s)?\\s+`, 'i'), 'I ');
  if (/^I\b/i.test(value)) return value;
  if (/^(Architected|Built|Designed|Developed|Delivered|Led|Implemented|Created|Deployed)\b/.test(value)) return `I ${value[0].toLowerCase()}${value.slice(1)}`;
  return `My work includes ${value.replace(/^[A-Z]/, character => character.toLowerCase())}`;
}

function deterministicPackage(evaluationArtifact, context, cv) {
  const { evaluation, jobAnalysis } = evaluationArtifact;
  const matchByRequirement = new Map((evaluationArtifact.evidenceMatches || []).map(item => [item.requirementId, item]));
  const strengths = (evaluation.strengths || []).map(item => ({ ...item, match: matchByRequirement.get(item.requirement_id) })).filter(item => item.match);
  const requirementRefs = strengths.map(item => item.requirement_id);
  const evidenceRefs = uniq(strengths.flatMap(item => item.evidence_ids || []).filter(id => context.allowedIds.includes(id)));
  const labels = strengths.map(item => item.match.requirement.label);
  const summaryText = `${cv.title || 'AI Systems Engineer'} with production experience relevant to ${labels.slice(0, 4).join(', ')}, aligned to the ${jobAnalysis.title} role at ${jobAnalysis.company}.`;
  const claims = new Map(context.entities.evidence.map(item => [item.id, item]));
  const projects = context.entities.projects.slice(0, 3).map(project => {
    const refs = uniq([project.id, ...(project.evidence_refs || [])].filter(id => context.allowedIds.includes(id)));
    const claim = (project.evidence_refs || []).map(id => claims.get(id)).find(Boolean);
    return {
      project_id: project.id, name: project.name, evidence_refs: refs,
      emphasis: { text: claim?.claim || `${project.name}: ${project.business_problem}`, evidence_refs: refs, requirement_refs: requirementRefs, adaptation: claim ? 'DIRECT' : 'WORDING_ADAPTATION' },
    };
  });
  const projectIds = new Set(projects.map(item => item.project_id));
  const experience = context.entities.experience.filter(item => (item.project_refs || []).some(id => projectIds.has(id))).map(item => ({
    experience_id: item.id, company: item.company, role: item.role,
    project_ids: (item.project_refs || []).filter(id => projectIds.has(id)),
    evidence_refs: uniq((item.responsibility_claim_refs || []).filter(id => context.allowedIds.includes(id))),
  }));
  const skills = context.entities.skills.map(skill => ({
    skill_id: skill.id, name: skill.name,
    evidence_refs: uniq([skill.id, ...(skill.evidence_refs || [])].filter(id => context.allowedIds.includes(id))),
  }));
  const keywords = strengths.map(item => ({
    term: item.match.requirement.label, requirement_id: item.requirement_id,
    evidence_refs: (item.evidence_ids || []).filter(id => context.allowedIds.includes(id)),
  }));
  const primaryProject = projects[0];
  const primaryClaim = primaryProject?.emphasis?.text || summaryText;
  const primaryRefs = primaryProject?.evidence_refs || evidenceRefs;
  const proofClaims = projects.slice(0, 3).map(project => firstPerson(project.emphasis.text, cv.name));
  const paragraphs = [
    { purpose: 'why_role_company', text: `The ${jobAnalysis.title} role at ${jobAnalysis.company} stands out for its emphasis on ${labels.slice(0, 3).join(', ')} and for the opportunity to connect customer needs with sound technical decisions. That combination closely matches the kind of production systems I have been building: rigorous platforms that connect architecture, data, automation, and day-to-day business outcomes. I am especially drawn to work where solution design must be both technically credible and clear to business stakeholders.`, evidence_refs: [], requirement_refs: requirementRefs.slice(0, 3), adaptation: 'JOB_CONTEXT' },
    { purpose: 'relevant_experience', text: `${proofClaims[0] || firstPerson(primaryClaim, cv.name)}${proofClaims[1] ? ` ${proofClaims[1]}` : ''} Across that work, I have focused on reliable delivery, clear operating constraints, and systems that remain maintainable after launch.`, evidence_refs: uniq(projects.slice(0, 2).flatMap(project => project.evidence_refs)), requirement_refs: requirementRefs, adaptation: 'WORDING_ADAPTATION' },
    { purpose: 'why_candidate', text: `${proofClaims[2] || 'I bring a practical combination of software engineering, data engineering, and systems thinking.'} This background would let me contribute to ${jobAnalysis.company} while working credibly across technical and business stakeholders, especially where ${labels.slice(0, 3).join(', ')} must translate into dependable execution. I am comfortable moving from discovery and architecture discussions into implementation details, trade-offs, validation, and an operating model that teams can sustain.`, evidence_refs: proofClaims[2] ? projects[2].evidence_refs : evidenceRefs, requirement_refs: requirementRefs, adaptation: 'WORDING_ADAPTATION' },
    { purpose: 'closing', text: `I would welcome the opportunity to discuss the team’s priorities and how my experience could support the ${jobAnalysis.title} role. Thank you for considering my application.`, evidence_refs: [], requirement_refs: requirementRefs, adaptation: 'JOB_CONTEXT' },
  ];
  const evidencePhrase = labels.slice(0, 3).join(', ');
  const outreach = [
    { type: 'RECRUITER_MESSAGE', subject: '', content: `Hello — I am interested in the ${jobAnalysis.title} role at ${jobAnalysis.company}. My background includes ${evidencePhrase}, with evidence across ${projects.slice(0, 2).map(item => item.name).join(' and ')}. I would be glad to share more context.`, evidence_refs: evidenceRefs, requirement_refs: requirementRefs },
    { type: 'HIRING_MANAGER_MESSAGE', subject: '', content: `Hello — the ${jobAnalysis.title} opening at ${jobAnalysis.company} stood out because of its focus on ${evidencePhrase}. I have worked on ${projects.map(item => item.name).join(', ')}, and would value a technical conversation about the role's architecture and operating constraints.`, evidence_refs: evidenceRefs, requirement_refs: requirementRefs },
    { type: 'EMAIL_INTRODUCTION', subject: `${jobAnalysis.title} — ${cv.name || 'Application'} — ${jobAnalysis.company}`, content: `Hello,\n\nI am writing regarding the ${jobAnalysis.title} position at ${jobAnalysis.company}. My relevant background includes ${evidencePhrase}, supported by work on ${projects.map(item => item.name).join(', ')}. I have prepared application materials for human review and would welcome the opportunity to discuss the role.\n\nBest,\n${cv.name || ''}`.trim(), evidence_refs: evidenceRefs, requirement_refs: requirementRefs },
  ];
  const sourced = (text, refs = evidenceRefs, reqs = requirementRefs, adaptation = 'WORDING_ADAPTATION') => ({ text, evidence_refs: refs, requirement_refs: reqs, adaptation });
  const gaps = (evaluation.gaps || []).map(item => sourced(item.recommendation, [], [item.requirement_id], 'JOB_CONTEXT'));
  return {
    resume_variant: {
      summary: sourced(summaryText), highlighted_skills: skills, selected_projects: projects,
      experience_emphasis: experience, keywords,
      changes_from_base: [
        { section: 'Professional Summary', change: 'Reframe the canonical summary around the strongest evaluated requirements.', reason: `Prioritize ${labels.slice(0, 4).join(', ')}.`, evidence_refs: evidenceRefs },
        { section: 'Skills', change: 'Reorder supported skills without adding new skills.', reason: `Match the ${jobAnalysis.title} requirement order.`, evidence_refs: evidenceRefs },
        { section: 'Experience and Projects', change: 'Emphasize selected evidence-backed projects; preserve remaining canonical experience.', reason: 'Keep relevant proof near the top while retaining source history.', evidence_refs: evidenceRefs },
      ],
      evidence_refs: evidenceRefs,
    },
    cover_letter: { content: paragraphs.map(item => item.text).join('\n\n'), paragraphs, evidence_refs: evidenceRefs, tone: 'professional, specific, evidence-led' },
    outreach,
    application_notes: {
      why_apply: [sourced(`The evaluated role aligns with ${labels.slice(0, 4).join(', ')}.`, [], requirementRefs, 'JOB_CONTEXT')],
      strongest_arguments: strengths.slice(0, 4).map(item => sourced(item.summary, item.evidence_ids.filter(id => context.allowedIds.includes(id)), [item.requirement_id])),
      concerns: gaps,
      interview_focus: (evaluation.interview_focus || []).map(item => sourced(item.topic, (item.evidence_ids || []).filter(id => context.allowedIds.includes(id)), [], item.evidence_ids?.length ? 'WORDING_ADAPTATION' : 'JOB_CONTEXT')),
      questions_to_ask: gaps.map(item => sourced(`How central is ${matchByRequirement.get(item.requirement_refs[0])?.requirement.label || 'this gap'} to day-to-day success?`, [], item.requirement_refs, 'JOB_CONTEXT')),
      salary_notes: 'No new compensation claim generated; review the opportunity assessment and canonical profile manually.',
    },
  };
}

export class ApplicationPackageEngine {
  constructor({ candidateProvider, llmProvider = null, engineVersion = APPLICATION_PACKAGE_ENGINE_VERSION, promptVersion = APPLICATION_PACKAGE_PROMPT_VERSION, clock = () => new Date() } = {}) {
    if (!candidateProvider) throw new TypeError('candidateProvider is required');
    this.candidateProvider = candidateProvider; this.llmProvider = llmProvider;
    this.engineVersion = String(engineVersion); this.promptVersion = String(promptVersion); this.clock = clock;
  }

  async generate({ evaluationArtifact, canonicalCv, useLLM = Boolean(this.llmProvider) }) {
    const cv = canonicalCvMetadata(canonicalCv);
    const context = selectPackageEvidence(evaluationArtifact, this.candidateProvider);
    const candidateMetadata = this.candidateProvider.getMetadata();
    const prompt = buildApplicationPackagePrompt({ evaluationArtifact, evidenceContext: context, cvMetadata: cv });
    let generation = null;
    let output = deterministicPackage(evaluationArtifact, context, cv);
    if (useLLM) {
      if (!this.llmProvider) throw new Error('useLLM requires a structured generation provider');
      generation = await this.llmProvider.generateStructured({ ...prompt, name: 'career_ops_application_package' });
      output = generation.data;
    }
    const validation = validateApplicationPackage(output, { evaluationArtifact, evidenceContext: context, canonicalCv });
    const providerId = useLLM ? this.llmProvider.id : 'deterministic';
    const model = useLLM ? this.llmProvider.model : 'none';
    const evaluationHash = hashStable(JSON.stringify({ jobAnalysis: evaluationArtifact.jobAnalysis, evaluation: evaluationArtifact.evaluation, evidenceMatches: evaluationArtifact.evidenceMatches }));
    const identity = {
      jobId: evaluationArtifact.jobId, evaluationId: evaluationArtifact.id || null,
      evaluationKey: evaluationArtifact.evaluationKey, evaluationHash,
      candidateKbHash: candidateMetadata.hash, cvHash: cv.hash,
      engineVersion: this.engineVersion, promptVersion: this.promptVersion, providerId, model,
    };
    return {
      artifactVersion: 1, packageKey: hashStable(JSON.stringify(identity)),
      jobId: evaluationArtifact.jobId, evaluationId: evaluationArtifact.id || null,
      status: validation.valid ? 'DRAFT' : 'REVIEW_REQUIRED', validationStatus: validation.valid ? 'VALID' : 'REJECTED',
      artifacts: validation.valid ? output : null, rejectedOutput: validation.valid ? null : output, validation,
      evidenceUsed: context.allowedIds,
      provenance: {
        evaluationKey: evaluationArtifact.evaluationKey, evaluationHash,
        candidateKbVersion: candidateMetadata.version, candidateKbHash: candidateMetadata.hash, candidateKbRevision: candidateMetadata.revision,
        cvHash: cv.hash, cvSource: cv.source, engineVersion: this.engineVersion, promptVersion: this.promptVersion,
        providerId, model, responseId: generation?.responseId || null, usage: generation?.usage || null,
      },
      generatedAt: this.clock().toISOString(),
    };
  }
}
