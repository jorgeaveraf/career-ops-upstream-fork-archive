/** @OnlyCurrentDoc */
const CAREER_OPS_SYSTEM_HEADERS = Object.freeze({
  TODAY: ['Lane','Company','Role','Workflow Stage','Workflow Status','Last Activity','Last Updated','Attention Type','Attention Priority','Reason','Question','Allowed Actions','Recommended Action','Evaluation','Key Fit Reasons','Meaningful Gaps','Application Path','Package Version','Resume','Cover Letter','Contacts','Job URL','Rank','Movement','Location','Eligibility','Final Priority','Evidence Confidence','Missing Evidence','Why This Role','Last Command','Command Status','Command Result','Attention Status','Enrichment Summary','Last Enriched','Human Blocker','Lifecycle State','Decision Outcome','Enrichment Status','Execution Status','Entity Type','Job ID','Question ID','Entity ID','Projection Hash'],
  PIPELINE: ['State','Current Rank','Company','Role','Eligibility','Selection Score','Final Priority','Attention Status','Evidence Confidence','Research Needs','Freshness','Source','Decision Outcome','Enrichment Status','Last Updated','Job URL','Entity ID','Projection Hash'],
  RESEARCH: ['Research Priority','Company','Role','Current Rank','Eligibility','Potential Value','Needs','Primary Blocker','Status','Last Research','Job URL','Entity ID','Projection Hash'],
  COMMUNITIES: ['Recommendation','Community','Workflow Stage','Workflow Status','Last Activity','Last Updated','Topic','Visibility','Members','Activity','Opportunity Signal','Spam','Quality','Membership State','Monitoring Readiness','Monitoring Status','Posts Seen','Opportunities Found','Why It Matters','Group URL','Last Checked','Entity ID','Projection Hash'],
  APPLICATIONS: ['Company','Role','Applied Date','Application Channel','Confirmation','Application Status','Contacts','Job URL','Entity ID','Projection Hash'],
  CONTACTS: ['Job','Company','Contact Status','Contact Summary','Contact Count','Best Contact','Relationship','Channels','Evidence Confidence','Last Researched','Job URL','Entity ID','Projection Hash'],
  SETTINGS: ['Key','Value','Owner','Description'],
});

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Career Ops')
    .addItem('Sync Jobs', 'syncJobs')
    .addItem('Sync Communities', 'syncCommunities')
    .addToUi();
}

function setSetting_(sheet, key, value, description) {
  const values = sheet.getDataRange().getDisplayValues();
  const keyColumn = values[0].indexOf('Key'); const valueColumn = values[0].indexOf('Value');
  if (keyColumn < 0 || valueColumn < 0) throw new Error('SETTINGS contract is invalid.');
  let row = values.findIndex((item, index) => index > 0 && item[keyColumn] === key);
  if (row < 0) { sheet.appendRow([key, '', 'CAREER_OPS', description]); row = sheet.getLastRow() - 1; }
  sheet.getRange(row + 1, valueColumn + 1).setValue(value);
}

function queueWorkflow_(commandType, statusPrefix) {
  const spreadsheet = SpreadsheetApp.getActive();
  const sheet = spreadsheet.getSheetByName('SETTINGS');
  if (!sheet) return spreadsheet.toast('SETTINGS is not available.', 'Career Ops', 5);
  const properties = PropertiesService.getScriptProperties();
  const gatewayUrl = properties.getProperty('CAREER_OPS_COMMAND_GATEWAY_URL');
  const secret = properties.getProperty('CAREER_OPS_COMMAND_SECRET');
  if (!gatewayUrl || !secret) return spreadsheet.toast('Career Ops command gateway is not configured.', 'Career Ops', 8);
  const commandId = Utilities.getUuid(); const requestedAt = new Date().toISOString();
  const requestedBy = Session.getEffectiveUser().getEmail() || 'sheet-user';
  const deliveryProbe = properties.getProperty('CAREER_OPS_COMMAND_DELIVERY_PROBE') === 'true';
  const envelope = { command_version: '3A.1', command_id: commandId, command_type: commandType, requested_at: requestedAt, source: 'google_sheet', sheet_id: spreadsheet.getId(), requested_by: requestedBy, correlation_id: commandId, payload: deliveryProbe ? { delivery_probe: true } : {} };
  const body = JSON.stringify(envelope); const signatureInput = `${requestedAt}\n${commandId}\n${body}`;
  const signature = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(signatureInput, secret)).replace(/=+$/, '');
  let response;
  try {
    response = UrlFetchApp.fetch(gatewayUrl.replace(/\/$/, '') + '/v1/commands', { method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true, headers: { 'X-Career-Ops-Request-Id': commandId, 'X-Career-Ops-Timestamp': requestedAt, 'X-Career-Ops-Signature': signature } });
  } catch (error) { return spreadsheet.toast('Career Ops command gateway is unavailable.', 'Career Ops', 8); }
  if (response.getResponseCode() !== 202) return spreadsheet.toast('Career Ops command gateway is unavailable.', 'Career Ops', 8);
  setSetting_(sheet, `Last ${statusPrefix} Command`, commandId, `Most recent accepted ${statusPrefix} request`);
  setSetting_(sheet, `Last ${statusPrefix} Status`, 'QUEUED', `Current ${statusPrefix} request status`);
  spreadsheet.toast(`Career Ops received the request. It will run when the local worker is available. (${commandId.slice(0, 8)})`, 'Career Ops', 8);
}

function syncJobs() {
  queueWorkflow_('jobs.sync', 'Job Sync');
}

function syncCommunities() {
  queueWorkflow_('communities.sync', 'Community Sync');
}

function onEdit(event) {
  if (!event || !event.range) return;
  const sheet = event.range.getSheet();
  const protectedHeaders = CAREER_OPS_SYSTEM_HEADERS[sheet.getName()] || [];
  const probe = sheet.getRange(1, 1, Math.min(10, sheet.getMaxRows()), sheet.getLastColumn()).getDisplayValues();
  const headerOffset = probe.findIndex(row => row.includes('Entity ID') || (row.includes('Key') && row.includes('Value')));
  const headerRow = headerOffset >= 0 ? headerOffset + 1 : 1;
  if (event.range.getRow() <= headerRow) return;
  const header = sheet.getRange(headerRow, event.range.getColumn()).getDisplayValue();
  if (protectedHeaders.includes(header)) SpreadsheetApp.getActive().toast(`${header} is owned by Career Ops; local import will reject this edit.`, 'Protected field', 8);
  if (sheet.getName() === 'FOLLOW_UPS') {
    const idColumn = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].indexOf('Entity ID') + 1;
    if (idColumn > 0 && !sheet.getRange(event.range.getRow(), idColumn).getValue()) sheet.getRange(event.range.getRow(), idColumn).setValue(Utilities.getUuid());
  }
}
