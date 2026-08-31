import { classifyBrowserPage, semanticSuccess, terminalOutcomeForClassification } from './semantic-browser-contracts.mjs';
import { BROWSER_RUNBOOK_VERSION } from './source-runbooks.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const keyFor = record => String(record.externalId || record.canonicalUrl || record.url || '').trim();

export class BrowserRunbookExecutor {
  constructor({ clock = () => new Date(), sleep = wait } = {}) { this.clock = clock; this.sleep = sleep; }

  async execute({ task, runbook, driver }) {
    const started = this.clock(); const taskDeadline = started.getTime() + runbook.maxTaskMs; const states = []; const phases = {}; const warnings = []; const errors = [];
    const telemetry = { taskId: task.id, source: task.source, strategyId: task.strategyId || runbook.id,
      plannedUrl: task.url, expectedSelector: runbook.selectors.card.join(', '), selectorsVersion: runbook.selectorsVersion,
      runbookVersion: BROWSER_RUNBOOK_VERSION, readinessMs: runbook.readinessMs,
      states, scrollPasses: [], warnings, errors, authObserved: false };
    const enter = state => { states.push({ state, at: this.clock().toISOString() }); };
    const phase = async (name, fn) => { const at = this.clock(); try { return await fn(); } finally { phases[name] = Math.max(0, this.clock() - at); } };
    let handle; let snapshot; let outcome = 'EXTRACTION_FAILED'; let records = [];
    enter('PLANNED');
    try {
      enter('NAVIGATING');
      try { handle = await phase('navigation', () => driver.open(task.url, { timeoutMs: runbook.navigationMs })); }
      catch (error) { outcome = error.code === 'BROWSER_ACTION_DENIED' ? 'POLICY_BLOCKED' : 'NAVIGATION_TIMEOUT'; throw error; }
      const readinessDeadline = Math.min(this.clock().getTime() + runbook.readinessMs, taskDeadline);
      let waitingEntered = false;
      do {
        snapshot = await phase('classification', () => driver.snapshot(handle, { task, runbook }));
        telemetry.finalUrl = snapshot.url; telemetry.title = snapshot.title;
        telemetry.pageClassification = classifyBrowserPage(snapshot, runbook);
        telemetry.authObserved = ['LOGIN', 'CHALLENGE', 'CAPTCHA'].includes(telemetry.pageClassification);
        enter('PAGE_CLASSIFIED');
        const terminal = terminalOutcomeForClassification(telemetry.pageClassification);
        if (terminal) { outcome = terminal; break; }
        if ((snapshot.records || []).length || snapshot.cardCount > 0) { enter('RESULTS_READY'); break; }
        if (!waitingEntered) { enter('RESULTS_WAITING'); waitingEntered = true; }
        if (this.clock().getTime() >= readinessDeadline) {
          if (this.clock().getTime() >= taskDeadline) warnings.push('TASK_BUDGET_EXHAUSTED');
          outcome = snapshot.domReady && Number(snapshot.selectorMatchCount || 0) === 0 ? 'SELECTOR_CHANGED' : 'RESULTS_TIMEOUT'; break;
        }
        await this.sleep(runbook.pollMs);
      } while (true);

      if (!outcome.startsWith('SUCCESS') && !['SELECTOR_CHANGED', 'RESULTS_TIMEOUT'].includes(outcome) && telemetry.pageClassification === 'EXPECTED_RESULTS') outcome = 'SUCCESS_RESULTS';
      if (telemetry.pageClassification === 'EXPECTED_RESULTS') {
        if (runbook.confirmQuery && snapshot.queryConfirmed === false) { outcome = 'WRONG_PAGE'; warnings.push('QUERY_NOT_CONFIRMED'); }
        else {
          enter('SCROLLING');
          const seen = new Map(); let stable = 0; const scrollStarted = this.clock();
          const absorb = current => { for (const record of current.records || []) { const key = keyFor(record); if (key) seen.set(key, record); } };
          absorb(snapshot);
          for (let pass = 1; pass <= runbook.maxScrollPasses && (seen.size < runbook.maxCards || (runbook.requireScrollForSuccess && pass === 1)) && this.clock() - scrollStarted < runbook.maxScrollMs && this.clock().getTime() < taskDeadline; pass++) {
            const before = seen.size; await driver.scroll(handle, { pass, task, runbook });
            snapshot = await driver.snapshot(handle, { task, runbook }); absorb(snapshot);
            const added = seen.size - before; stable = added === 0 ? stable + 1 : 0;
            telemetry.scrollPasses.push({ pass, cardsBefore: before, cardsAfter: seen.size, uniqueAdded: added,
              fingerprint: snapshot.resultFingerprint || '', at: this.clock().toISOString() });
            if (stable >= runbook.stablePasses) break;
          }
          records = [...seen.values()].slice(0, runbook.maxCards);
          if (this.clock().getTime() >= taskDeadline) warnings.push('TASK_BUDGET_EXHAUSTED');
          if (runbook.requireScrollForSuccess && telemetry.scrollPasses.length === 0 && records.length) {
            outcome = 'EXTRACTION_FAILED'; warnings.push('FEED_SCROLL_REQUIRED');
          } else outcome = records.length ? 'SUCCESS_RESULTS' : 'SUCCESS_EMPTY';
          enter('EXTRACTING');
          if (records.length && runbook.maxDetails > 0 && typeof driver.extractDetails === 'function') {
            const detailCount = Math.min(records.length, runbook.maxDetails);
            for (let index = 0; index < detailCount; index++) {
              try { records[index] = { ...records[index], ...(await driver.extractDetails(handle, records[index], { task, runbook })) }; }
              catch (error) { warnings.push(`DETAIL_${index + 1}_FAILED:${error.code || error.message}`); }
            }
            telemetry.detailPagesOpened = detailCount;
          }
          enter('VALIDATING');
        }
      }
    } catch (error) { errors.push({ code: error.code || outcome, message: error.message }); }
    finally { if (handle) try { await driver.close(handle); } catch (error) { warnings.push(`CLEANUP_FAILED:${error.message}`); } }
    enter('COMPLETE');
    telemetry.phaseDurationsMs = phases; telemetry.timeToFirstResultsMs = states.find(item => item.state === 'RESULTS_READY') ? Math.max(0, new Date(states.find(item => item.state === 'RESULTS_READY').at) - started) : null;
    telemetry.cardsSeen = Math.max(snapshot?.cardCount || 0, records.length); telemetry.uniqueCards = records.length;
    telemetry.extractedRecords = records.length; telemetry.duplicates = Math.max(0, telemetry.cardsSeen - records.length);
    telemetry.descriptionsAcquired = records.filter(item => String(item.fullDescription || item.description || '').trim().length >= 200).length;
    telemetry.outcome = outcome; telemetry.startedAt = started.toISOString(); telemetry.finishedAt = this.clock().toISOString();
    telemetry.durationMs = Math.max(0, new Date(telemetry.finishedAt) - started);
    return { outcome, ok: semanticSuccess(outcome), records, telemetry };
  }
}
