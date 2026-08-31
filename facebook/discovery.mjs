import { hashStable } from '../acquisition/normalize.mjs';
import { generateDiscoveryStrategyTasks } from '../discovery-strategy/tasks.mjs';
import { FACEBOOK_DISCOVERY_BUDGET } from './contracts.mjs';
import { canonicalFacebookUrl } from './extraction.mjs';
import { scoreFacebookCommunity } from './scoring.mjs';

const parseMembers=value=>{
  const raw=String(value||'').replace(/,/g,'').trim();
  const match=raw.match(/([\d.]+)\s*(millones?|mil|K|M|B)?\b/i);if(!match)return null;
  const unit=match[2]?.toLowerCase();
  return Math.round(Number(match[1])*({k:1e3,m:1e6,b:1e9,mil:1e3,millon:1e6,millones:1e6}[unit]||1));
};
export function buildFacebookCommunityTasks(strategy,{maxQueries=FACEBOOK_DISCOVERY_BUDGET.maxQueries}={}) {
  return generateDiscoveryStrategyTasks(strategy).filter(t=>t.source==='facebook'&&t.mode==='group_discovery').slice(0,maxQueries).map(t=>({...t,execution:'facebook_community_discovery'}));
}
function roundRobin(buckets,limit){
  const selected=new Map();const longest=Math.max(0,...buckets.map(bucket=>bucket.length));
  for(let index=0;index<longest&&selected.size<limit;index++)for(const bucket of buckets){const item=bucket[index];if(item&&!selected.has(item.url))selected.set(item.url,item);if(selected.size>=limit)break;}
  return [...selected.values()];
}
export class FacebookCommunityDiscoveryProvider {
  constructor({browser,clock=()=>new Date()}={}){if(!browser)throw new TypeError('browser is required');this.browser=browser;this.clock=clock;}
  async discover({strategy,candidateKbHash=strategy?.candidateKbRevision,budget={}}={}){
    const limits={...FACEBOOK_DISCOVERY_BUDGET,...budget};const tasks=buildFacebookCommunityTasks(strategy,limits);const buckets=[];const outcomes=[];const started=this.clock();
    const perQueryLimit=Math.max(1,Math.ceil(limits.maxCandidates/Math.max(1,tasks.length)));
    for(const task of tasks){
      if(this.clock()-started>=limits.maxDurationMs)break;
      const result=await this.browser.searchGroups({query:task.query,maxScrollPasses:limits.maxScrollPasses,maxCandidates:perQueryLimit});
      outcomes.push({taskId:task.id,query:task.query,outcome:result.outcome,classification:result.classification,found:result.groups.length});
      if(!result.outcome.startsWith('SUCCESS')){if(['AUTH_REQUIRED','CHALLENGE','CAPTCHA'].includes(result.outcome))break;continue;}
      const unique=new Map();
      for(const group of result.groups){const url=canonicalFacebookUrl(group.url);if(url&&!unique.has(url))unique.set(url,{...group,url,query:task.query,queryReason:task.explanation.reason,queryPriority:task.priority,strategyRevision:strategy.revision,candidateKbHash});}
      buckets.push([...unique.values()]);
    }
    const candidates=roundRobin(buckets,limits.maxCandidates);const communities=[];
    for(const candidate of candidates.slice(0,limits.maxGroupsOpened)){
      if(this.clock()-started>=limits.maxDurationMs)break;
      const detail=await this.browser.inspectGroup(candidate);outcomes.push({url:candidate.url,outcome:detail.outcome,classification:detail.classification});
      if(['AUTH_REQUIRED','CHALLENGE','CAPTCHA'].includes(detail.outcome))break;if(!detail.outcome.startsWith('SUCCESS'))continue;
      const g=detail.group;const scored=scoreFacebookCommunity(g,strategy);
      const state=g.membershipObserved?'JOINED_CONFIRMED':scored.recommendation==='RECOMMENDED'?(g.visibility==='PRIVATE'?'JOIN_REQUIRED':'RECOMMENDED'):'DISCOVERED';
      const evidence=[{id:`facebook-community-evidence-${hashStable(`${g.url}:${hashStable(g.description||'')}`)}`,sourceUrl:g.url,sourceType:'FACEBOOK_GROUP',fetchedAt:this.clock().toISOString(),extractionMethod:'parsed',rawSnippet:String(g.description||'').slice(0,2000),rawHash:hashStable(g.description||g.name),confidence:'MEDIUM'}];
      communities.push({id:`facebook-community-${hashStable(g.url)}`,canonicalUrl:g.url,name:g.name||candidate.name,topic:candidate.query,visibility:g.visibility||'UNKNOWN',membershipState:state,memberCount:parseMembers(g.memberCountText),...scored,publicDescription:String(g.description||'').slice(0,5000),language:/\b(el|la|de|para|empleo)\b/i.test(g.description||'')?'es':'',geographySignals:/latam|latin america|méxico|mexico/i.test(g.description||'')?['LATAM']:[],whyItMatters:scored.reasons.join(' · '),query:candidate.query,queryReason:candidate.queryReason,queryPriority:candidate.queryPriority,strategyRevision:strategy.revision,candidateKbHash,evidence,observedMembership:g.membershipObserved});
    }
    return {status:outcomes.some(x=>['AUTH_REQUIRED','CHALLENGE','CAPTCHA'].includes(x.outcome))?'PARTIAL':'SUCCESS',communities,outcomes,startedAt:started.toISOString(),finishedAt:this.clock().toISOString()};
  }
}
