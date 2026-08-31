import { hashContent } from '../acquisition/normalize.mjs';
import { extractFacebookPost } from './extraction.mjs';
import { FACEBOOK_MONITOR_BUDGET, FACEBOOK_CAPABILITY_VERSION } from './contracts.mjs';

const TYPES=['JOB','CONTRACT','FREELANCE','HIRING_SIGNAL','NOT_OPPORTUNITY','UNKNOWN'];
const ACCEPTED_TYPES=new Set(['JOB','CONTRACT','FREELANCE']);
const recentEnough=(postedAt,days,now)=>{if(!postedAt)return true;const time=new Date(postedAt).getTime();return!Number.isFinite(time)||now.getTime()-time<=days*86_400_000;};

export class FacebookGroupMonitor {
  constructor({registry,browser,clock=()=>new Date()}={}){if(!registry||!browser)throw new TypeError('registry and browser are required');this.registry=registry;this.browser=browser;this.clock=clock;}
  async monitor({runId,communityId=null,budget={}}={}){
    const limits={...FACEBOOK_MONITOR_BUDGET,...budget};
    const groups=this.registry.listFacebookCommunities().filter(c=>(!communityId||c.id===communityId)&&!c.suppressedAt&&c.membershipState==='JOINED_CONFIRMED').slice(0,limits.maxGroups);
    const results=[];const observationJobIds=[];
    for(const community of groups){
      const startedAt=Date.now();const read=await this.browser.readRecentPosts(community,limits);
      const base={runId,communityId:community.id,outcome:read.outcome,postsInspected:0,recentUniquePosts:0,classifications:Object.fromEntries(TYPES.map(x=>[x,0])),opportunitiesFound:0,authenticityAverage:0,authenticityPassed:0,acquisitionObservations:0,newJobs:0,acceptedCandidates:0,durationMs:Date.now()-startedAt,challenges:['AUTH_REQUIRED','CHALLENGE','CAPTCHA'].includes(read.outcome)?1:0,usefulSignalRatio:0,checkedAt:this.clock().toISOString()};
      if(!read.outcome.startsWith('SUCCESS')||!read.membershipObserved){const metric={...base,outcome:read.outcome.startsWith('SUCCESS')?'MEMBERSHIP_NOT_CONFIRMED':read.outcome};this.registry.recordFacebookCommunityMonitorMetric(metric);results.push(metric);if(base.challenges)break;continue;}
      const checkpoint=this.registry.getFacebookCheckpoint(community.id);const seen=new Set(checkpoint?.seenPostIds||[]);const scores=[];
      for(const raw of read.posts){
        if(Date.now()-startedAt>=limits.maxDurationPerGroupMs)break;
        const post=extractFacebookPost(raw,{communityId:community.id,runId,retrievedAt:this.clock().toISOString()});if(!post.canonicalUrl)post.canonicalUrl=community.canonicalUrl;
        if(seen.has(post.postKey)||!recentEnough(post.postedAt,limits.freshnessDays,this.clock()))continue;
        seen.add(post.postKey);base.recentUniquePosts++;base.classifications[post.opportunityType]++;scores.push(post.authenticity.score);
        if(ACCEPTED_TYPES.has(post.opportunityType)){base.opportunitiesFound++;if(post.authenticity.score>=45){base.authenticityPassed++;const title=post.rawText.match(/(?:hiring|vacante|se busca|role|position)\s*[:—-]?\s*([^.!\n]{3,100})/i)?.[1]?.trim()||'Facebook opportunity';const company=post.companyIdentityStatus==='CONFIRMED'?post.companyName:'Unknown company';const observation=this.registry.recordObservation(runId,{provider:'browser:facebook',providerVersion:FACEBOOK_CAPABILITY_VERSION,externalId:post.externalId||post.postKey,sourceUrl:post.canonicalUrl,canonicalUrl:post.links.find(link=>!/facebook\.com/i.test(link))||post.canonicalUrl,title,company,location:post.location||'Unknown',description:post.rawText,contentHash:hashContent(post.rawText),postedAt:post.postedAt||undefined,retrievedAt:this.clock().toISOString(),confidence:String(post.confidence||'MEDIUM').toLowerCase(),rawMetadata:{strategy:'facebook_group_monitoring',sourceLabel:`Facebook · ${community.name}`,provenanceObservations:[{source:'facebook',communityId:community.id,communityName:community.name,postId:post.externalId||post.postKey,postUrl:post.canonicalUrl}],facebook:{communityId:community.id,communityName:community.name,postKey:post.postKey,postUrl:post.canonicalUrl,authorDisplayName:post.authorDisplayName,opportunityType:post.opportunityType,remoteStatus:post.remoteStatus,employmentType:post.employmentType,compensation:post.compensation,confidence:post.confidence,authenticity:post.authenticity,emails:post.emails,imageEvidencePresent:post.imageEvidencePresent,researchNeeds:post.imageEvidencePresent?['EXTRACT_IMAGE_EVIDENCE']:[]}}});post.observationId=observation.observationId;base.acquisitionObservations++;if(observation.outcome==='NEW_JOB')base.newJobs++;observationJobIds.push(observation.jobId);}}
        this.registry.recordFacebookPost(post);
      }
      base.postsInspected=read.posts.length;base.authenticityAverage=scores.length?Number((scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(2)):0;base.acceptedCandidates=base.acquisitionObservations;base.durationMs=Date.now()-startedAt;base.usefulSignalRatio=base.recentUniquePosts?Number((base.opportunitiesFound/base.recentUniquePosts).toFixed(4)):0;base.outcome=read.posts.length?'SUCCESS_RESULTS':'SUCCESS_EMPTY';
      this.registry.recordFacebookCheckpoint(community.id,{runId,seenPostIds:[...seen].slice(-5000),newestSeenMarker:read.posts[0]?.externalId||read.posts[0]?.url||null,oldestSeenMarker:read.posts.at(-1)?.externalId||read.posts.at(-1)?.url||null});this.registry.recordFacebookCommunityMonitorMetric(base);results.push(base);
    }
    const stopped=results.some(x=>x.challenges);const totals=key=>results.reduce((sum,x)=>sum+(x[key]||0),0);const classifications=Object.fromEntries(TYPES.map(type=>[type,results.reduce((sum,x)=>sum+(x.classifications?.[type]||0),0)]));
    return{status:stopped?'PARTIAL':'SUCCESS',groups:results.length,results,postsInspected:totals('postsInspected'),recentUniquePosts:totals('recentUniquePosts'),classifications,opportunities:totals('opportunitiesFound'),authenticityPassed:totals('authenticityPassed'),acquisitionObservations:totals('acquisitionObservations'),newJobs:totals('newJobs'),candidatesAccepted:totals('acceptedCandidates'),observationJobIds:[...new Set(observationJobIds)]};
  }
}
