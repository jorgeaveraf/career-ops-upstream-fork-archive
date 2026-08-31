import path from'path';
import{BrowserSessionManager}from'../research/browser-session-manager.mjs';import{ManagedBrowserSession}from'../research/managed-browser-session.mjs';import{MacOsChromeWindowDriver}from'../research/macos-chrome-window-driver.mjs';
import{assertApplicationSubmitCapability,createApplicationSubmitCapability}from'./browser-capability.mjs';import{answerForField,loadCanonicalApplicationAnswers}from'./canonical-answers.mjs';import{selectApplicationChromeProfile}from'./browser-profile.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const INSPECT=`(()=>{const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);const label=e=>{const byFor=e.id&&document.querySelector('label[for="'+CSS.escape(e.id)+'"]');return(byFor?.innerText||e.closest('.ashby-application-form-field-entry')?.querySelector('label')?.innerText||e.closest('label')?.innerText||e.getAttribute('aria-label')||e.placeholder||'').replace(/\\s+/g,' ').trim()};const controls=[...document.querySelectorAll('input,textarea,select')].filter(e=>!e.closest('.ashby-application-form-input-yesno')&&((e.type||'').toLowerCase()==='file'||visible(e))&&!['hidden','submit','button','reset'].includes((e.type||'').toLowerCase())).map((e,i)=>({selector:e.id?'#'+CSS.escape(e.id):e.name?'[name="'+CSS.escape(e.name)+'"]':e.tagName.toLowerCase()+':nth-of-type('+(i+1)+')',name:e.name||e.id||'',label:label(e),type:(e.type||e.tagName).toLowerCase(),required:!!(e.required||e.getAttribute('aria-required')==='true'||e.closest('.ashby-application-form-field-entry')?.querySelector('label')?.className.includes('required')),autocomplete:e.autocomplete||'',options:e.tagName==='SELECT'?[...e.options].map(o=>o.text.trim()).filter(Boolean):[]}));const yesno=[...document.querySelectorAll('.ashby-application-form-input-yesno')].filter(visible).map(e=>{const entry=e.closest('[data-field-path]'),key=entry?.getAttribute('data-field-path')||e.querySelector('input')?.name||'';return{selector:key?'[data-field-path="'+CSS.escape(key)+'"] .ashby-application-form-input-yesno':'',name:key,label:label(e),type:'yesno',required:!!entry?.querySelector('label')?.className.includes('required'),autocomplete:'',options:['Yes','No']}});const fields=[...controls,...yesno];const body=(document.body?.innerText||'').slice(0,10000);const challenge=/captcha|verify you are human|unusual traffic|cloudflare|security check/i.test(body);const submit=[...document.querySelectorAll('button,input[type="submit"]')].find(e=>visible(e)&&!e.disabled&&/submit|apply|send application|enviar|aplicar|postular/i.test(e.innerText||e.value||e.getAttribute('aria-label')||''));return JSON.stringify({url:location.href,title:document.title,challenge,fields,submitAvailable:!!submit,bodySample:body.slice(0,2000)})})()`;

