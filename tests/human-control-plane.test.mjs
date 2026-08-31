import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { CONTROL_PLANE_TABS, HUMAN_FIELD_VALIDATION, TAB_CONTRACTS } from '../human-control-plane/contracts.mjs';
import { collectHumanActions } from '../human-control-plane/human-actions.mjs';
import { buildControlPlaneProjection, matrixToRows, mergeProjectionRows, rowsToMatrix } from '../human-control-plane/projection.mjs';
import { MemorySheetsAdapter } from '../human-control-plane/sheets-adapter.mjs';
import { buildManagedTabFormatRequests, buildReadmeValues, buildTabOrderRequests, README_TAB, WORKBOOK_TAB_ORDER } from '../human-control-plane/sheet-ux.mjs';
import { HumanControlPlaneSync } from '../human-control-plane/sync.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const NOW = '2026-08-22T12:00:00.000Z';
const SPREADSHEET = 'sheet-fixture';
function registryWithJob() {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  registry.startRun({ id: 'run-control-plane' });
  const observed = registry.recordObservation('run-control-plane', {
    provider: 'fixture', externalId: 'job-1', sourceUrl: 'https://jobs.example.test/job-1',
    title: 'AI Platform Engineer', company: 'Acme Labs', location: 'Remote', description: 'Build and operate production AI platform systems for distributed teams. '.repeat(8), retrievedAt: NOW,
  });
  registry.finishRun('run-control-plane');
  return { registry, jobId: observed.jobId };
}
function data(jobId) {
  const snapshot = { jobId, rank: 1, previousRank: null, movement: 'NEW', finalPriorityScore: 87, eligibilityStatus: 'ELIGIBLE', candidateFitScore: 88, opportunityScore: 85, isTop10: true, evidenceWeak: false, evidenceCompleteness: { description: { status: 'SUPPORTED' }, geography: { status: 'SUPPORTED' }, employment: { status: 'SUPPORTED' }, compensation: { status: 'SUPPORTED' } } };
  return {
    jobs: [{
      job: { id: jobId, title: 'AI Platform Engineer', company: 'Acme Labs', location: 'Remote', description:'Build and operate production AI platform systems for distributed teams. '.repeat(8),identityConfidence:'high',status: 'DISCOVERED', url: 'https://jobs.example.test/job-1', source: 'fixture', lastSeenAt: NOW },
      assessment: { eligibilityStatus: 'ELIGIBLE', eligibilityScore: 90, candidateFitScore: 88, opportunityScore: 85, finalPriorityScore: 87, decision: 'SHORTLIST', confidence:'high',employmentModel: 'contract',result:{candidateFit:{score:88},opportunity:{score:85},eligibility:{signals:{employmentModel:'contract',evidenceCompleteness:{description:{status:'PRESENT'},geography:{status:'SUPPORTED'},employment:{status:'PRESENT'},compensation:{status:'UNKNOWN'}}}}} },
      evaluation: { id: 'evaluation-1', status: 'VALID', recommendation: 'APPLY', confidence:'HIGH',overallFit:90,evaluatedAt: NOW },
      applicationPackage: { id: 'package-1', packageVersion: 1, status: 'DRAFT', validationStatus: 'VALID' },
    }],
    contacts: [], contactResearch: [], humanState: [], followUps: [], enrichmentRequests: [], applicationExecutions: [], runs: [{ id: 'run-control-plane', status: 'SUCCESS', startedAt: NOW, finishedAt: NOW }], syncState: null,
    candidateSelection: { latestSnapshotRun: 'run-control-plane', activeCandidates: [{ jobId, state: 'ACTIVE', preliminaryScore: 90, freshnessDays: 0, source: 'fixture', updatedAt: NOW }], snapshot: [snapshot], top10: [snapshot], researchNeeds: [] },
  };
}
const projection = jobId => buildControlPlaneProjection(data(jobId), { spreadsheetId: SPREADSHEET, careerOpsVersion: '1.26.0', schemaVersion: 7, candidateKbVersion: 1, generatedAt: NOW });

