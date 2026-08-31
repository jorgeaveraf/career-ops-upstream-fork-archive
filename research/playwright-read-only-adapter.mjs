import { chromium } from 'playwright';
import { assertResearchActionAllowed } from './browser-policy.mjs';
import { BrowserRunbookExecutor } from './browser-runbook-executor.mjs';
import { browserRunbookForTask } from './source-runbooks.mjs';

function assertHttpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('browser task URL must be HTTP(S)');
  return url.toString();
}

export class PlaywrightReadOnlyAdapter {
  constructor({ chromiumImpl = chromium, clock = () => new Date(), timeoutMs = 30_000, maxTextLength = 20_000, maxLinks = 200 } = {}) {
    this.chromium = chromiumImpl; this.clock = clock; this.timeoutMs = timeoutMs; this.maxTextLength = maxTextLength; this.maxLinks = maxLinks; this.context = null;
  }
  async start(session) {
    this.context = await this.chromium.launchPersistentContext(session.userDataDir, {
      channel: 'chrome', headless: false, acceptDownloads: false,
      args: [`--profile-directory=${session.profileDirectory}`, '--disable-sync'],
    });
    await this.context.route('**/*', route => {
      const method = route.request().method().toUpperCase();
      return ['GET', 'HEAD', 'OPTIONS'].includes(method) ? route.continue() : route.abort('blockedbyclient');
    });
    this.context.on('page', page => page.on('download', download => download.cancel()));
    return this;
  }
  async read({ task }) {
    assertResearchActionAllowed('read');
    if (!this.context) throw new Error('read-only browser adapter is not started');
    const url = assertHttpUrl(task.url); const page = await this.context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      const extracted = await page.evaluate(({ maxTextLength, maxLinks }) => ({
        title: document.title,
        text: (document.body?.innerText || '').slice(0, maxTextLength),
        links: [...document.querySelectorAll('a[href]')].slice(0, maxLinks).map(anchor => ({ text: (anchor.textContent || '').trim().slice(0, 300), url: anchor.href })),
      }), { maxTextLength: this.maxTextLength, maxLinks: this.maxLinks });
      const finalUrl = page.url();
      return {
        finalUrl, retrievedAt: this.clock().toISOString(), text: extracted.text,
        findings: [{
          entityType: 'PAGE', sourceUrl: finalUrl, confidence: 'low', extractionMethod: 'parsed',
          data: { taskKind: task.kind, title: extracted.title, query: task.query || '', company: task.company || '', links: extracted.links },
          evidence: [{ field: 'page_text', value: extracted.text, confidence: 'low', extractionMethod: 'parsed', sourceUrl: finalUrl }],
        }],
      };
    } finally { await page.close(); }
  }
  async discover({ task, sourceAdapter }) {
    assertResearchActionAllowed('search');
    if (!this.context) throw new Error('read-only browser adapter is not started');
    if (!sourceAdapter?.selectors) throw new TypeError('Browser Discovery source selectors are required');
    const url = assertHttpUrl(task.url); const page = await this.context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      const records = await page.evaluate(({ selectors, maxResults }) => {
        const text = (element, selector) => (selector ? element.querySelector(selector)?.textContent || '' : '');
        const cards = [...document.querySelectorAll(selectors.card)].slice(0, maxResults);
        return cards.map(card => {
          const link = card.querySelector(selectors.link);
          return {
            url: link?.href || '', title: text(card, selectors.title) || link?.textContent || '',
            company: text(card, selectors.company), location: text(card, selectors.location),
            modality: text(card, selectors.modality), description: text(card, selectors.description),
          };
        });
      }, { selectors: sourceAdapter.selectors, maxResults: task.maxResults || 10 });
      return { finalUrl: page.url(), retrievedAt: this.clock().toISOString(), records };
    } finally { await page.close(); }
  }
  async close() { if (this.context) await this.context.close(); this.context = null; }
}

