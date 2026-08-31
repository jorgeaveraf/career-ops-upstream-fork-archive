const TRANSFER = Object.freeze({ kubernetes: ['docker', 'containerized deployments', 'cloud-native architecture'] });

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function text(item) { return normalized(Object.values(item || {}).flat(Infinity).join(' ')); }
function uniq(values) { return [...new Set(values.filter(Boolean))].sort(); }
function containsConcept(haystack, concept) {
  const value = normalized(haystack);
  const terms = normalized(concept).split(' ').filter(term => term.length > 2);
  return terms.length > 0 && terms.every(term => value.includes(term));
}
function gapKind(status) {
  return ({ PARTIAL: 'weak', DEVELOPING: 'developing', CONFIRMED_ABSENCE: 'confirmed_absence', UNKNOWN: 'missing' })[status] || 'missing';
}

export function matchCandidateEvidence(jobAnalysis, candidateProvider) {
  const snapshot = candidateProvider.getSnapshot();
  const allGaps = snapshot.gaps || [];
  return jobAnalysis.requirements.map(requirement => {
    const direct = candidateProvider.findEvidence(requirement.label);
    let status = direct.status === 'CONFIRMED' ? 'STRONG_MATCH' : 'NO_EVIDENCE';
    let projects = direct.projects || [];
    let skills = direct.skill ? [direct.skill] : [];
    let evidence = direct.evidence || [];
    let stories = direct.stories || [];
    let gaps = direct.gaps || allGaps.filter(gap => normalized(gap.topic).includes(normalized(requirement.label)));
    let note = direct.explanation;

    if (status === 'NO_EVIDENCE') {
      const needle = normalized(requirement.label);
      const broadProjects = snapshot.projects.filter(project => text(project).includes(needle) || containsConcept(text(project), needle));
      if (broadProjects.length) {
        projects = broadProjects;
        const claimIds = uniq(broadProjects.flatMap(project => project.evidence_refs || []));
        evidence = snapshot.evidence.filter(claim => claimIds.includes(claim.id));
        stories = snapshot.stories.filter(story => broadProjects.some(project => (project.story_refs || []).includes(story.id)));
        status = evidence.some(claim => claim.status === 'CONFIRMED') ? 'STRONG_MATCH' : 'PARTIAL_MATCH';
        note = 'The requirement is supported through approved project evidence.';
      }
    }

    if (status === 'NO_EVIDENCE') {
      const relatedTerms = TRANSFER[normalized(requirement.label)] || [];
      const relatedProjects = snapshot.projects.filter(project => relatedTerms.some(term => text(project).includes(normalized(term))));
      if (relatedProjects.length) {
        projects = relatedProjects;
        const claimIds = uniq(relatedProjects.flatMap(project => project.evidence_refs || []));
        evidence = snapshot.evidence.filter(claim => claimIds.includes(claim.id));
        status = 'PARTIAL_MATCH';
        note = `Related evidence exists (${relatedTerms.join(', ')}), but it does not prove ${requirement.label} experience.`;
      }
    }

    if (gaps.some(gap => gap.status === 'CONFIRMED_ABSENCE')) status = 'CONFLICTING_EVIDENCE';
    const evidenceIds = uniq([
      ...evidence.map(item => item.id), ...projects.map(item => item.id), ...skills.map(item => item.id),
      ...stories.map(item => item.id), ...gaps.map(item => item.id),
    ]);
    const gap = status === 'STRONG_MATCH' && !gaps.length ? null : {
      requirementId: requirement.id,
      kind: gaps.length ? gapKind(gaps[0].status) : status === 'PARTIAL_MATCH' ? 'weak' : 'missing',
      gapIds: gaps.map(item => item.id),
      explanation: status === 'PARTIAL_MATCH' ? note : (gaps[0]?.limitation || note),
    };
    return {
      requirementId: requirement.id, requirement, status,
      confidence: status === 'STRONG_MATCH' ? 'HIGH' : status === 'NO_EVIDENCE' ? 'LOW' : 'MEDIUM',
      evidenceIds, claimIds: evidence.map(item => item.id), projectIds: projects.map(item => item.id),
      skillIds: skills.map(item => item.id), storyIds: stories.map(item => item.id), gapIds: gaps.map(item => item.id),
      evidence: evidence.map(item => ({ id: item.id, claim: item.claim, status: item.status, confidence: item.confidence })),
      projects: projects.map(item => ({ id: item.id, name: item.name, capabilities: item.capabilities, technologies: item.technologies, outcomes: item.outcomes })),
      note, gap,
    };
  });
}