test('spreadsheet initialization is idempotent and creates README plus the seven contracted tabs', async () => {
  const adapter = new MemorySheetsAdapter();
  await adapter.initialize(); await adapter.initialize();
  assert.deepEqual(Object.keys(adapter.tabs), WORKBOOK_TAB_ORDER.filter(name=>name===README_TAB||CONTROL_PLANE_TABS.includes(name)));
  assert.deepEqual(adapter.tabs.README, buildReadmeValues());
  for (const name of CONTROL_PLANE_TABS) assert.deepEqual(adapter.tabs[name], [TAB_CONTRACTS[name].columns]);
});

test('spreadsheet initialization refreshes an existing managed README', async () => {
  const adapter = new MemorySheetsAdapter({ tabs: { README: [['stale V1 copy']] } });
  await adapter.initialize();
  assert.deepEqual(adapter.tabs.README, buildReadmeValues());
});

test('tab ordering puts README first, human views next, and technical tabs last', () => {
  const sheets = ['SOURCE_METRICS', 'TODAY', 'EXTRA_TECHNICAL', 'README', 'RESEARCH', 'PIPELINE', 'COMMUNITIES', 'APPLICATIONS', 'CONTACTS', 'FOLLOW_UPS', 'SETTINGS']
    .map((title, index) => ({ properties: { title, sheetId: 100 + index, index } }));
  const requests = buildTabOrderRequests(sheets);
  assert.deepEqual(requests.map(request => request.updateSheetProperties.properties.index), WORKBOOK_TAB_ORDER.map((_, index) => index));
  assert.deepEqual(requests.map(request => sheets.find(sheet => sheet.properties.sheetId === request.updateSheetProperties.properties.sheetId).properties.title), WORKBOOK_TAB_ORDER);
});

test('human-owned field detection matches the allowlisted input surface', () => {
  assert.deepEqual(TAB_CONTRACTS.TODAY.humanOwned, ['Human Decision', 'Rejection Reason', 'Application Decision', 'Outreach Decision', 'Human Answer', 'Human Resolution', 'Resolution Notes', 'Follow-Up Date', 'Follow-Up Action', 'Notes', 'Outcome']);
  assert.deepEqual(TAB_CONTRACTS.PIPELINE.humanOwned, ['Human Decision', 'Rejection Reason']);
  assert.deepEqual(TAB_CONTRACTS.RESEARCH.humanOwned, ['Human Notes']);
  assert.deepEqual(TAB_CONTRACTS.COMMUNITIES.humanOwned, ['Membership Decision', 'Notes']);
  assert.deepEqual(TAB_CONTRACTS.APPLICATIONS.humanOwned, ['Follow-Up Date', 'Response Status', 'Interview Date', 'Next Action', 'Outcome', 'Notes']);
  assert.deepEqual(TAB_CONTRACTS.CONTACTS.humanOwned, ['Outreach Outcome', 'Notes']);
  assert.deepEqual(TAB_CONTRACTS.FOLLOW_UPS.humanOwned, ['Date', 'Action', 'Related Job', 'Status', 'Notes']);
  assert.deepEqual(HUMAN_FIELD_VALIDATION['TODAY.Human Decision'], ['NO_ACTION', 'REJECT', 'HOLD', 'NEXT_STAGE', 'REVIEW', 'APPROVE']);
});

test('a blank TODAY Application Decision imports as the explicit NO_ACTION boundary', () => {
  const current = projection('job-blank-app-decision');
  const sheetRows = structuredClone(current.tabs);
  sheetRows.TODAY = sheetRows.TODAY.map(row => ({ ...row, 'Application Decision': '' }));
  const result = collectHumanActions({ projection: current, sheetRows, spreadsheetId: 'sheet', observedAt: NOW });
  assert.equal(result.accepted.find(item => item.field === 'application_decision'), undefined);
});

