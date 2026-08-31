import { ACQUISITION_CONTRACT_VERSION, acquisitionFailure, acquisitionSuccess } from '../acquisition/contracts.mjs';
import { classifyAcquisitionError, normalizeProviderJob } from '../acquisition/provider-adapter.mjs';
import { BROWSER_RESEARCH_PROVENANCE_MODE } from './browser-policy.mjs';

export class BrowserJobSearchProvider {
  constructor({ sourceAdapter, browserAdapter, version = '1', clock = () => new Date() } = {}) {
    if (!sourceAdapter?.id || typeof sourceAdapter.parse !== 'function') throw new TypeError('Browser Discovery source adapter is required');
    if (!browserAdapter || typeof browserAdapter.discover !== 'function') throw new TypeError('read-only browser discovery adapter is required');
    this.sourceAdapter = sourceAdapter; this.browserAdapter = browserAdapter;
    this.id = `browser:${sourceAdapter.id}`; this.version = String(version); this.clock = clock;
  }

  async fetch(task, { session } = {}) {
    const page = await this.browserAdapter.discover({ task, session, sourceAdapter: this.sourceAdapter });
    return (page.records || []).map(record => this.sourceAdapter.parse(record)).filter(Boolean);
  }

  async acquire(task, { session } = {}, { runId = '', retrievedAt = this.clock().toISOString() } = {}) {
    const attempts = [{
      providerId: this.id, providerVersion: this.version, runId, retrievedAt,
      endpoint: task.url, extractionMethod: 'parsed', adapterVersion: String(ACQUISITION_CONTRACT_VERSION),
      source: task.source, profile: session?.profile, mode: BROWSER_RESEARCH_PROVENANCE_MODE, actions: [],
    }];
    try {
      const page = await this.browserAdapter.discover({ task, session, sourceAdapter: this.sourceAdapter });
      if (page.outcome && !page.ok) {
        const error = new Error(`browser task ended with ${page.outcome}`); error.code = page.outcome; error.telemetry = page.telemetry; throw error;
      }
      const raw = (page.records || []).map(record => this.sourceAdapter.parse(record)).filter(Boolean);
      const warnings = []; const jobs = [];
      for (let index = 0; index < raw.length; index++) {
        try {
          jobs.push(normalizeProviderJob(raw[index], {
            providerId: this.id, providerVersion: this.version, runId,
            retrievedAt: page.retrievedAt || retrievedAt,
          }));
        } catch (error) { warnings.push(`row ${index} rejected: ${error.message}`); }
      }
      const invalid = Math.max(0, (page.records?.length || 0) - jobs.length);
      return { ...acquisitionSuccess(jobs, { attempts, warnings }), metrics: { discovered: page.records?.length || 0, valid: jobs.length,
        ...(invalid ? { invalid, rejectionReasons: { INVALID_SOURCE_RECORD: invalid } } : {}) }, telemetry: page.telemetry || null };
    } catch (error) {
      return { ...acquisitionFailure(classifyAcquisitionError(error, this.id), { attempts }), metrics: { discovered: 0, valid: 0 }, telemetry: error.telemetry || null };
    }
  }
}
