import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { CONTROL_PLANE_TABS } from '../human-control-plane/contracts.mjs';
import { ATTENTION_TYPES, VERIFICATION_RESOLUTIONS } from '../human-attention/contracts.mjs';
import { GoogleSheetsApiAdapter, MemorySheetsAdapter } from '../human-control-plane/sheets-adapter.mjs';
import { buildReadmeFormatRequests, buildReadmeValues } from '../human-control-plane/sheet-ux.mjs';

const values = () => buildReadmeValues();
const readmeText = () => values().flat().join('\n');

test('README opens with the autonomous operating rule and the only daily inbox', () => {
  const rows = values();
  assert.equal(rows.length, 122);
  assert.equal(rows[3][0], 'ASÍ OPERAS CAREER OPS');
  assert.match(rows.slice(0, 9).flat().join(' '), /CAREER OPS TRABAJA SOLO.*TODAY.*Needs Your Attention = 0.*no tienes nada que hacer.*Needs Your Attention > 0.*Sync Jobs.*PREFERRED PURSUIT.*ruta oficial.*mejor contacto verificado/is);
});

test('README gives the seven-step operator routine before reference concepts', () => {
  const text = readmeText();
  for (const phrase of ['1 · RECIBE AVISO','2 · ABRE TODAY','3 · TRABAJA POR RANK','4 · REVISA','5 · EDITA AMARILLO','6 · SYNC JOBS','7 · CONTINÚA SOLO']) assert.match(text,new RegExp(phrase,'i'));
  assert.ok(text.indexOf('TU RUTINA DIARIA') < text.indexOf('MAPA DEL CICLO'));
});

test('README documents every canonical attention type and exact actions', () => {
  const text = readmeText();
  for (const type of ATTENTION_TYPES) assert.match(text, new RegExp(type));
  for (const action of ['REJECT','HOLD','NEXT_STAGE','APPROVE_TO_APPLY','APPROVE_OUTREACH','Human Answer','Follow-Up Date','Follow-Up Action']) assert.match(text,new RegExp(action,'i'));
  assert.match(text, /RETRY no existe/i);
});

test('README lists only the current human-owned fields and credential boundary', () => {
  const text = readmeText();
  for (const field of ['Human Decision', 'Rejection Reason', 'Application Decision', 'Human Answer', 'Human Resolution', 'Resolution Notes', 'Follow-Up Date', 'Follow-Up Action', 'Notes', 'Outcome', 'Membership Decision']) assert.match(text, new RegExp(field));
  assert.match(text, /Todo lo demás es administrado por Career Ops/i);
  for (const secret of ['contraseñas', 'MFA', 'tokens', 'credenciales']) assert.match(text, new RegExp(secret, 'i'));
});

test('README explains autonomous continuation and quiet notification philosophy', () => {
  const text = readmeText();
  assert.match(text,/Sync Jobs.*valida.*importa.*idempotente/is);
  assert.match(text,/Sync Jobs exitoso.*NO EMAIL/is);
  for(const phrase of ['resultados o blockers accionables','resumen diario compacto','drafts','schedules','ranking interno','autorrecuperación exitosa'])assert.match(text,new RegExp(phrase,'i'));
});

test('README documents application-first, READY, and exact pursuit artifacts', () => {
  const text = readmeText();
  assert.match(text,/La aplicación es primaria.*outreach es secundario/is);
  assert.match(text,/READY =.*plan exacto de persecución/is);
  for(const phrase of ['paquete actual','ruta de aplicación','Contact Intelligence','mejor contacto','outreach_plan versionado','paquete exacto'])assert.match(text,new RegExp(phrase,'i'));
});

test('README makes autonomous scope and safety boundaries explicit', () => {
  const text = readmeText();
  for(const phrase of ['Descubre y rankea','genera paquete','resuelve ruta oficial','mejor contacto','envía Gmail/LinkedIn','rastrea Gmail replies'])assert.match(text,new RegExp(phrase,'i'));
  for(const phrase of ['Aplicar sin APPROVE_TO_APPLY','outreach sin APPROVE_OUTREACH','mass outreach','guessed emails','canales no soportados','bypass CAPTCHA/MFA','auto-reply','follow-up no aprobado'])assert.match(text,new RegExp(phrase,'i'));
});