function fixtureSheet(title, { conditionalFormats = [] } = {}) {
  return { properties: { title, sheetId: 42, gridProperties: { rowCount: 1000, columnCount: 30 } }, conditionalFormats };
}
function conditionalRules(requests) { return requests.filter(request => request.addConditionalFormatRule).map(request => request.addConditionalFormatRule.rule); }

test('formatting application is deterministic and replaces conditional rules instead of duplicating them', () => {
  const sheet = fixtureSheet('TODAY', { conditionalFormats: [{ old: 1 }, { old: 2 }, { old: 3 }] });
  const first = buildManagedTabFormatRequests(sheet); const second = buildManagedTabFormatRequests(sheet);
  assert.deepEqual(second, first);
  assert.deepEqual(first.filter(request => request.deleteConditionalFormatRule).map(request => request.deleteConditionalFormatRule.index), [2, 1, 0]);
  const signatures = conditionalRules(first).map(rule => JSON.stringify(rule));
  assert.equal(new Set(signatures).size, signatures.length);
});

test('TODAY formatting gives action, review, and research distinct text-backed cues', () => {
  const requests = buildManagedTabFormatRequests(fixtureSheet('TODAY'));
  const encoded = JSON.stringify(conditionalRules(requests));
  assert.match(encoded, /ACTION_READY/); assert.match(encoded, /REVIEW_REQUIRED/); assert.match(encoded, /RESEARCH_REQUIRED/);
  assert.match(encoded, /CUSTOM_FORMULA/); assert.match(encoded, /NEW/); assert.match(encoded, /NEEDS_HUMAN/); assert.match(encoded, /READY_FOR_REVIEW/);
  for (const value of ['VERIFICATION_REQUIRED','ANSWER_REQUIRED','APPROVAL_REQUIRED','DECISION_REQUIRED','FOLLOW_UP_REQUIRED','EXTERNAL_ACTION_REQUIRED']) assert.match(encoded,new RegExp(value));
  for (const value of ['WAITING_FOR_HUMAN','PROCESSING','QUEUED','FAILED','BLOCKED','SUCCESS']) assert.match(encoded, new RegExp(value));
  const humanNotes = requests.filter(request => request.updateCells?.rows?.[0]?.values?.[0]?.note === 'Contextual human input — yellow means actionable now.');
  assert.equal(humanNotes.length, 11);
  const visibility = requests.filter(request => request.updateDimensionProperties?.properties?.hiddenByUser !== undefined);
  const hidden=visibility.filter(request=>request.updateDimensionProperties.properties.hiddenByUser);
  assert.ok(hidden.length>=4);assert.ok(hidden.some(request=>request.updateDimensionProperties.range.startIndex===TAB_CONTRACTS.TODAY.columns.indexOf('Entity ID')));
});

test('PIPELINE formatting stays calm while surfacing APPLY, state, unified rank, and human input', () => {
  const requests = buildManagedTabFormatRequests(fixtureSheet('PIPELINE'));
  const encoded = JSON.stringify(conditionalRules(requests));
  for (const value of ['APPLY', 'ACTIVE', 'HOLD']) assert.match(encoded, new RegExp(value));
  assert.equal(requests.filter(request => request.updateCells?.rows?.[0]?.values?.[0]?.note === 'Human input — safe to edit.').length, 2);
});

test('RESEARCH formatting reads as a system queue and marks only Human Notes as editable', () => {
  const requests = buildManagedTabFormatRequests(fixtureSheet('RESEARCH'));
  const encoded = JSON.stringify(conditionalRules(requests));
  assert.match(encoded, /HIGH/); assert.match(encoded, /ISNUMBER\(\$D2\)/);
  assert.equal(requests.filter(request => request.updateCells?.rows?.[0]?.values?.[0]?.note === 'Human input — safe to edit.').length, 1);
  assert.doesNotMatch(encoded, /ACTION_READY/);
});

test('COMMUNITIES formatting makes human-required and join lifecycle states visible', () => {
  const requests = buildManagedTabFormatRequests({ properties: { title: 'COMMUNITIES', sheetId: 7, gridProperties: { rowCount: 1000 } }, conditionalFormats: [] });
  const text = JSON.stringify(requests);
  for (const state of ['NEEDS_HUMAN','JOIN_REQUESTED','VERIFICATION_UNKNOWN','JOINED_CONFIRMED']) assert.match(text, new RegExp(state));
});

