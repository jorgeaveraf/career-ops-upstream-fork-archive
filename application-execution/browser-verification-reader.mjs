import { createHash } from 'crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeJson = value => { try { return JSON.parse(value); } catch { return {}; } };
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

const MAILBOX_MODEL = `(()=>{const clean=v=>(v||'').replace(/\\s+/g,' ').trim();const body=clean(document.body?.innerText||'').slice(0,24000);const links=[...document.querySelectorAll('a[href]')].filter(e=>e.offsetWidth||e.offsetHeight||e.getClientRects().length).map(e=>({text:clean(e.innerText||e.getAttribute('aria-label')),href:e.href})).filter(x=>x.text&&x.href).slice(0,400);return JSON.stringify({url:location.href,title:document.title,body,links})})()`;
const CLICK_HREF = href => `(()=>{const target=${JSON.stringify(href)};const e=[...document.querySelectorAll('a[href]')].find(x=>x.href===target);if(!e)return JSON.stringify({clicked:false});e.click();return JSON.stringify({clicked:true})})()`;
const ENTER_VERIFICATION_CODE = code => `(()=>{const code=${JSON.stringify(code)};const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);const inputs=[...document.querySelectorAll('input')].filter(visible).filter(e=>!['hidden','password','email'].includes(String(e.type||'').toLowerCase()));const labeled=inputs.find(e=>/code|otp|verification|activation|confirm/i.test([e.name,e.id,e.placeholder,e.getAttribute('aria-label')].filter(Boolean).join(' ')));const digits=inputs.filter(e=>Number(e.maxLength)===1||/otp|code/i.test([e.name,e.id,e.className].join(' ')));const set=(e,v)=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;setter?setter.call(e,v):e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))};if(labeled)set(labeled,code);else if(digits.length>=code.length)digits.slice(0,code.length).forEach((e,i)=>set(e,code[i]));else return JSON.stringify({handled:false});const button=[...document.querySelectorAll('button,input[type="submit"],input[type="button"]')].filter(visible).find(e=>/verify|confirm|activate|submit|continue|verifica|confirmar|activar|continuar/i.test(e.innerText||e.value||e.getAttribute('aria-label')||''));if(button&&!button.disabled)button.click();return JSON.stringify({handled:true,submitted:!!button})})()`;
const APPLICATION_VERIFICATION_MODEL = `(()=>JSON.stringify({url:location.href,title:document.title,body:(document.body?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,12000),codeControls:[...document.querySelectorAll('input')].filter(e=>(e.offsetWidth||e.offsetHeight||e.getClientRects().length)&&(Number(e.maxLength)===1||/code|otp|verification|activation/i.test([e.name,e.id,e.placeholder,e.getAttribute('aria-label')].filter(Boolean).join(' ')))).length}))()`;

export class BrowserSignupVerificationReader {
  constructor({ driver, sleepFn = sleep, clock = () => new Date() } = {}) {
    if (!driver) throw new TypeError('browser driver is required');
    this.driver = driver; this.sleep = sleepFn; this.clock = clock;
  }

  verificationCode(body) { return body?.match(/(?:verification|activation|confirm(?:ation)?|verifica(?:tion)?)[^0-9]{0,80}([0-9]{6})/i)?.[1] || body?.match(/\b([0-9]{6})\b/)?.[1] || null; }

  async applyVerificationCode({ code, platform, recipient, requestedAt, executionId, browserContext }) {
    const applicationTabId=browserContext?.tabId,session=browserContext?.session;
    if(!applicationTabId||!session?.windowId)return{verified:false,code:'VERIFICATION_CODE_TARGET_UNAVAILABLE'};
    const entered=safeJson(await this.driver.executeJavaScript(session.windowId,applicationTabId,ENTER_VERIFICATION_CODE(code)));
    if(!entered.handled)return{verified:false,code:'VERIFICATION_CODE_FIELD_NOT_FOUND'};
    await this.sleep(1200);
    const verifiedPage=safeJson(await this.driver.executeJavaScript(session.windowId,applicationTabId,APPLICATION_VERIFICATION_MODEL));
    const confirmed=verifiedPage.codeControls===0&&!/invalid|incorrect|expired|inv[aá]lido|incorrecto|expirado|verify code|6-digit code|check your email/i.test(verifiedPage.body||'');
    if(!confirmed)return{verified:false,code:'VERIFICATION_UNKNOWN'};
    return{verified:true,evidence:{executionId,platform,recipient,requestedAt,observedAt:this.clock().toISOString(),verificationMethod:'EMAIL_CODE',confirmationUrl:verifiedPage.url}};
  }