export class AtsChromeApplicationAdapter{
  constructor({env=process.env,driver=new MacOsChromeWindowDriver(),clock=()=>new Date(),answers=null,sessionManager=null,sleepFn=sleep}={}){this.env=env;this.driver=driver;this.clock=clock;this.sleep=sleepFn;this.answers=answers||loadCanonicalApplicationAnswers();this.selection=selectApplicationChromeProfile({profile:env.APPLICATION_BROWSER_PROFILE||'jorge',mode:env.APPLICATION_BROWSER_MODE||'application_submit',userDataDir:env.APPLICATION_BROWSER_USER_DATA_DIR||env.BROWSER_USER_DATA_DIR});this.sessionManager=sessionManager||new ManagedBrowserSession({lockManager:new BrowserSessionManager({lockPath:env.APPLICATION_BROWSER_SESSION_LOCK||'data/browser/.careerops-application-session.lock'}),windowDriver:driver,sessionName:'career_ops_application',sessionKind:'managed_window'});this.active=new Map();}
  async inspect({plan,request,execution,authorization}) {
    const capability=createApplicationSubmitCapability({authorization,execution,now:this.clock()});
    assertApplicationSubmitCapability(capability,{authorization,plan,url:plan.primaryTarget,now:this.clock()});
    const session=await this.sessionManager.acquire(this.selection);
    try {
      const tabId=await this.driver.openTab(session.windowId,plan.primaryTarget);
      for(let i=0;i<100;i++){
        const meta=await this.driver.readTabMetadata(session.windowId,tabId);
        if(!meta.loading)break;
        await this.sleep(100);
      }
      let raw=null;
      for(let i=0;i<50;i++){
        raw=JSON.parse(await this.driver.executeJavaScript(session.windowId,tabId,INSPECT));
        if(raw.challenge||raw.submitAvailable)break;
        await this.sleep(200);
      }
      if(new URL(raw.url).origin!==capability.allowedOrigin)throw new Error('ATS redirected outside authorized domain');
      const normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
      const supplied=request?.humanAnswers||[];
      const fields=raw.fields.map(field=>{
        const stored=supplied.find(item=>item.normalizedField===normalize(field.label||field.name)||normalize(item.question)===normalize(field.label||field.name));
        const answer=stored?{value:stored.answer}:answerForField(field,this.answers);
        return{...field,canonicalAnswer:Boolean(answer),answer};
      });
      const state={session,tabId,capability,authorization,plan,request,fields};
      this.active.set(execution.id,state);
      if(raw.challenge){
        await this.stop({execution});
        return{outcome:'CHALLENGE',url:raw.url,fields:[]};
      }
      if(!raw.submitAvailable){
        await this.stop({execution});
        return{outcome:'UNSUPPORTED',url:raw.url,fields:[{label:'Supported submit control',required:true,canonicalAnswer:false,context:'No safe submit control detected'}]};
      }
      return{outcome:'READY',url:raw.url,fields};
    }catch(error){
      await this.sessionManager.release(session).catch(()=>{});
      throw error;
    }
  }
  async submit({plan,request,execution,authorization}) {
    const state=this.active.get(execution.id);
    if(!state)throw new Error('application browser state is unavailable');
    assertApplicationSubmitCapability(state.capability,{authorization,plan,url:plan.primaryTarget,now:this.clock()});
    try {
      const unresolved=state.fields.find(field=>field.required&&!field.canonicalAnswer);
      if(unresolved)return{confirmed:false,needsHuman:true,reason:'required field has no canonical answer',blocker:{code:'HUMAN_ONLY_QUESTION',question:unresolved.label||unresolved.name,url:plan.primaryTarget,fieldContext:unresolved.type}};
      const artifacts=request.artifactManifest?.files||{};
      for(const field of state.fields.filter(item=>item.type==='file'&&item.canonicalAnswer&&(item.required||item.answer.kind==='cover'))){
        const name=field.answer.kind==='cover'?'cover-letter.pdf':'resume.pdf',artifact=artifacts[name];
        if(!artifact?.path){
          if(field.required)return{confirmed:false,needsHuman:true,reason:`required ${name} is unavailable`,blocker:{code:'ARTIFACT_MISSING',question:field.label,url:plan.primaryTarget}};
          continue;
        }
        await this.driver.uploadFile(state.session.windowId,state.tabId,field.selector,path.resolve(artifact.path));
      }
      const fillPayload=state.fields.filter(field=>field.type!=='file'&&field.canonicalAnswer).map(field=>({selector:field.selector,type:field.type,value:String(field.answer.value)}));
      const fillScript=`(()=>{const items=${JSON.stringify(fillPayload)};const set=(e,v,type)=>{if(type==='yesno'){const wanted=/^(yes|true|1)$/i.test(v)?'yes':'no';const option=e.querySelector('[data-option="'+wanted+'"]')||[...e.querySelectorAll('button,[role="button"]')].find(x=>(x.innerText||x.getAttribute('aria-label')||'').trim().toLowerCase()===wanted);if(!option)return false;option.click();return true;}if(e.tagName==='SELECT'){const option=[...e.options].find(o=>o.value===v||o.text.trim().toLowerCase()===v.toLowerCase());if(!option)return false;e.value=option.value;}else if(['checkbox','radio'].includes((e.type||'').toLowerCase())){e.checked=/^(yes|true|1)$/i.test(v);}else{const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;setter?setter.call(e,v):e.value=v;}e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true};return JSON.stringify({filled:items.map(x=>{const e=document.querySelector(x.selector);return!!e&&set(e,x.value,x.type)}).filter(Boolean).length,total:items.length})})()`;
      const fillResult=JSON.parse(await this.driver.executeJavaScript(state.session.windowId,state.tabId,fillScript));
      if(fillResult.filled!==fillResult.total)return{confirmed:false,needsHuman:true,reason:'one or more approved fields could not be set safely',blocker:{code:'FIELD_WRITE_INCOMPLETE',url:plan.primaryTarget}};
      const submitScript=`(()=>{const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);const b=[...document.querySelectorAll('button,input[type="submit"]')].find(e=>visible(e)&&!e.disabled&&/submit|apply|send application|enviar|aplicar|postular/i.test(e.innerText||e.value||e.getAttribute('aria-label')||''));if(!b)return JSON.stringify({clicked:false});b.click();return JSON.stringify({clicked:true})})()`;
      const clicked=JSON.parse(await this.driver.executeJavaScript(state.session.windowId,state.tabId,submitScript));
      if(!clicked.clicked)return{confirmed:false,needsHuman:true,reason:'safe submit control unavailable'};
      let meta=null,evidence=null;
      for(let i=0;i<30;i++){
        await this.sleep(500);
        meta=await this.driver.readTabMetadata(state.session.windowId,state.tabId);
        evidence=JSON.parse(await this.driver.executeJavaScript(state.session.windowId,state.tabId,`JSON.stringify({url:location.href,title:document.title,body:(document.body?.innerText||'').slice(0,5000)})`));
        const visibleText=`${evidence.title} ${evidence.body}`;
        const confirmed=/thank you|thanks? for applying|application (?:was )?(?:submitted|received)|we received your application|submitted successfully|gracias|solicitud (?:enviada|recibida)/i.test(visibleText)||/confirmation|submitted|thank-you/i.test(meta.url);
        if(confirmed)return{confirmed:true,confirmation:{url:meta.url,id:`ats:${new URL(meta.url).hostname}:${this.clock().toISOString()}`,evidence:'visible confirmation state'}};
      }
      return{confirmed:false,needsHuman:true,reason:'submit result is ambiguous; automatic retry forbidden',blocker:{code:'VERIFICATION_UNKNOWN',url:meta?.url||evidence?.url||plan.primaryTarget}};
    }finally{await this.stop({execution});}
  }
  async stop({execution}){const state=this.active.get(execution.id);if(!state)return;this.active.delete(execution.id);await this.sessionManager.release(state.session);}
}
