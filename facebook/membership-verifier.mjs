import { createHash } from 'crypto';
import { assertObservedCommunityIdentity } from './join-policy.mjs';

export const FACEBOOK_MEMBERSHIP_VERIFIER_VERSION = 'v2c1-membership-1';
const digest = value => createHash('sha256').update(String(value || '')).digest('hex');

const INSPECT_MEMBERSHIP_SCRIPT = `(()=>{const clean=x=>(x||'').replace(/\\s+/g,' ').trim();const controls=[...document.querySelectorAll('button,[role="button"],a[role="button"],a[href]')].map(el=>({text:clean(el.innerText||el.textContent),aria:clean(el.getAttribute('aria-label')),href:el.href||'',disabled:el.disabled||el.getAttribute('aria-disabled')==='true'}));const labels=controls.flatMap(x=>[x.text,x.aria]).filter(Boolean);const joined=labels.some(x=>/^(eres miembro|joined|member|miembro|miembro del grupo|te uniste)$/i.test(x));const pending=labels.some(x=>/^(pending|request sent|join request sent|cancel request|solicitud enviada|solicitud pendiente|pendiente|cancelar solicitud)$/i.test(x));const joinVisible=controls.some(x=>!x.disabled&&/^(join group|join|request to join|unirte al grupo|unirme al grupo|solicitar unirte)$/i.test(x.text||x.aria));const dialogs=[...document.querySelectorAll('[role="dialog"]')];const needsHuman=dialogs.some(d=>d.querySelector('textarea,input[type="text"],input[type="checkbox"],select')||/group rules|reglas del grupo|answer|responde|pregunta|agree|aceptar reglas/i.test(d.innerText||''));const body=(document.body?.innerText||'').slice(0,12000);return JSON.stringify({url:location.href,title:document.title,labels:labels.slice(0,100),joined,pending,joinVisible,needsHuman,login:/\\/login|log into facebook|inicia sesi[oó]n/i.test(location.href+' '+body),challenge:/checkpoint|security check|unusual activity|captcha|verify you are human/i.test(location.href+' '+body),body:body.slice(0,2400)})})()`;
const INSPECT_JOINED_GROUPS_SCRIPT = `(()=>{const clean=x=>(x||'').replace(/\\s+/g,' ').trim();const groups=[...document.querySelectorAll('a[href*="/groups/"]')].map(a=>({url:a.href,name:clean(a.innerText||a.textContent||a.getAttribute('aria-label'))})).filter(x=>x.url);const body=(document.body?.innerText||'').slice(0,8000);return JSON.stringify({url:location.href,title:document.title,groups:groups.slice(0,500),login:/\\/login|log into facebook|inicia sesi[oó]n/i.test(location.href+' '+body),challenge:/checkpoint|security check|unusual activity|captcha|verify you are human/i.test(location.href+' '+body),body:body.slice(0,1200)})})()`;

