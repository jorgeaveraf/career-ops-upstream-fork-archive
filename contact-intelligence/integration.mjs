export function buildApplicationPackageContactContext(applicationPackage, contactResearch) {
  if (!applicationPackage?.id) throw new TypeError('application package is required');
  if (!contactResearch?.researchKey) throw new TypeError('contact research is required');
  if (applicationPackage.jobId !== contactResearch.jobId) throw new Error('application package and contact research must belong to the same job');
  return Object.freeze({
    applicationPackageId: applicationPackage.id,
    contactResearchKey: contactResearch.researchKey,
    company: contactResearch.company,
    people: contactResearch.people,
    relationships: contactResearch.relationships,
    outreachStrategy: contactResearch.outreachStrategy,
    reviewStatus: contactResearch.reviewStatus,
  });
}

