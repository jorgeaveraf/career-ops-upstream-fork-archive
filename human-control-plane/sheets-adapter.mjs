import { CONTROL_PLANE_TABS, HUMAN_FIELD_VALIDATION, OPTIONAL_CONTROL_PLANE_TABS, TAB_CONTRACTS } from './contracts.mjs';
import { buildManagedTabFormatRequests, buildReadmeFormatRequests, buildReadmeValues, buildTabOrderRequests, buildTodayContextualValidationRequests, buildTodayPresentationMatrix, stripTodayPresentationMatrix, README_TAB, WORKBOOK_TAB_ORDER } from './sheet-ux.mjs';

const README_MIN_ROWS = 130;
export const SHEET_UX_VERSION = '4.5';

const scalar = value => value == null ? '' : String(value);
const cell = (matrix, row, column) => scalar(matrix?.[row]?.[column]);

/** Return the smallest changed horizontal ranges. Empty cells are explicit so
 * rows removed from a projection are cleared without clearing the whole tab. */
export function diffMatrices(current = [], desired = [], width = null) {
  const rowCount = Math.max(current.length, desired.length), columnCount = Math.max(0, Number(width) || 0, ...current.map(row => row?.length || 0), ...desired.map(row => row?.length || 0)), changes = [];
  for (let row = 0; row < rowCount; row++) {
    let start = -1;
    for (let column = 0; column <= columnCount; column++) {
      const changed = column < columnCount && cell(current, row, column) !== cell(desired, row, column);
      if (changed && start < 0) start = column;
      if (!changed && start >= 0) { changes.push({ row, startColumn: start, endColumn: column, values: Array.from({ length: column - start }, (_, offset) => desired?.[row]?.[start + offset] ?? '') }); start = -1; }
    }
  }
  return changes;
}

function selectedTabs(optionalTabs = [], includeCore = true) {
  const optional = optionalTabs.filter(name => OPTIONAL_CONTROL_PLANE_TABS.includes(name));
  return [...new Set([...(includeCore ? CONTROL_PLANE_TABS : []), ...optional])];
}

export class SheetsAdapter {
  async initialize(_contracts) { throw new Error('initialize is not implemented'); }
  async readTab(_name) { throw new Error('readTab is not implemented'); }
  async writeTab(_name, _matrix, _options) { throw new Error('writeTab is not implemented'); }
}

export class MemorySheetsAdapter extends SheetsAdapter {
  constructor({ tabs = {}, layoutVersion = null } = {}) { super(); this.tabs = structuredClone(tabs); this.initializeCalls = 0; this.layoutVersion = layoutVersion; this.mutations = { data: 0, structural: 0 }; }
  async initialize({ optionalTabs = [], includeCore = true } = {}) {
    this.initializeCalls++;
    const current = this.layoutVersion === SHEET_UX_VERSION;
    if (includeCore && (!current || !this.tabs[README_TAB])) this.tabs[README_TAB] = buildReadmeValues();
    for (const name of selectedTabs(optionalTabs, includeCore)) this.tabs[name] ||= [TAB_CONTRACTS[name].columns];
    this.tabs = Object.fromEntries([
      ...WORKBOOK_TAB_ORDER.filter(name => Object.hasOwn(this.tabs, name)).map(name => [name, this.tabs[name]]),
      ...Object.entries(this.tabs).filter(([name]) => !WORKBOOK_TAB_ORDER.includes(name)),
    ]);
    const structuralMutations = current ? 0 : 1; this.mutations.structural += structuralMutations; this.layoutVersion = SHEET_UX_VERSION;
    return { tabs: Object.keys(this.tabs), layoutVersion: this.layoutVersion, structuralMutations };
  }
  async readTab(name) { return structuredClone(this.tabs[name] || []); }
  async writeTab(name, matrix, _options) { const changes=diffMatrices(this.tabs[name]||[],matrix,TAB_CONTRACTS[name].columns.length);if(changes.length)this.tabs[name]=structuredClone(matrix);this.mutations.data+=changes.length;return{dataMutations:changes.length,structuralMutations:0,ranges:changes.length}; }
}

