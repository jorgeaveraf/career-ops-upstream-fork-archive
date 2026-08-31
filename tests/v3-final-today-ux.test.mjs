import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_CONTRACTS } from '../human-control-plane/contracts.mjs';
import { collectHumanActions } from '../human-control-plane/human-actions.mjs';
import { matrixToRowsLoose, rowsToMatrix } from '../human-control-plane/projection.mjs';
import { buildManagedTabFormatRequests, buildTodayContextualValidationRequests, buildTodayPresentationMatrix, stripTodayPresentationMatrix, TODAY_DATA_START_ROW_INDEX, TODAY_HEADER_ROW_INDEX } from '../human-control-plane/sheet-ux.mjs';

const contract = TAB_CONTRACTS.TODAY;
const blankRow = overrides => Object.fromEntries(contract.columns.map(column => [column, overrides?.[column] ?? '']));
const sheet = { properties: { title:'TODAY', sheetId:42, gridProperties:{rowCount:1000,columnCount:contract.columns.length} }, conditionalFormats:[] };
const rules = requests => requests.filter(request=>request.addConditionalFormatRule).map(request=>request.addConditionalFormatRule.rule);

test('TODAY columns follow operator questions and keep internals last',()=>{
  assert.deepEqual(contract.columns.slice(0,18),['Stage','Company','Role','Status','Action','Handoff Type','Handoff Instruction','Open Application','Question Bundle','Application Progress','Recommendation','Rank','Location','Attention Type','Lane','Question','Reason','Allowed Actions']);
  assert.ok(contract.columns.indexOf('Company') < contract.columns.indexOf('Attention Type'));
  assert.ok(contract.columns.indexOf('Outcome') < contract.columns.indexOf('Evaluation'));
  assert.ok(contract.columns.indexOf('Rank') < contract.columns.indexOf('Resume'));
  assert.ok(contract.columns.indexOf('Why This Role') < contract.columns.indexOf('Last Command'));
});

test('TODAY presentation adds authoritative summary and hides default no-action choices',()=>{
  const rows=[
    blankRow({'Lane':'HUMAN ATTENTION','Company':'Intercom','Role':'SA','Attention Type':'DECISION_REQUIRED','Human Decision':'NO_ACTION','Application Decision':'NO_ACTION','Entity ID':'intercom'}),
    blankRow({'Lane':'HUMAN ATTENTION','Company':'Supabase','Role':'SA Lead','Attention Type':'VERIFICATION_REQUIRED','Human Decision':'NEXT_STAGE','Application Decision':'APPROVE_TO_APPLY','Entity ID':'supabase'}),
    blankRow({'Lane':"TODAY'S TOP",'Company':'Scalepex','Role':'AI Engineer','Workflow Stage':'PREPARE','Workflow Status':'QUEUED','Human Decision':'NEXT_STAGE','Application Decision':'NO_ACTION','Entity ID':'scalepex'}),
  ];
  const raw=rowsToMatrix('TODAY',rows);const summary={needsAttention:2,status:'ATTENTION',lastCommand:'Sync Jobs',commandStatus:'SUCCESS',lastDailyCompletion:'2026-08-28T17:30:00Z'};
  const first=buildTodayPresentationMatrix(raw,summary),second=buildTodayPresentationMatrix(raw,summary);
  assert.deepEqual(second,first);assert.equal(first[TODAY_HEADER_ROW_INDEX][0],'Stage');
  assert.deepEqual(first[0].slice(0,9),['CAREER OPS','Needs Your Attention','2','Status','ATTENTION','Last Command','Sync Jobs · SUCCESS','Last Daily Completion','2026-08-28T17:30:00Z']);
  assert.equal(first[1][1],'0 = nothing to do');
  assert.equal(first[3][contract.columns.indexOf('Human Decision')],'');
  assert.equal(first[4][contract.columns.indexOf('Human Decision')],'NEXT_STAGE');
  assert.equal(first[4][contract.columns.indexOf('Application Decision')],'APPROVE_TO_APPLY');
  assert.equal(first[5][contract.columns.indexOf('Human Decision')],'NEXT_STAGE');
  const stripped=stripTodayPresentationMatrix(first);assert.deepEqual(stripped[0],raw[0]);assert.equal(stripped[1][contract.columns.indexOf('Human Decision')],'');assert.equal(stripped[2][contract.columns.indexOf('Human Decision')],'NEXT_STAGE');
});

