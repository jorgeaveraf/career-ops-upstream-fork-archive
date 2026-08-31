import { auditClaims, factClaims } from '../verify-cv-facts.mjs';
import { ADAPTATION_TYPES } from './contracts.mjs';

function arr(value) { return Array.isArray(value) ? value : []; }
function strings(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) value.forEach(item => strings(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => strings(item, result));
  return result;
}
function uniq(values) { return [...new Set(values.filter(Boolean))]; }

export function validateApplicationPackage(output, { evaluationArtifact, evidenceContext, canonicalCv }) {
  const errors = [];
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { valid: false, errors: ['output must be an object'] };
  for (const field of ['resume_variant', 'cover_letter', 'outreach', 'application_notes']) {
    if (!output[field] || typeof output[field] !== 'object') errors.push(`missing field: ${field}`);
  }
  const allowedEvidence = new Set(evidenceContext.allowedIds);
  const requirements = new Map((evaluationArtifact.jobAnalysis?.requirements || []).map(item => [item.id, item]));
  const gaps = evaluationArtifact.evidenceMatches?.filter(item => item.gap && item.status !== 'STRONG_MATCH') || [];
  const checkRefs = (value, context) => {
    for (const id of arr(value)) if (!allowedEvidence.has(id)) errors.push(`${context} references unsupported evidence: ${id}`);
  };
  const checkRequirements = (value, context) => {
    for (const id of arr(value)) if (!requirements.has(id)) errors.push(`${context} references unknown requirement: ${id}`);
  };
  const checkSourced = (item, context, { candidateFact = true } = {}) => {
    checkRefs(item?.evidence_refs, context);
    checkRequirements(item?.requirement_refs, context);
    if (candidateFact && item?.adaptation !== 'JOB_CONTEXT' && !arr(item?.evidence_refs).length) errors.push(`${context} requires candidate evidence`);
    if (!ADAPTATION_TYPES.includes(item?.adaptation)) errors.push(`${context} has invalid adaptation type`);
  };

  const resume = output.resume_variant || {};
  checkSourced(resume.summary, 'resume summary');
  checkRefs(resume.evidence_refs, 'resume');
  const skillIds = new Set(evidenceContext.entities.skills.map(item => item.id));
  for (const skill of arr(resume.highlighted_skills)) {
    if (!skillIds.has(skill?.skill_id)) errors.push(`resume references unsupported skill: ${skill?.skill_id}`);
    checkRefs(skill?.evidence_refs, `skill ${skill?.skill_id}`);
  }
  const projectIds = new Set(evidenceContext.entities.projects.map(item => item.id));
  for (const project of arr(resume.selected_projects)) {
    if (!projectIds.has(project?.project_id)) errors.push(`resume references unsupported project: ${project?.project_id}`);
    checkRefs(project?.evidence_refs, `project ${project?.project_id}`);
    checkSourced(project?.emphasis, `project emphasis ${project?.project_id}`);
  }
  const experienceIds = new Set(evidenceContext.entities.experience.map(item => item.id));
  for (const experience of arr(resume.experience_emphasis)) {
    if (!experienceIds.has(experience?.experience_id)) errors.push(`resume references unsupported experience: ${experience?.experience_id}`);
    checkRefs(experience?.evidence_refs, `experience ${experience?.experience_id}`);
    for (const id of arr(experience?.project_ids)) if (!projectIds.has(id)) errors.push(`experience references unsupported project: ${id}`);
  }
  for (const keyword of arr(resume.keywords)) {
    checkRequirements([keyword?.requirement_id], `keyword ${keyword?.term}`);
    checkRefs(keyword?.evidence_refs, `keyword ${keyword?.term}`);
  }
  for (const change of arr(resume.changes_from_base)) checkRefs(change?.evidence_refs, `resume change ${change?.section}`);

  const cover = output.cover_letter || {};
  for (const [index, paragraph] of arr(cover.paragraphs).entries()) checkSourced(paragraph, `cover paragraph ${index + 1}`, { candidateFact: paragraph?.adaptation !== 'JOB_CONTEXT' });
  checkRefs(cover.evidence_refs, 'cover letter');
  const composedCover = arr(cover.paragraphs).map(item => item.text).join('\n\n');
  if (cover.content !== composedCover) errors.push('cover letter content must be composed exactly from its sourced paragraphs');
  const coverWords = composedCover.trim().split(/\s+/).filter(Boolean).length;
  if (coverWords < 120 || coverWords > 320) errors.push(`cover letter must be 120-320 words; observed ${coverWords}`);
  if (!/\b(?:I|my|me)\b/i.test(composedCover)) errors.push('cover letter must use first person');
  const candidateName = canonicalCv.match(/^#\s+(.+)$/m)?.[1] || 'Jorge Vera';
  if (new RegExp(`${candidateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:brings|has|is)\\b`, 'i').test(composedCover)) errors.push('cover letter must not use third-person self-reference');
  if (/evidence-backed|canonical evidence|candidate knowledge|unchanged source/i.test(composedCover)) errors.push('cover letter exposes internal Career Ops terminology');

  const expectedOutreach = new Set(['RECRUITER_MESSAGE', 'HIRING_MANAGER_MESSAGE', 'EMAIL_INTRODUCTION']);
  for (const draft of arr(output.outreach)) {
    expectedOutreach.delete(draft?.type);
    checkRefs(draft?.evidence_refs, `outreach ${draft?.type}`);
    checkRequirements(draft?.requirement_refs, `outreach ${draft?.type}`);
    if (!arr(draft?.evidence_refs).length) errors.push(`outreach ${draft?.type} requires candidate evidence`);
    const personalized = `${draft?.subject || ''} ${draft?.content || ''}`;
    if (!personalized.includes(evaluationArtifact.jobAnalysis.title) || !personalized.includes(evaluationArtifact.jobAnalysis.company)) {
      errors.push(`outreach ${draft?.type} is not personalized to role and company`);
    }
  }
  if (expectedOutreach.size) errors.push(`missing outreach types: ${[...expectedOutreach].join(', ')}`);

  const notes = output.application_notes || {};
  for (const field of ['why_apply', 'strongest_arguments', 'concerns', 'interview_focus', 'questions_to_ask']) {
    for (const [index, item] of arr(notes[field]).entries()) checkSourced(item, `application_notes.${field}[${index}]`, { candidateFact: !['concerns', 'questions_to_ask'].includes(field) });
  }

  const sourceText = [canonicalCv, ...evidenceContext.entities.evidence.map(item => item.claim), JSON.stringify(evidenceContext.entities)].join('\n');
  const factAudit = auditClaims(strings(output).join('\n'), sourceText);
  for (const claim of factAudit.invented) errors.push(`output invents unsupported metric: ${claim}`);
  const allowedFacts = new Set(factClaims(sourceText).map(item => `${item.kind}:${item.value}`));
  for (const fact of factClaims(strings(output).join('\n'))) {
    if (!allowedFacts.has(`${fact.kind}:${fact.value}`)) errors.push(`output invents unsupported ${fact.kind}: ${fact.value}`);
  }
  const outputText = strings(output).join(' ');
  if (/\b(?:world[- ]class|unrivaled|best[- ]in[- ]class)\b/i.test(outputText)) errors.push('output contains unsupported superlative positioning');
  if (/\b(?:expert|expertise|mastery)\b/i.test(outputText)) errors.push('output contains unsupported expertise positioning');
  for (const match of gaps) {
    const topic = match.requirement?.label || '';
    if (!topic) continue;
    const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const positive = new RegExp(`(?:expert|proficient|extensive|production experience|strong).*${escaped}|${escaped}.*(?:expert|proficient|extensive|production experience|strong)`, 'i');
    if (positive.test(outputText)) errors.push(`output overstates known gap: ${match.requirementId}`);
  }
  return { valid: errors.length === 0, errors: uniq(errors), factAudit };
}