test('README keeps normal operation in the Sheet and exact artifact links in TODAY', () => {
  const text = readmeText();
  assert.match(text, /NO repo.*NO CLI.*NO logs.*NO ChatGPT/i);
  assert.match(text, /EXTERNAL_ACTION_REQUIRED/i);
  assert.match(text,/MANUAL_OUTREACH_RECOMMENDED.*URL pública.*mensaje.*timing/is);
  assert.match(text,/TODAY enlaza Resume\/Cover Letter.*paquete exacto/is);
});

test('README preserves verification semantics with no retry path', () => {
  const text = readmeText();
  for (const resolution of VERIFICATION_RESOLUTIONS) assert.match(text, new RegExp(resolution));
  assert.match(text, /RETRY no existe/i);
  assert.doesNotMatch(text, /RETRY\s*(?:\/|·|,|o)\s*(?:CONFIRMED_APPLIED|NOT_APPLIED|KEEP_UNKNOWN)/i);
});

test('README explains separate authorizations and stale approval', () => {
  const text = readmeText();
  assert.match(text,/APPROVE_TO_APPLY.*exactamente una aplicación.*No autoriza mensajes/is);
  assert.match(text,/APPROVE_OUTREACH.*exactamente una acción de outreach.*No autoriza aplicar/is);
  assert.match(text,/trabajo, paquete, ruta, contacto, canal, mensaje o timing.*deja de ser válida/is);
});

test('README uses the V4 human lifecycle and clarifies when preparation starts', () => {
  const text = readmeText();
  for (const stage of ['DISCOVERED', 'PREPARING', 'READY', 'APPLIED', 'ON HOLD']) assert.match(text, new RegExp(stage, 'i'));
  assert.match(text,/NEXT_STAGE inicia preparación.*no autoriza aplicación ni outreach/is);
});

test('README keeps the tab guide current and Communities small and manual', () => {
  const text = readmeText();
  for (const tab of ['README','TODAY','PIPELINE','RESEARCH','APPLICATIONS','CONTACTS','FOLLOW_UPS','COMMUNITIES','SETTINGS','SOURCE_METRICS']) assert.match(text,new RegExp(tab,'i'));
  assert.match(text,/TODAY.*Única bandeja diaria/is);
  assert.match(text,/APPLICATIONS.*outreach status.*follow-up.*outcomes/is);
  assert.match(text,/SETTINGS.*Candidate Gmail.*LinkedIn Outreach readiness/is);
});

test('schedule values remain explicit strings rather than time serials', () => {
  const rows = values();
  assert.match(rows[113][0],/15:30 Browser Research.*16:00 Core.*17:00 Application Enrichment/);
  assert.match(rows[113][0],/Hoy · 5:00 PM.*29 ago 2026 · 5:00 PM/);
  const populated = rows.flat().filter(Boolean);
  assert.ok(populated.every(value => typeof value === 'string'));
  assert.ok(populated.every(value => !/^0\.\d+$/.test(value)));
});

test('README initialization remains idempotent after operator-first rewrite', async () => {
  const adapter = new MemorySheetsAdapter({ tabs: { README: [['legacy copy']] } });
  await adapter.initialize();
  const first = structuredClone(adapter.tabs.README);
  await adapter.initialize();
  assert.deepEqual(adapter.tabs.README, first);
  assert.deepEqual(first, values());
});

test('live README reprojection unmerges before writing the new operator layout', async () => {
  const sheets = ['README', ...CONTROL_PLANE_TABS].map((title, index) => ({ properties: { title, sheetId: index + 1, index, gridProperties: { rowCount: 1000, columnCount: 40 } }, conditionalFormats: [] }));
  const calls = [];
  const fetchImpl = async (url, options = {}) => { calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null }); return { ok: true, json: async () => options.method ? {} : { sheets } }; };
  const adapter = new GoogleSheetsApiAdapter({ spreadsheetId: 'fixture', tokenProvider: { getAccessToken: async () => 'fixture-token' }, fetchImpl });
  await adapter.initialize();
  const preUnmerge = calls.findIndex(call => call.body?.requests?.length === 1 && call.body.requests[0].unmergeCells);
  const valueWrite = calls.findIndex(call => call.method === 'PUT' && call.url.includes('README') && call.url.includes('valueInputOption'));
  assert.ok(preUnmerge >= 0);
  assert.ok(valueWrite > preUnmerge);
});