test('TODAY formatting freezes identity, hides internals and makes yellow contextual',()=>{
  const requests=buildManagedTabFormatRequests(sheet),encoded=JSON.stringify(rules(requests));
  const sheetProps=requests.find(request=>request.updateSheetProperties)?.updateSheetProperties.properties.gridProperties;
  assert.deepEqual({rows:sheetProps.frozenRowCount,columns:sheetProps.frozenColumnCount},{rows:3,columns:3});
  assert.equal(requests.find(request=>request.setBasicFilter).setBasicFilter.filter.range.startRowIndex,TODAY_HEADER_ROW_INDEX);
  for(const field of ['Last Command','Command Status','Command Result','Attention Status','Enrichment Summary','Last Enriched','Human Blocker','Lifecycle State','Decision Outcome','Enrichment Status','Execution Status','Entity Type','Job ID','Question ID','Entity ID','Projection Hash']){
    const column=contract.columns.indexOf(field);assert.ok(requests.some(request=>{const update=request.updateDimensionProperties;return update?.properties.hiddenByUser===true&&update.range.startIndex<=column&&update.range.endIndex>column;}),field);
  }
  for(const type of ['DECISION_REQUIRED','REVIEW_REQUIRED','ANSWER_REQUIRED','APPROVAL_REQUIRED','VERIFICATION_REQUIRED','FOLLOW_UP_REQUIRED'])assert.match(encoded,new RegExp(type));
  assert.match(encoded,/"red":1,"green":0\.949019/i);
  const humanBodyFormats=requests.filter(request=>request.repeatCell?.range?.startRowIndex===TODAY_DATA_START_ROW_INDEX&&request.repeatCell.cell.userEnteredFormat?.backgroundColorStyle&&contract.humanOwned.includes(contract.columns[request.repeatCell.range.startColumnIndex]));
  assert.ok(humanBodyFormats.every(request=>JSON.stringify(request).includes('0.952941')||JSON.stringify(request).includes('0.964705')||JSON.stringify(request).includes('0.972549')));
});

test('contextual dropdowns exist only for the current attention action',()=>{
  const rows=[
    blankRow({'Attention Type':'DECISION_REQUIRED'}),blankRow({'Attention Type':'REVIEW_REQUIRED','Allowed Actions':'APPROVE_TO_APPLY · HOLD · REJECT'}),blankRow({'Attention Type':'REVIEW_REQUIRED','Allowed Actions':'REJECT · HOLD · NEXT_STAGE'}),blankRow({'Attention Type':'APPROVAL_REQUIRED','Allowed Actions':'APPROVE_TO_APPLY · HOLD · REJECT'}),
    blankRow({'Attention Type':'VERIFICATION_REQUIRED'}),blankRow({'Attention Type':'FOLLOW_UP_REQUIRED'}),blankRow({'Attention Type':'EXTERNAL_ACTION_REQUIRED'}),blankRow({'Lane':"TODAY'S TOP"}),
  ];
  const requests=buildTodayContextualValidationRequests(sheet,rowsToMatrix('TODAY',rows));
  const targets=requests.map(request=>({row:request.setDataValidation.range.startRowIndex,column:contract.columns[request.setDataValidation.range.startColumnIndex],allowed:request.setDataValidation.rule.condition.values.map(value=>value.userEnteredValue)}));
  assert.deepEqual(targets.map(target=>target.column),['Human Decision','Rejection Reason','Application Decision','Human Decision','Application Decision','Human Resolution','Outcome']);
  assert.deepEqual(targets[0].allowed,['REJECT','HOLD','NEXT_STAGE']);
  assert.deepEqual(targets[5].allowed,['CONFIRMED_APPLIED','NOT_APPLIED','KEEP_UNKNOWN']);
  assert.ok(targets.every(target=>target.row>=TODAY_DATA_START_ROW_INDEX));
});

test('artifact states are visually distinct and only READY is link-styled',()=>{
  const encoded=JSON.stringify(rules(buildManagedTabFormatRequests(sheet)));
  for(const value of ['READY ·','NOT_GENERATED','SUPERSEDED','ERROR'])assert.ok(encoded.includes(value));
  assert.match(encoded,/READY ·.*bold.*foregroundColorStyle/);
});

test('human import remains header-based after presentation reorder',()=>{
  const baseline=blankRow({'Lane':'HUMAN ATTENTION','Company':'Intercom','Role':'SA','Attention Type':'DECISION_REQUIRED','Human Decision':'NO_ACTION','Entity Type':'JOB','Job ID':'job-1','Entity ID':'job-1','Projection Hash':'hash'});
  const projection={tabs:{TODAY:[baseline]}};
  for(const name of Object.keys(TAB_CONTRACTS))projection.tabs[name]||=[];
  const headers=['Role','Entity ID','Human Decision','Company','Projection Hash','Attention Type'];
  const matrix=[headers,['SA','job-1','NEXT_STAGE','Intercom','hash','DECISION_REQUIRED']];
  const sheetRows=Object.fromEntries(Object.keys(TAB_CONTRACTS).map(name=>[name,[]]));sheetRows.TODAY=matrixToRowsLoose('TODAY',matrix);
  const result=collectHumanActions({projection,sheetRows,spreadsheetId:'sheet',observedAt:'2026-08-28T12:00:00Z'});
  assert.equal(result.accepted.length,1);assert.equal(result.accepted[0].field,'human_decision');assert.equal(result.accepted[0].value,'NEXT_STAGE');
});