function canonicalIdentity(value) {
  try { const url = new URL(value); const match = url.pathname.match(/^\/groups\/([^/?#]+)/i); return match ? decodeURIComponent(match[1]).toLowerCase() : ''; } catch { return ''; }
}
function membershipLabels(labels = []) { return [...new Set(labels.map(label=>String(label||'').trim()).filter(label => label.length<=100&&/^(eres miembro|joined|member|miembro|miembro del grupo|te uniste|pending|request sent|join request sent|solicitud enviada|solicitud pendiente|pendiente|cancel request|cancelar solicitud|join group|join|request to join|unirte al grupo|unirme al grupo|solicitar unirte)$/i.test(label)))].slice(0,16); }

export function classifyMembershipPage(page = {}) {
  if (page.login) return { finalState: 'AUTH_REQUIRED', reason: 'facebook_login_required' };
  if (page.challenge) return { finalState: 'CHALLENGE', reason: 'facebook_challenge' };
  if (page.joined) return { finalState: 'JOINED_CONFIRMED', reason: 'membership_signal_visible' };
  if (page.pending) return { finalState: 'JOIN_REQUESTED', reason: 'join_request_pending' };
  if (page.needsHuman) return { finalState: 'NEEDS_HUMAN', reason: 'questions_or_rules_require_human' };
  if (page.joinVisible) return { finalState: 'NOT_JOINED', reason: 'positive_join_control_visible' };
  return { finalState: 'VERIFICATION_UNKNOWN', reason: 'no_conclusive_membership_signal' };
}

export class FacebookMembershipVerifier {
  constructor({ managedAdapter, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    if (!managedAdapter) throw new TypeError('managedAdapter is required');
    this.adapter = managedAdapter; this.sleep = sleep;
  }

  evidence(page, source = 'group_page') {
    return { source, url: page.url, title: page.title, membershipLabels: membershipLabels(page.labels), bodyHash: digest(page.body), observedAt: new Date().toISOString(), verifierVersion: FACEBOOK_MEMBERSHIP_VERIFIER_VERSION };
  }

  async inspectStable(authorization) {
    return this.adapter.withOwnedTab(authorization.canonicalUrl, async ({ driver, tabId, domAvailable }) => {
      if (!domAvailable) return { page: {}, result: { finalState: 'VERIFICATION_UNKNOWN', reason: 'dom_unavailable' } };
      let page; let previousHash = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        page = JSON.parse(await driver.executeJavaScript(this.adapter.session.windowId, tabId, INSPECT_MEMBERSHIP_SCRIPT));
        assertObservedCommunityIdentity(authorization, page.url);
        const hash = digest(JSON.stringify({ labels: page.labels, joined: page.joined, pending: page.pending, joinVisible: page.joinVisible, needsHuman: page.needsHuman, login: page.login, challenge: page.challenge }));
        if (hash === previousHash) break;
        previousHash = hash;
        if (attempt < 2) await this.sleep(900);
      }
      return { page, result: classifyMembershipPage(page) };
    });
  }

  async joinedGroupsFallback(authorization) {
    return this.adapter.withOwnedTab('https://www.facebook.com/groups/joins/', async ({ driver, tabId, domAvailable }) => {
      if (!domAvailable) return { matched: false, conclusive: false, evidence: { source: 'groups_joins', reason: 'dom_unavailable' } };
      const page = JSON.parse(await driver.executeJavaScript(this.adapter.session.windowId, tabId, INSPECT_JOINED_GROUPS_SCRIPT));
      const target = canonicalIdentity(authorization.canonicalUrl);
      const match = (page.groups || []).find(group => canonicalIdentity(group.url) === target);
      return { matched: Boolean(match), conclusive: !page.login && !page.challenge, authRequired: page.login, challenge: page.challenge, evidence: { source: 'groups_joins', url: page.url, title: page.title, matchedIdentity: match ? target : null, matchedName: match?.name || null, observedGroupCount: (page.groups || []).length, bodyHash: digest(page.body), observedAt: new Date().toISOString(), verifierVersion: FACEBOOK_MEMBERSHIP_VERIFIER_VERSION } };
    });
  }

  async verify({ authorization }) {
    const direct = await this.inspectStable(authorization);
    const evidence = [this.evidence(direct.page)];
    if (['JOINED_CONFIRMED','JOIN_REQUESTED','NEEDS_HUMAN','AUTH_REQUIRED','CHALLENGE'].includes(direct.result.finalState)) return { ...direct.result, evidence };
    const fallback = await this.joinedGroupsFallback(authorization); evidence.push(fallback.evidence);
    if (fallback.authRequired) return { finalState: 'AUTH_REQUIRED', reason: 'groups_joins_login_required', evidence };
    if (fallback.challenge) return { finalState: 'CHALLENGE', reason: 'groups_joins_challenge', evidence };
    if (fallback.matched) return { finalState: 'JOINED_CONFIRMED', reason: 'membership_matched_in_groups_joins', evidence };
    return { ...direct.result, evidence };
  }
}