test('projection maps registry-owned job facts into TODAY and PIPELINE rows', () => {
  const artifact = projection('job-1');
  const row = artifact.tabs.TODAY[0];
  assert.deepEqual({ lane:row.Lane, Company: row.Company, Role: row.Role, Eligibility: row.Eligibility, finalPriority: row['Final Priority'], evaluation:row.Evaluation, humanDecision: row['Human Decision'], entityId: row['Entity ID'] }, {
    lane:'CURATED_PIPELINE',Company: 'Acme Labs', Role: 'AI Platform Engineer', Eligibility: 'ELIGIBLE',
    finalPriority: 87, evaluation:'APPLY · HIGH', humanDecision: 'NO_ACTION', entityId: 'job-1',
  });
  assert.equal(artifact.tabs.PIPELINE[0].State, 'ACTIVE');
});

test('legacy APPROVE is imported as canonical NEXT_STAGE through the allowlisted action boundary', () => {
  const artifact = projection('job-1');
  const rows = structuredClone(artifact.tabs);
  rows.TODAY[0]['Human Decision'] = 'APPROVE';
  const result = collectHumanActions({ projection: artifact, sheetRows: rows, spreadsheetId: SPREADSHEET, observedAt: NOW, user: 'jorge' });
  assert.deepEqual(result.accepted.map(item => [item.entityType, item.entityId, item.field, item.value]), [['JOB', 'job-1', 'human_decision', 'NEXT_STAGE']]);
});

test('editing a Career Ops score is rejected and never becomes human state', () => {
  const artifact = projection('job-1');
  const rows = structuredClone(artifact.tabs);
  rows.TODAY[0]['Final Priority'] = 100;
  const result = collectHumanActions({ projection: artifact, sheetRows: rows, spreadsheetId: SPREADSHEET, observedAt: NOW });
  assert.ok(result.rejected.some(item => item.field === 'Final Priority' && item.reason === 'CAREER_OWNED_FIELD'));
  assert.equal(result.accepted.some(item => item.field === 'Final Priority'), false);
});

test('two identical pushes are sheet-idempotent', async () => {
  const { registry, jobId } = registryWithJob(); const adapter = new MemorySheetsAdapter();
  try {
    const service = new HumanControlPlaneSync({ registry, adapter, spreadsheetId: SPREADSHEET, clock: () => new Date(NOW) });
    const artifact = projection(jobId);
    await service.push(artifact); const first = structuredClone(adapter.tabs);
    await service.push(artifact); assert.deepEqual(adapter.tabs, first);
  } finally { registry.close(); }
});

test('push preserves decisions and notes already entered by the human', async () => {
  const { registry, jobId } = registryWithJob(); const adapter = new MemorySheetsAdapter();
  try {
    const service = new HumanControlPlaneSync({ registry, adapter, spreadsheetId: SPREADSHEET, clock: () => new Date(NOW) });
    const artifact = projection(jobId); await service.push(artifact);
    const today = matrixToRows('TODAY', adapter.tabs.TODAY);
    today[0]['Human Decision'] = 'REVIEW'; today[0].Notes = 'Check contract details';
    adapter.tabs.TODAY = rowsToMatrix('TODAY', today);
    await service.push(artifact);
    const preserved = matrixToRows('TODAY', adapter.tabs.TODAY)[0];
    assert.equal(preserved['Human Decision'], 'HOLD'); assert.equal(preserved.Notes, 'Check contract details');
  } finally { registry.close(); }
});