// Compatibility alias. The policy is research_only; the adapter exposes no
// application, messaging, social, upload, or profile-mutation operations.
export class PlaywrightResearchAdapter extends PlaywrightReadOnlyAdapter {}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ManagedChromeResearchAdapter {
  constructor({ clock = () => new Date(), timeoutMs = 30_000, pollMs = 250, maxTextLength = 20_000, maxLinks = 200, sleep = wait } = {}) {
    this.clock = clock; this.timeoutMs = timeoutMs; this.pollMs = pollMs; this.maxTextLength = maxTextLength; this.maxLinks = maxLinks; this.sleep = sleep; this.session = null;
  }
  async start(session) {
    if (!session?.windowDriver || session.windowId == null) throw new TypeError('managed Career Ops browser window is required');
    this.session = session; return this;
  }
  async withOwnedTab(url, callback) {
    if (!this.session) throw new Error('managed browser adapter is not started');
    const driver = this.session.windowDriver; const tabId = await driver.openTab(this.session.windowId, assertHttpUrl(url));
    try {
      const deadline = Date.now() + this.timeoutMs;
      if (typeof driver.readTabMetadata === 'function') {
        let navigated = false;
        while (Date.now() < deadline) {
          const metadata = await driver.readTabMetadata(this.session.windowId, tabId);
          if (/^https?:/i.test(metadata.url) && metadata.loading !== true) { navigated = true; break; }
          await this.sleep(this.pollMs);
        }
        if (!navigated) {
          const error = new Error('managed Chrome tab did not finish HTTP(S) navigation before extraction');
          error.code = 'BROWSER_NAVIGATION_TIMEOUT'; throw error;
        }
      }
      let domAvailable = true;
      try {
        while (Date.now() < deadline) {
          const ready = await driver.executeJavaScript(this.session.windowId, tabId, 'document.readyState');
          if (ready === 'interactive' || ready === 'complete') break;
          await this.sleep(this.pollMs);
        }
      } catch (error) {
        if (error.code !== 'BROWSER_JAVASCRIPT_UNAVAILABLE' || typeof driver.readTabMetadata !== 'function') throw error;
        domAvailable = false;
        while (Date.now() < deadline) {
          const metadata = await driver.readTabMetadata(this.session.windowId, tabId);
          if (metadata.title && /^https?:/i.test(metadata.url)) break;
          await this.sleep(this.pollMs);
        }
      }
      return await callback({ driver, tabId, domAvailable });
    } finally { await driver.closeTab(this.session.windowId, tabId); }
  }
  async read({ task }) {
    assertResearchActionAllowed('read');
    return this.withOwnedTab(task.url, async ({ driver, tabId, domAvailable }) => {
      if (!domAvailable) {
        const metadata = await driver.readTabMetadata(this.session.windowId, tabId);
        return {
          finalUrl: metadata.url, retrievedAt: this.clock().toISOString(), text: '',
          findings: [{
            entityType: 'PAGE', sourceUrl: metadata.url, confidence: 'low', extractionMethod: 'direct',
            data: { taskKind: task.kind, title: metadata.title, query: task.query || '', company: task.company || '', links: [] },
            evidence: [{ field: 'page_title', value: metadata.title, confidence: 'low', extractionMethod: 'direct', sourceUrl: metadata.url }],
          }],
        };
      }
      const source = `JSON.stringify({title:document.title,text:(document.body?.innerText||'').slice(0,${this.maxTextLength}),links:[...document.querySelectorAll('a[href]')].slice(0,${this.maxLinks}).map(a=>({text:(a.textContent||'').trim().slice(0,300),url:a.href})),finalUrl:location.href})`;
      const extracted = JSON.parse(await driver.executeJavaScript(this.session.windowId, tabId, source));
      return {
        finalUrl: extracted.finalUrl, retrievedAt: this.clock().toISOString(), text: extracted.text,
        findings: [{
          entityType: 'PAGE', sourceUrl: extracted.finalUrl, confidence: 'low', extractionMethod: 'parsed',
          data: { taskKind: task.kind, title: extracted.title, query: task.query || '', company: task.company || '', links: extracted.links },
          evidence: [{ field: 'page_text', value: extracted.text, confidence: 'low', extractionMethod: 'parsed', sourceUrl: extracted.finalUrl }],
        }],
      };
    });
  }
  async discover({ task, sourceAdapter }) {
    assertResearchActionAllowed('search');
    if (!sourceAdapter?.selectors) throw new TypeError('Browser Discovery source selectors are required');
    const runbook = browserRunbookForTask(task, {
      ...(task.executionBudget || {}),
      selectors: Object.fromEntries(Object.entries(sourceAdapter.selectors).map(([key, value]) => [key, Array.isArray(value) ? value : [value]])),
      maxCards: task.maxResults || 10, maxDetails: Math.min(task.maxDetails ?? 3, task.maxResults || 10),
    });
    return this.semanticDiscover({ task, runbook });
  }
  async semanticDiscover({ task, runbook = browserRunbookForTask(task) }) {
    assertResearchActionAllowed(task.mode === 'enrichment' ? 'extract_evidence' : 'search');
    if (!this.session) throw new Error('managed browser adapter is not started');
    const session = this.session; const driver = session.windowDriver; const windowId = session.windowId;
    const execute = async (tabId, source) => driver.executeJavaScript(windowId, tabId, source);
    const pageDriver = {
      open: async url => driver.openTab(windowId, assertHttpUrl(url)),
      snapshot: async (tabId, { task: currentTask, runbook: currentRunbook }) => {
        const metadata = await driver.readTabMetadata(windowId, tabId);
        if (metadata.loading) return { ...metadata, domReady: false, text: '', records: [], cardCount: 0, selectorMatchCount: 0 };
        const payload = JSON.stringify({ selectors: currentRunbook.selectors, query: currentTask.query || '', maxCards: currentRunbook.maxCards });
        const source = `(()=>{const p=${payload};const sels=k=>(p.selectors[k]||[]);const one=(e,k)=>{for(const s of sels(k)){try{const n=e.querySelector(s);if(n)return n}catch{}}return null};const all=k=>{const out=[];for(const s of sels(k)){try{for(const n of document.querySelectorAll(s))if(!out.includes(n))out.push(n)}catch{}}return out};const txt=(e,k)=>(one(e,k)?.textContent||'').replace(/\\s+/g,' ').trim();const cards=all('card').slice(0,p.maxCards);const records=cards.map(c=>{const a=one(c,'link');const url=a?.href||'';const id=c.getAttribute('data-jk')||(url.match(/\\/jobs\\/view\\/(\\d+)/)||[])[1]||(new URL(url||location.href)).searchParams.get('jk')||'';return{externalId:id,url,canonicalUrl:url,title:txt(c,'title')||(a?.textContent||'').trim(),company:txt(c,'company'),location:txt(c,'location'),modality:txt(c,'modality'),description:txt(c,'description')}});const q=p.query.toLowerCase().split(/\\s+/).filter(x=>x.length>2);const hay=(location.href+' '+document.title+' '+(document.body?.innerText||'').slice(0,5000)).toLowerCase();return JSON.stringify({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,20000),domReady:true,cardCount:cards.length,selectorMatchCount:cards.length,records,queryConfirmed:!q.length||q.some(x=>hay.includes(x)),resultFingerprint:records.map(r=>r.externalId||r.url).sort().join('|')})})()`;
        const extracted = JSON.parse(await execute(tabId, source));
        if (currentTask.mode === 'enrichment') {
          extracted.records = [{ url: extracted.url, canonicalUrl: extracted.url, title: currentTask.title || extracted.title,
            company: currentTask.company || '', location: '', description: extracted.text }];
          extracted.cardCount = 1; extracted.selectorMatchCount = 1;
        }
        return extracted;
      },
      scroll: async tabId => { assertResearchActionAllowed('scroll'); await execute(tabId, 'window.scrollBy(0,Math.max(window.innerHeight*0.85,600));"ok"'); await this.sleep(Math.min(1000, runbook.pollMs)); },
      extractDetails: async (_resultsTab, record) => {
        assertResearchActionAllowed('open_result');
        if (!record.url) return {};
        const detailTab = await driver.openTab(windowId, assertHttpUrl(record.url));
        try {
          const deadline = Date.now() + Math.min(runbook.navigationMs, 20_000);
          while (Date.now() < deadline) { const metadata = await driver.readTabMetadata(windowId, detailTab); if (!metadata.loading && /^https?:/i.test(metadata.url)) break; await this.sleep(this.pollMs); }
          const raw = await execute(detailTab, `(()=>{const t=s=>(document.querySelector(s)?.textContent||'').replace(/\\s+/g,' ').trim();const body=(document.querySelector('[data-testid*="description"],.jobs-description,.jobsearch-JobComponent-description,article,main')?.innerText||document.body?.innerText||'').replace(/\\s+/g,' ').trim();const apply=[...document.querySelectorAll('a[href]')].find(a=>/apply|aplicar|solicitar/i.test(a.textContent||''));return JSON.stringify({detailUrl:location.href,detailTitle:t('h1')||document.title,company:t('[data-testid*="company"],.jobs-unified-top-card__company-name,.jobsearch-InlineCompanyRating'),location:t('[data-testid*="location"],.jobs-unified-top-card__bullet,.jobsearch-JobInfoHeader-subtitle'),fullDescription:body.slice(0,30000),employmentType:(body.match(/\\b(full[- ]time|part[- ]time|contract(?:or)?|freelance|employee)\\b/i)||[])[1]||'',compensation:(body.match(/(?:USD|US\\$|MXN|\\$)\\s?[\\d,.]+(?:\\s*[-–]\\s*(?:USD|US\\$|MXN|\\$)?\\s?[\\d,.]+)?/i)||[])[0]||'',postedAt:t('time,[datetime],[data-testid*="date"]'),applicationPath:apply?.href||'',canonicalUrl:document.querySelector('link[rel="canonical"]')?.href||location.href,pageTitle:document.title})})()`);
          return JSON.parse(raw);
        } finally { await driver.closeTab(windowId, detailTab); }
      },
      close: tabId => driver.closeTab(windowId, tabId),
    };
    const result = await new BrowserRunbookExecutor({ clock: this.clock, sleep: this.sleep }).execute({ task, runbook, driver: pageDriver });
    return { ...result, finalUrl: result.telemetry.finalUrl, retrievedAt: result.telemetry.finishedAt };
  }
  async close() { this.session = null; }
}
