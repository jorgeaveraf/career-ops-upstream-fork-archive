function uniq(values) { return [...new Set(values.filter(Boolean))].sort(); }
function orderedUnique(values) { return [...new Set(values.filter(Boolean))]; }

export function selectPackageEvidence(evaluationArtifact, candidateProvider) {
  const snapshot = candidateProvider.getSnapshot();
  const evaluation = evaluationArtifact?.evaluation;
  if (!evaluation || evaluationArtifact?.status !== 'VALID') throw new Error('a VALID job evaluation is required');
  if (evaluation.recommendation !== 'APPLY') {
    const error = new Error('application packages require an APPLY evaluation');
    error.code = 'PACKAGE_EVALUATION_NOT_APPLY';
    throw error;
  }
  const orderedIds = orderedUnique([
    ...(evaluation.strengths || []).flatMap(item => item.evidence_ids || []),
    ...(evaluation.evidence_used || []),
  ]).filter(id => !String(id).startsWith('gap.'));
  const selected = new Set(orderedIds);
  const order = new Map(orderedIds.map((id, index) => [id, index]));
  const selectedInOrder = items => items.filter(item => selected.has(item.id))
    .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const entities = {
    evidence: snapshot.evidence.filter(item => selected.has(item.id) && item.status === 'CONFIRMED'),
    projects: selectedInOrder(snapshot.projects),
    skills: selectedInOrder(snapshot.skills),
    stories: selectedInOrder(snapshot.stories),
  };
  const linkedExperienceIds = new Set(entities.projects.map(item => item.experience_ref));
  entities.experience = snapshot.experience.filter(item => linkedExperienceIds.has(item.id));
  const allowedIds = uniq(Object.values(entities).flat().map(item => item.id));
  return { snapshot, entities, allowedIds };
}