export class GoogleSheetsApiAdapter extends SheetsAdapter {
  constructor({ spreadsheetId, tokenProvider, fetchImpl = globalThis.fetch } = {}) {
    super();
    if (!spreadsheetId) throw new TypeError('spreadsheetId is required');
    if (!tokenProvider || typeof tokenProvider.getAccessToken !== 'function') throw new TypeError('renewable Google OAuth token provider is required');
    this.spreadsheetId = spreadsheetId; this.tokenProvider = tokenProvider; this.fetch = fetchImpl;
    this.base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
    this.rawReads = new Map();
  }
  async request(url, options = {}) {
    const accessToken = await this.tokenProvider.getAccessToken();
    const response = await this.fetch(url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Google Sheets API ${response.status}: ${body.error?.message || response.statusText}`);
    return body;
  }
  async metadata() { return this.request(`${this.base}?fields=sheets(properties,conditionalFormats,basicFilter),developerMetadata(metadataId,metadataKey,metadataValue,visibility)`); }
  async initialize({ optionalTabs = [], includeCore = true } = {}) {
    const tabs = selectedTabs(optionalTabs, includeCore);
    const metadata = await this.metadata();
    const existing = new Map((metadata.sheets || []).map(sheet => [sheet.properties.title, sheet.properties]));
    const requests = [], versionEntry=(metadata.developerMetadata||[]).find(item=>item.metadataKey==='CAREER_OPS_SHEET_UX_VERSION'),layoutCurrent=versionEntry?.metadataValue===SHEET_UX_VERSION;
    if (includeCore && !existing.has(README_TAB)) {
      requests.push({ addSheet: { properties: { title: README_TAB, gridProperties: { rowCount: README_MIN_ROWS, columnCount: 8 } } } });
    } else if (includeCore && (existing.get(README_TAB).gridProperties?.rowCount || 0) < README_MIN_ROWS) {
      requests.push({ appendDimension: { sheetId: existing.get(README_TAB).sheetId, dimension: 'ROWS', length: README_MIN_ROWS - existing.get(README_TAB).gridProperties.rowCount } });
    }
    for (const name of tabs) {
      if (!existing.has(name)) requests.push({ addSheet: { properties: { title: name, gridProperties: { rowCount: 1000, columnCount: Math.max(12, TAB_CONTRACTS[name].columns.length) } } } });
      else if ((existing.get(name).gridProperties?.columnCount || 0) < TAB_CONTRACTS[name].columns.length) requests.push({ appendDimension: { sheetId: existing.get(name).sheetId, dimension: 'COLUMNS', length: TAB_CONTRACTS[name].columns.length - existing.get(name).gridProperties.columnCount } });
    }
    if (requests.length) await this.request(`${this.base}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
    const current = await this.metadata();
    const readme = (current.sheets || []).find(sheet => sheet.properties.title === README_TAB);
    const structuralRequired=!layoutCurrent||requests.length>0;
    if (includeCore && structuralRequired) {
      // Existing README layouts contain merged cells. Unmerge before writing so values destined
      // for the new card columns are not discarded by Sheets while the old merge topology exists.
      if (readme) await this.request(`${this.base}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [{ unmergeCells: { range: { sheetId: readme.properties.sheetId, startRowIndex: 0, endRowIndex: README_MIN_ROWS, startColumnIndex: 0, endColumnIndex: 8 } } }] }) });
      const values = buildReadmeValues(); const range = `'${README_TAB}'!A1:H${values.length}`;
      await this.request(`${this.base}/values/${encodeURIComponent(`'${README_TAB}'!A:Z`)}:clear`, { method: 'POST', body: '{}' });
      await this.request(`${this.base}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, { method: 'PUT', body: JSON.stringify({ range, majorDimension: 'ROWS', values }) });
    }
    const formatRequests = structuralRequired?buildTabOrderRequests(current.sheets || []):[];
    if (structuralRequired) {
      if (includeCore && readme) formatRequests.push(...buildReadmeFormatRequests(readme));
      for (const sheet of current.sheets || []) {
        const name = sheet.properties.title; const contract = TAB_CONTRACTS[name];
        if (!contract || !tabs.includes(name)) continue;
        formatRequests.push(...buildManagedTabFormatRequests(sheet));
      }
      if(versionEntry)formatRequests.push({updateDeveloperMetadata:{dataFilters:[{developerMetadataLookup:{metadataId:versionEntry.metadataId}}],developerMetadata:{metadataId:versionEntry.metadataId,metadataKey:'CAREER_OPS_SHEET_UX_VERSION',metadataValue:SHEET_UX_VERSION,visibility:'DOCUMENT'},fields:'metadataValue'}});
      else formatRequests.push({createDeveloperMetadata:{developerMetadata:{metadataKey:'CAREER_OPS_SHEET_UX_VERSION',metadataValue:SHEET_UX_VERSION,visibility:'DOCUMENT',location:{spreadsheet:true}}}});
    }
    if (formatRequests.length) await this.request(`${this.base}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: formatRequests }) });
    return { ...current, layoutVersion:SHEET_UX_VERSION, structuralMutations:requests.length+formatRequests.length };
  }
  async readTab(name) {
    const metadata = await this.metadata();
    const sheet = (metadata.sheets || []).find(item => item.properties.title === name);
    if (!sheet) return [];
    const rows = sheet.properties.gridProperties?.rowCount || 1000;
    const end = columnLetter(Math.max(TAB_CONTRACTS[name].columns.length, sheet.properties.gridProperties?.columnCount || 1));
    const range = encodeURIComponent(`'${name.replaceAll("'", "''")}'!A1:${end}${rows}`);
    // FORMULA is required for stable comparisons: formatted reads turn a
    // HYPERLINK formula into its label and would otherwise rewrite it forever.
    const body = await this.request(`${this.base}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMULA`);
    const values = body.values || [];
    this.rawReads.set(name, structuredClone(values));
    return name === 'TODAY' ? stripTodayPresentationMatrix(values) : values;
  }
  async writeTab(name, matrix, { summary } = {}) {
    const width = TAB_CONTRACTS[name].columns.length;
    const values = name === 'TODAY' ? buildTodayPresentationMatrix(matrix, summary) : matrix;
    const current=this.rawReads.get(name)||[],changes=diffMatrices(current,values,width);
    if(!changes.length)return{dataMutations:0,structuralMutations:0,ranges:0};
    const escaped=name.replaceAll("'", "''"),data=changes.map(change=>{const start=columnLetter(change.startColumn+1),end=columnLetter(change.endColumn);const range=`'${escaped}'!${start}${change.row+1}:${end}${change.row+1}`;return{range,majorDimension:'ROWS',values:[change.values]};});
    await this.request(`${this.base}/values:batchUpdate`, { method:'POST',body:JSON.stringify({valueInputOption:'USER_ENTERED',data}) });
    this.rawReads.set(name,structuredClone(values));
    let structuralMutations=0;
    if (name === 'TODAY') {
      const metadata = await this.metadata(); const sheet = (metadata.sheets || []).find(item => item.properties.title === name);
      const requests = sheet ? buildTodayContextualValidationRequests(sheet, matrix) : [];
      if (requests.length) { await this.request(`${this.base}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) }); structuralMutations=requests.length; }
    }
    return{dataMutations:changes.length,structuralMutations,ranges:changes.length};
  }
}

export function columnLetter(number) {
  let result = ''; let value = number;
  while (value > 0) { value--; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}