test('authoritative push after pull consumes stale sheet decisions instead of replaying them', async () => {
  const { registry, jobId } = registryWithJob(); const adapter = new MemorySheetsAdapter();
  try {
    const service = new HumanControlPlaneSync({ registry, adapter, spreadsheetId: SPREADSHEET, clock: () => new Date(NOW) });
    const initial = projection(jobId); await service.push(initial);
    const today = matrixToRows('TODAY', adapter.tabs.TODAY);
    today[0]['Human Decision'] = 'NEXT_STAGE';
    adapter.tabs.TODAY = rowsToMatrix('TODAY', today);
    const pulled = await service.pull(initial, { user: 'jorge' });
    assert.equal(pulled.imported.applied.filter(item => item.field === 'human_decision').length, 1);

    const refreshedData = data(jobId);
    refreshedData.humanState = registry.getHumanFieldState();
    const refreshed = buildControlPlaneProjection(refreshedData, { spreadsheetId: SPREADSHEET, careerOpsVersion: '1.26.0', schemaVersion: 7, candidateKbVersion: 1 });
    await service.push(refreshed, { preserveHumanEdits:false });

    const sheetRows = Object.fromEntries(CONTROL_PLANE_TABS.map(name => [name, matrixToRows(name, adapter.tabs[name])]));
    const replay = collectHumanActions({ projection: refreshed, sheetRows, spreadsheetId: SPREADSHEET, observedAt: NOW, user: 'jorge' });
    assert.equal(replay.accepted.filter(item => item.field === 'human_decision').length, 0);
    assert.equal(matrixToRows('PIPELINE', adapter.tabs.PIPELINE)[0]['Human Decision'], 'NEXT_STAGE');
  } finally { registry.close(); }
});

test('push preserves a human-created follow-up until pull imports it', async () => {
  const { registry, jobId } = registryWithJob(); const adapter = new MemorySheetsAdapter();
  try {
    const service = new HumanControlPlaneSync({ registry, adapter, spreadsheetId: SPREADSHEET, clock: () => new Date(NOW) });
    const artifact = projection(jobId); await service.push(artifact);
    adapter.tabs.FOLLOW_UPS.push(['2026-08-23', 'Check application', jobId, 'PENDING', 'Manual reminder', 'follow-up-1']);
    await service.push(artifact);
    assert.deepEqual(matrixToRows('FOLLOW_UPS', adapter.tabs.FOLLOW_UPS)[0], {
      Date: '2026-08-23', Action: 'Check application', 'Related Job': jobId,
      Status: 'PENDING', Notes: 'Manual reminder', 'Entity ID': 'follow-up-1',
    });
  } finally { registry.close(); }
});

test('an idempotency hit can restore a previously used human value', () => {
  const { registry, jobId } = registryWithJob();
  try {
    const artifact = projection(jobId);
    const rows = structuredClone(artifact.tabs); rows.TODAY[0]['Human Decision'] = 'APPROVE';
    const approve = collectHumanActions({ projection: artifact, sheetRows: rows, spreadsheetId: SPREADSHEET, observedAt: NOW, user: 'jorge' });
    registry.recordHumanActions(approve);
    const review = { ...approve.accepted[0], actionKey: 'review-action', value: 'REVIEW' };
    registry.recordHumanActions({ accepted: [review], rejected: [] });
    registry.recordHumanActions(approve);
    assert.equal(registry.getHumanFieldState().find(item => item.field === 'human_decision').value, 'NEXT_STAGE');
  } finally { registry.close(); }
});

test('pull persists accepted actions and rejected score edits separately', async () => {
  const { registry, jobId } = registryWithJob(); const adapter = new MemorySheetsAdapter();
  try {
    const service = new HumanControlPlaneSync({ registry, adapter, spreadsheetId: SPREADSHEET, clock: () => new Date(NOW) });
    const artifact = projection(jobId); await service.push(artifact);
    const today = matrixToRows('TODAY', adapter.tabs.TODAY);
    today[0]['Human Decision'] = 'APPROVE'; today[0]['Final Priority'] = 99;
    adapter.tabs.TODAY = rowsToMatrix('TODAY', today);
    const result = await service.pull(artifact, { user: 'jorge' });
    assert.equal(result.imported.applied.length, 1);
    assert.ok(result.imported.rejected.some(item => item.field === 'Final Priority'));
    assert.deepEqual(registry.getHumanFieldState().map(item => [item.field, item.value]), [['human_decision', 'NEXT_STAGE']]);
  } finally { registry.close(); }
});