test('live README reprojection expands legacy 100-row guides before writing V4.3', async () => {
  const sheets = ['README', ...CONTROL_PLANE_TABS].map((title, index) => ({ properties: { title, sheetId: index + 1, index, gridProperties: { rowCount: title === 'README' ? 100 : 1000, columnCount: 40 } }, conditionalFormats: [] }));
  const calls = [];
  let metadataReads = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (!options.method) metadataReads++;
    const expanded = metadataReads > 1 ? sheets.map(sheet => sheet.properties.title === 'README' ? { ...sheet, properties: { ...sheet.properties, gridProperties: { ...sheet.properties.gridProperties, rowCount: 130 } } } : sheet) : sheets;
    return { ok: true, json: async () => options.method ? {} : { sheets: expanded } };
  };
  const adapter = new GoogleSheetsApiAdapter({ spreadsheetId: 'fixture', tokenProvider: { getAccessToken: async () => 'fixture-token' }, fetchImpl });
  await adapter.initialize();
  const expand = calls.find(call => call.body?.requests?.some(request => request.appendDimension?.sheetId === 1 && request.appendDimension.dimension === 'ROWS'));
  const valueWrite = calls.findIndex(call => call.method === 'PUT' && call.url.includes('README') && call.url.includes('valueInputOption'));
  assert.equal(expand.body.requests.find(request => request.appendDimension?.sheetId === 1).appendDimension.length, 30);
  assert.ok(valueWrite > calls.indexOf(expand));
});

test('README formatting creates readable attention, safety, lifecycle and final-rule blocks', () => {
  const requests = buildReadmeFormatRequests({ properties: { sheetId: 42 } });
  const base = requests.find(request => request.repeatCell?.range?.startRowIndex === 0 && request.repeatCell?.range?.endRowIndex === 130);
  assert.ok(base);
  assert.ok(requests.some(request=>request.mergeCells?.range?.startRowIndex===76&&request.mergeCells.range.startColumnIndex===0&&request.mergeCells.range.endColumnIndex===2));
  assert.ok(requests.some(request=>request.repeatCell?.range?.startRowIndex===89&&request.repeatCell.range.startColumnIndex===4));
  assert.ok(requests.some(request=>request.repeatCell?.range?.startRowIndex===96));
  assert.ok(requests.some(request=>request.repeatCell?.range?.startRowIndex===118));
});

test('obsolete implementation-history language is absent from operator README', () => {
  const text = readmeText();
  assert.doesNotMatch(text, /V3A|V3B|V3C|V3D|V3E|V3F|event-driven|correlation/i);
  assert.doesNotMatch(text, /Attention Status/i);
  for(const stale of ['manual LinkedIn','candidate Gmail unavailable','recomienda una estrategia de aplicación/outreach'])assert.doesNotMatch(text,new RegExp(stale,'i'));
});

test('first two operator screens answer the V4.7 acceptance questions',()=>{const first=values().slice(0,52).flat().join('\n');for(const phrase of ['TODAY','READY','Pipeline Rank','HUMAN_CARRYOVER','APPROVE_TO_APPLY','APPROVE_OUTREACH','GMAIL','LINKEDIN','OTRAS RUTAS','aplica primero','APPLICATIONS'])assert.match(first,new RegExp(phrase,'i'));});

test('Apps Script menu remains exactly Sync Jobs and Sync Communities', () => {
  const source = readFileSync(new URL('../human-control-plane/apps-script/Code.gs', import.meta.url), 'utf8');
  for (const phrase of ['@OnlyCurrentDoc', 'Sync Jobs', 'Sync Communities']) assert.match(source, new RegExp(phrase));
  assert.equal((source.match(/\.addItem\('/g) || []).length, 2);
});
