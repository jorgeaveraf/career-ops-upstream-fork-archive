import { assertResearchActionAllowed } from '../research/browser-policy.mjs';
import { canonicalFacebookUrl } from './extraction.mjs';

const classify = payload => {
  const all=`${payload.url}\n${payload.title}\n${payload.text}`.toLowerCase();
  if (/captcha|verify you are human/.test(all)) return 'CAPTCHA';
  if (/checkpoint|security check|unusual activity/.test(all)) return 'CHALLENGE';
  if (/\/login|log into facebook|inicia sesi[oó]n/.test(all)) return 'LOGIN_PAGE';
  if (/\/search\/groups/.test(payload.url)) return 'SEARCH_RESULTS';
  if (/\/groups\//.test(payload.url) && /private group|grupo privado/.test(all) && !payload.joined) return 'GROUP_PRIVATE_NOT_MEMBER';
  if (/\/groups\//.test(payload.url) && /private group|grupo privado/.test(all) && payload.joined) return 'GROUP_PRIVATE_MEMBER';
  if (/\/groups\//.test(payload.url)) return 'GROUP_PAGE';
  return 'UNEXPECTED_PAGE';
};
const outcome = classification => ({CAPTCHA:'CAPTCHA',CHALLENGE:'CHALLENGE',LOGIN_PAGE:'AUTH_REQUIRED',UNEXPECTED_PAGE:'WRONG_PAGE'})[classification] || 'SUCCESS_RESULTS';

export class FacebookReadOnlyBrowserAdapter {
  constructor({ managedAdapter, clock=()=>new Date(), sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)) }={}) { if(!managedAdapter) throw new TypeError('managedAdapter is required'); this.adapter=managedAdapter; this.clock=clock; this.sleep=sleep; }
  async searchGroups({ query, maxScrollPasses=3, maxCandidates=30 }={}) {
    assertResearchActionAllowed('search'); const url=`https://www.facebook.com/search/groups/?q=${encodeURIComponent(query)}`;
    return this.adapter.withOwnedTab(url, async ({driver,tabId,domAvailable})=>{
      if(!domAvailable) return {outcome:'SELECTOR_CHANGED',classification:'UNEXPECTED_PAGE',groups:[],url};
      const seen=new Map(); let stable=0;
      for(let pass=0;pass<=maxScrollPasses;pass++) {
        const raw=await driver.executeJavaScript(this.adapter.session.windowId,tabId,`(()=>{const text=(document.body?.innerText||'').slice(0,30000);const links=[...document.querySelectorAll('a[href*="/groups/"]')].map(a=>({url:a.href,name:(a.innerText||a.textContent||'').replace(/\\s+/g,' ').trim()})).filter(x=>x.name);return JSON.stringify({url:location.href,title:document.title,text,groups:links})})()`);
        const page=JSON.parse(raw); const before=seen.size;
        for(const group of page.groups) { const canonical=canonicalFacebookUrl(group.url); let path='';try{path=new URL(canonical).pathname;}catch{} if(/^\/groups\/[^/]+\/$/.test(path)&&!seen.has(canonical)) seen.set(canonical,{...group,url:canonical}); }
        stable=seen.size===before?stable+1:0; if(seen.size>=maxCandidates||stable>=2) { const classification=classify({...page,groups:[...seen.values()]}); return {outcome:seen.size?'SUCCESS_RESULTS':'SUCCESS_EMPTY',classification,groups:[...seen.values()].slice(0,maxCandidates),url:page.url}; }
        if(pass<maxScrollPasses){ assertResearchActionAllowed('scroll'); await driver.executeJavaScript(this.adapter.session.windowId,tabId,'window.scrollBy(0,Math.max(window.innerHeight*0.9,700));"ok"'); await this.sleep(900); }
      }
      return {outcome:seen.size?'SUCCESS_RESULTS':'SUCCESS_EMPTY',classification:seen.size?'SEARCH_RESULTS':'UNEXPECTED_PAGE',groups:[...seen.values()].slice(0,maxCandidates),url};
    });
  }
  async inspectGroup(group) {
    assertResearchActionAllowed('open_result');
    return this.adapter.withOwnedTab(group.url,async({driver,tabId,domAvailable})=>{
      if(!domAvailable)return{outcome:'SELECTOR_CHANGED',classification:'UNEXPECTED_PAGE',group};
      const raw=await driver.executeJavaScript(this.adapter.session.windowId,tabId,`(()=>{const text=(document.body?.innerText||'').slice(0,30000);const buttons=[...document.querySelectorAll('[role="button"],button')].map(x=>(x.innerText||x.textContent||'').trim());const joined=buttons.some(x=>/^(joined|member|miembro|te uniste)$/i.test(x));const name=(document.querySelector('h1')?.innerText||document.title||'').replace(/\\s+/g,' ').trim();return JSON.stringify({url:location.href,title:document.title,text,name,joined,buttons})})()`);
      const page=JSON.parse(raw); const classification=classify(page); const members=page.text.match(/([\d,.]+\s*(?:K|M|B|mil|millones?)?)\s+(?:members|miembros)/i)?.[1]||'';
      const visibleName=page.text.match(/([^\n]{2,150})\n(?:Grupo\s*[-·]\s*)?(?:Público|Privado|Public|Private)(?:\n|$)/i)?.[1]?.trim();
      return {outcome:outcome(classification),classification,group:{...group,url:canonicalFacebookUrl(page.url)||group.url,name:visibleName||page.name||group.name,description:page.text.slice(0,5000),visibility:/private group|grupo\s*[-·]?\s*privado|\nprivado\n/i.test(page.text)?'PRIVATE':/public group|grupo\s*[-·]?\s*público|\npúblico\n/i.test(page.text)?'PUBLIC':'UNKNOWN',membershipObserved:page.joined,memberCountText:members,recentActivity:/new posts?|publicaciones nuevas|posts? (?:a|per) (?:day|week)/i.test(page.text)}};
    });
  }
  async readRecentPosts(community,{maxScrollPasses=3,maxPosts=25}={}) {
    assertResearchActionAllowed('read');
    return this.adapter.withOwnedTab(community.canonicalUrl,async({driver,tabId,domAvailable})=>{
      if(!domAvailable)return{outcome:'SELECTOR_CHANGED',classification:'UNEXPECTED_PAGE',posts:[]};
      const seen=new Map(); let page;let stable=0;const started=Date.now();
      for(let pass=0;pass<=maxScrollPasses;pass++){
        const raw=await driver.executeJavaScript(this.adapter.session.windowId,tabId,`(()=>{const body=(document.body?.innerText||'').slice(0,30000);const buttons=[...document.querySelectorAll('[role="button"],button')].map(x=>((x.getAttribute('aria-label')||'')+' '+(x.innerText||x.textContent||'')).trim());const joined=buttons.some(x=>/\\b(joined|member|miembro|eres miembro|te uniste)\\b/i.test(x))||/\\b(eres miembro|you are a member)\\b/i.test(body);const posts=[...document.querySelectorAll('[role="article"]')].slice(0,${maxPosts}).map((p,i)=>{const links=[...p.querySelectorAll('a[href]')].map(a=>a.href);const permalink=links.find(x=>/\\/(?:posts|permalink)\\//.test(x))||'';const images=[...p.querySelectorAll('img[src]')].map(x=>x.src).slice(0,10);const time=p.querySelector('time')?.dateTime||p.querySelector('abbr[data-utime]')?.getAttribute('data-utime')||'';const postedAt=/^\\d+$/.test(time)?new Date(Number(time)*1000).toISOString():time;return{url:permalink,externalId:(permalink.match(/\\/(?:posts|permalink)\\/(\\d+)/)||[])[1]||'',author:(p.querySelector('h2,h3,h4,strong')?.textContent||'').trim(),postedAt,text:(p.innerText||'').slice(0,10000),links,images,index:i}});return JSON.stringify({url:location.href,title:document.title,text:body,joined,posts})})()`);
        page=JSON.parse(raw);const observed=canonicalFacebookUrl(page.url);if(observed!==canonicalFacebookUrl(community.canonicalUrl))return{outcome:'WRONG_PAGE',classification:'UNEXPECTED_PAGE',posts:[],membershipObserved:false};const before=seen.size;for(const post of page.posts){const key=post.externalId||post.url||`${post.author}:${post.index}:${post.text.slice(0,200)}`;if(key)seen.set(key,post);}stable=seen.size===before?stable+1:0;if(seen.size>=maxPosts||pass===maxScrollPasses||stable>=2||Date.now()-started>=90000)break;
        assertResearchActionAllowed('scroll');await driver.executeJavaScript(this.adapter.session.windowId,tabId,'window.scrollBy(0,Math.max(window.innerHeight*0.9,700));"ok"');await this.sleep(900);
      }
      const classification=classify(page||{}); return {outcome:outcome(classification),classification,posts:[...seen.values()].slice(0,maxPosts),membershipObserved:Boolean(page?.joined)};
    });
  }
}