  async findVerification({ platform, recipient, requestedAt, executionId, browserContext } = {}) {
    const session = browserContext?.session;
    if (!session?.windowId) return { verified: false, securityCode: 'SIGNUP_INBOX_UNAVAILABLE' };
    const platformTerm = String(platform || '').replace(/^www\./,'').split('.')[0];
    const query = `to:${recipient} newer_than:2d (${platformTerm} OR verify OR confirmation OR activation)`;
    const tabId = await this.driver.openTab(session.windowId, `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(recipient)}#search/${encodeURIComponent(query)}`);
    try {
      await this.sleep(1200);
      let page = safeJson(await this.driver.executeJavaScript(session.windowId, tabId, MAILBOX_MODEL));
      const identityVisible = clean(`${page.title} ${page.body}`).toLowerCase().includes(String(recipient).toLowerCase());
      if (!identityVisible) return { verified: false, securityCode: 'SIGNUP_INBOX_IDENTITY_MISMATCH' };
      for(let attempt=0;attempt<6;attempt++){
        const inboxCode=this.verificationCode(page.body);
        if(inboxCode)return this.applyVerificationCode({code:inboxCode,platform,recipient,requestedAt,executionId,browserContext});
        if(attempt<5){await this.sleep(600);page=safeJson(await this.driver.executeJavaScript(session.windowId,tabId,MAILBOX_MODEL));}
      }
      const message = page.links.find(link => /verify|confirm|activate|activation|verification|confirmaci[oó]n|verifica|c[oó]digo/i.test(link.text) && /mail\.google\.com/.test(link.href));
      if (!message) return { verified: false, code: 'VERIFICATION_EMAIL_NOT_FOUND' };
      await this.driver.executeJavaScript(session.windowId, tabId, CLICK_HREF(message.href)); await this.sleep(700);
      page = safeJson(await this.driver.executeJavaScript(session.windowId, tabId, MAILBOX_MODEL));
      const verificationLinks = page.links.filter(link => /verify|confirm|activate|complete registration|verifica|confirmar|activar/i.test(link.text) && /^https:/.test(link.href) && !/mail\.google\.com|googleusercontent\.com/.test(link.href));
      const code=this.verificationCode(page.body);
      if(verificationLinks.length===0&&code)return this.applyVerificationCode({code,platform,recipient,requestedAt,executionId,browserContext});
      if (verificationLinks.length !== 1) return { verified: false, code: verificationLinks.length ? 'VERIFICATION_LINK_AMBIGUOUS' : 'VERIFICATION_LINK_NOT_FOUND' };
      const selected = verificationLinks[0];
      await this.driver.executeJavaScript(session.windowId, tabId, CLICK_HREF(selected.href)); await this.sleep(1000);
      const verifiedPage = safeJson(await this.driver.executeJavaScript(session.windowId, tabId, MAILBOX_MODEL));
      const confirmed = /verified|email confirmed|account activated|verification complete|correo verificado|cuenta activada/i.test(`${verifiedPage.title} ${verifiedPage.body}`);
      if (!confirmed) return { verified: false, code: 'VERIFICATION_UNKNOWN' };
      return { verified: true, evidence: { executionId, platform, recipient, requestedAt, observedAt: this.clock().toISOString(), verificationUrlHash: createHash('sha256').update(selected.href).digest('hex'), confirmationUrl: verifiedPage.url } };
    } finally {
      await this.driver.closeTab(session.windowId, tabId).catch(() => {});
    }
  }
}
