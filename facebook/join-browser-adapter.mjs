import { createHash } from 'crypto';
import { assertObservedCommunityIdentity } from './join-policy.mjs';

const digest = value => createHash('sha256').update(String(value || '')).digest('hex');
const INSPECT_SCRIPT = `(()=>{const clean=x=>(x||'').replace(/\\s+/g,' ').trim();const controls=[...document.querySelectorAll('button,[role="button"]')].map((el,index)=>({index,text:clean(el.innerText||el.textContent),aria:clean(el.getAttribute('aria-label')),disabled:el.disabled||el.getAttribute('aria-disabled')==='true'}));const labels=controls.flatMap(x=>[x.text,x.aria]).filter(Boolean);const joined=labels.some(x=>/^(joined|member|miembro|miembro del grupo|te uniste)$/i.test(x));const pending=labels.some(x=>/^(pending|request sent|cancel request|solicitud enviada|pendiente|cancelar solicitud)$/i.test(x));const joinIndex=controls.find(x=>!x.disabled&&/^(join group|join|request to join|unirte al grupo|unirme al grupo|solicitar unirte)$/i.test(x.text||x.aria))?.index??-1;const dialogs=[...document.querySelectorAll('[role="dialog"]')];const prompt=dialogs.some(d=>d.querySelector('textarea,input[type="text"],input[type="checkbox"],select')||/group rules|reglas del grupo|answer|responde|pregunta|agree/i.test(d.innerText||''));const body=(document.body?.innerText||'').slice(0,12000);return JSON.stringify({url:location.href,title:document.title,labels:labels.slice(0,80),joined,pending,joinIndex,prompt,login:/\\/login|log into facebook|inicia sesi[oó]n/i.test(location.href+' '+body),challenge:/checkpoint|security check|unusual activity|captcha|verify you are human/i.test(location.href+' '+body),body:body.slice(0,2000)})})()`;

export class FacebookAuthorizedJoinBrowserAdapter {
  constructor({ managedAdapter, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    if (!managedAdapter) throw new TypeError('managedAdapter is required');
    this.adapter = managedAdapter; this.sleep = sleep;
  }

  async inspectAndMaybeJoin({ authorization, allowClick }) {
    return this.adapter.withOwnedTab(authorization.canonicalUrl, async ({ driver, tabId, domAvailable }) => {
      if (!domAvailable) return { outcome: 'VERIFICATION_UNKNOWN', clicked: false, reason: 'dom_unavailable', evidence: {} };
      const inspect = async () => JSON.parse(await driver.executeJavaScript(this.adapter.session.windowId, tabId, INSPECT_SCRIPT));
      const before = await inspect();
      try { assertObservedCommunityIdentity(authorization, before.url); } catch (error) { return { outcome: 'POLICY_BLOCKED', clicked: false, reason: error.message, evidence: this.evidence(before) }; }
      if (before.login) return { outcome: 'AUTH_REQUIRED', clicked: false, reason: 'facebook_login_required', evidence: this.evidence(before) };
      if (before.challenge) return { outcome: 'CHALLENGE', clicked: false, reason: 'facebook_challenge', evidence: this.evidence(before) };
      if (before.joined) return { outcome: 'ALREADY_JOINED', clicked: false, reason: 'membership_already_visible', evidence: this.evidence(before) };
      if (before.pending) return { outcome: 'JOIN_REQUESTED', clicked: false, reason: 'request_already_pending', evidence: this.evidence(before) };
      if (before.prompt) return { outcome: 'NEEDS_HUMAN', clicked: false, reason: 'questions_or_rules_require_human', evidence: this.evidence(before) };
      if (!allowClick) return { outcome: 'VERIFICATION_UNKNOWN', clicked: false, reason: 'authorization_already_consumed_no_terminal_state_visible', evidence: this.evidence(before) };
      if (before.joinIndex < 0) return { outcome: 'VERIFICATION_UNKNOWN', clicked: false, reason: 'exact_join_control_not_found', evidence: this.evidence(before) };
      const clicked = await driver.executeJavaScript(this.adapter.session.windowId, tabId, `(()=>{const clean=x=>(x||'').replace(/\\s+/g,' ').trim();const controls=[...document.querySelectorAll('button,[role="button"]')];const el=controls[${before.joinIndex}];if(!el)return 'missing';const label=clean(el.innerText||el.textContent||el.getAttribute('aria-label'));if(!/^(join group|join|request to join|unirte al grupo|unirme al grupo|solicitar unirte)$/i.test(label))return 'mismatch';el.click();return 'clicked'})()`);
      if (clicked !== 'clicked') return { outcome: 'POLICY_BLOCKED', clicked: false, reason: `join_control_${clicked}`, evidence: this.evidence(before) };
      await this.sleep(1800);
      const after = await inspect();
      if (after.login) return { outcome: 'AUTH_REQUIRED', clicked: true, reason: 'login_required_after_click', evidence: this.evidence(after) };
      if (after.challenge) return { outcome: 'CHALLENGE', clicked: true, reason: 'challenge_after_click', evidence: this.evidence(after) };
      if (after.prompt) return { outcome: 'NEEDS_HUMAN', clicked: true, reason: 'questions_or_rules_require_human', evidence: this.evidence(after) };
      if (after.pending) return { outcome: 'JOIN_REQUESTED', clicked: true, reason: 'request_pending', evidence: this.evidence(after) };
      if (after.joined) return { outcome: 'JOINED_CONFIRMED', clicked: true, reason: 'membership_visible', evidence: this.evidence(after) };
      return { outcome: 'VERIFICATION_UNKNOWN', clicked: true, reason: 'no_membership_state_observed_after_click', evidence: this.evidence(after) };
    });
  }

  evidence(page) {
    const membershipLabels=(page.labels||[]).filter(label=>/^(join group|join|request to join|joined|member|pending|request sent|cancel request|unirte al grupo|unirme al grupo|solicitar unirte|miembro|miembro del grupo|te uniste|solicitud enviada|pendiente|cancelar solicitud)$/i.test(label));
    return { url: page.url, title: page.title, membershipLabels:[...new Set(membershipLabels)].slice(0,12), bodyHash: digest(page.body), observedAt: new Date().toISOString() };
  }
}