function decisionFixture(count = 12, { topCount = 10, rawCount = count, needsPerJob = 2 } = {}) {
  const activeCandidates = Array.from({ length: count }, (_, i) => ({ jobId: `job-${i}`, state: i % 2 ? 'CARRYOVER' : 'ACTIVE', preliminaryScore: 100 - i, freshnessDays: i, source: i === 0 ? 'browser:indeed' : 'fixture', updatedAt: NOW }));
  const snapshot = activeCandidates.map((active, i) => ({ jobId: active.jobId, rank: i + 1, previousRank: i ? i + 2 : null, movement: i ? 'UP_1' : 'NEW', finalPriorityScore: 100-Math.min(i,10), eligibilityStatus: 'ELIGIBLE', decision:'SHORTLIST', candidateFitScore: 90, opportunityScore: 80, isTop10: i < topCount, evidenceWeak: false, evidenceCompleteness: { description: { status: 'PRESENT' }, geography: { status: 'SUPPORTED' }, employment: { status: 'PRESENT' }, compensation: { status: 'UNKNOWN' } } }));
  const jobs = Array.from({ length: rawCount }, (_, i) => ({ job: { id: `job-${i}`, title: i < 2 ? 'Same Role' : `Role ${i}`, company: i < 2 ? 'Same Company' : `Company ${i}`, location: 'Remote',description:'Strong fully evidenced role description. '.repeat(12),identityConfidence:'high', status: 'DISCOVERED', url: `https://example.test/${i}`, source: i === 0 ? 'browser:indeed' : 'fixture', lastSeenAt: NOW }, assessment: i < count ? { eligibilityStatus: 'ELIGIBLE', decision:'SHORTLIST', candidateFitScore:90, opportunityScore:80, finalPriorityScore:100-Math.min(i,10), confidence: 'high', employmentModel: 'contract', result: { candidateFit: { score:90,band: 'HIGH', evidence: { matchedRole: 'AI Systems Engineer' } },opportunity:{score:80}, eligibility: { signals: { employmentModel:'contract',geography: { status: 'SUPPORTED' }, evidenceCompleteness: snapshot[i].evidenceCompleteness } }, compensation: { status: 'UNKNOWN', value: null } } } : null, evaluation:i<count?{status:'VALID',recommendation:'APPLY',confidence:'HIGH',overallFit:90}:null, applicationPackage: null }));
  const researchNeeds = activeCandidates.flatMap((active, i) => Array.from({ length: needsPerJob }, (_, n) => ({ jobId: active.jobId, type: n ? 'CONFIRM_COMPENSATION' : 'FETCH_FULL_DESCRIPTION', dimension: n ? 'compensation' : 'description', priority: i < topCount ? 'HIGH' : 'LOW', priorityScore: (i < topCount ? 100 : 20) - n, status: 'OPEN', updatedAt: NOW, resolvedAt: null })));
  return { jobs, contacts: [], contactResearch: [], enrichmentRequests: [], applicationExecutions: [], humanState: [], followUps: [], runs: [], syncState: null, candidateSelection: { latestSnapshotRun: 'snapshot-1', activeCandidates, snapshot, top10: snapshot.slice(0, topCount), researchNeeds } };
}

test('decision-first TODAY is capped at 10 and does not fill when fewer candidates exist', () => {
  assert.equal(buildControlPlaneProjection(decisionFixture(14)).tabs.TODAY.length, 10);
  assert.equal(buildControlPlaneProjection(decisionFixture(6, { topCount: 6 })).tabs.TODAY.length, 6);
});

test('6000 raw registry rows cannot leak into the bounded decision projection', () => {
  const tabs = buildControlPlaneProjection(decisionFixture(69, { rawCount: 6000 })).tabs;
  assert.equal(tabs.TODAY.length, 10); assert.equal(tabs.PIPELINE.length, 69); assert.equal(tabs.RESEARCH.length, 69);
  assert.equal(tabs.PIPELINE.some(row => row['Entity ID'] === 'job-5999'), false);
});

test('RESEARCH consolidates all open needs to one candidate row and prioritizes TOP candidates', () => {
  const tabs = buildControlPlaneProjection(decisionFixture(12)).tabs;
  assert.equal(tabs.RESEARCH.length, 12); assert.match(tabs.RESEARCH[0].Needs, /Full description/); assert.match(tabs.RESEARCH[0].Needs, /Compensation/);
  assert.ok(tabs.RESEARCH.slice(0, 10).every(row => Number(row['Current Rank']) <= 10));
});

test('human state follows entity identity across row movement, disappearance, and reappearance', () => {
  const first = buildControlPlaneProjection(decisionFixture(12));
  const existing = structuredClone(first.tabs.TODAY); existing[4]['Human Decision'] = 'APPROVE'; existing[4].Notes = 'Keep this decision';
  const moved = [...first.tabs.TODAY].reverse(); const preserved = mergeProjectionRows('TODAY', moved, existing);
  const id = existing[4]['Entity ID']; assert.equal(preserved.find(row => row['Entity ID'] === id)['Human Decision'], 'NEXT_STAGE');
  assert.equal(mergeProjectionRows('TODAY', [], existing).length, 0);
  assert.equal(mergeProjectionRows('TODAY', [first.tabs.TODAY[4]], existing)[0].Notes, 'Keep this decision');
});

test('a current browser-created active candidate is included without a new discovery run', () => {
  const tabs = buildControlPlaneProjection(decisionFixture(2, { topCount: 2 })).tabs;
  assert.equal(tabs.PIPELINE.find(row => row['Entity ID'] === 'job-0').Source, 'browser:indeed');
});

test('stable IDs keep duplicate company/title candidates distinct and technical columns stay secondary', () => {
  const artifact = buildControlPlaneProjection(decisionFixture(2, { topCount: 2 }));
  assert.deepEqual(artifact.tabs.TODAY.map(row => row.Company), ['Same Company', 'Same Company']);
  assert.equal(new Set(artifact.tabs.TODAY.map(row => row['Entity ID'])).size, 2);
  assert.deepEqual(TAB_CONTRACTS.TODAY.columns.slice(-2), ['Entity ID', 'Projection Hash']);
  assert.ok(TAB_CONTRACTS.TODAY.columns.indexOf('Why This Role') < TAB_CONTRACTS.TODAY.columns.indexOf('Entity ID'));
});

test('Apps Script source installs only the two intended workflow items and preserves edit protection', () => {
  const source = readFileSync(new URL('../human-control-plane/apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(source, /function onOpen\(\)/); assert.match(source, /createMenu\('Career Ops'\)/);
  assert.match(source, /Sync Jobs/); assert.doesNotMatch(source, /Refresh Dashboard|Sync Decisions|Sync Applications|Open Selected Job|Open README|Open TODAY/);
  assert.match(source, /Sync Communities/); assert.match(source, /function syncCommunities\(\)/);
  assert.equal((source.match(/\.addItem\('Sync Communities'/g) || []).length, 1); assert.match(source, /@OnlyCurrentDoc/);
  assert.equal((source.match(/\.addItem\('/g)||[]).length,2);
  assert.match(source, /function onEdit\(event\)/); assert.match(source, /Utilities\.getUuid\(\)/);
  assert.doesNotMatch(source, /GmailApp|MailApp|LinkedIn|Facebook/i);
  assert.match(source, /UrlFetchApp\.fetch/); assert.match(source, /computeHmacSha256Signature/);
  assert.match(source, /command_type: commandType/); assert.match(source, /response\.getResponseCode\(\) !== 202/);
  assert.match(source, /CAREER_OPS_COMMAND_DELIVERY_PROBE/); assert.match(source, /delivery_probe: true/);
  assert.doesNotMatch(source, /setSetting_\(sheet, ['"]Job Sync Requested At/);
});
