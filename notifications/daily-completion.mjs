import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';
import { formatHumanTime } from '../human-time/presentation.mjs';

export const DAILY_COMPLETION_TIME_ZONE='America/Mexico_City';

export function localDate(value=new Date(),timeZone=DAILY_COMPLETION_TIME_ZONE){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function localMinute(value,timeZone){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(value).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));return Number(parts.hour)*60+Number(parts.minute);}

const sameLocalDate=(value,date,timeZone)=>Boolean(value)&&localDate(new Date(value),timeZone)===date;

export class DailyCompletionSummaryService{
  constructor({registry,clock=()=>new Date(),timeZone=DAILY_COMPLETION_TIME_ZONE}={}){if(!registry)throw new TypeError('registry is required');this.registry=registry;this.clock=clock;this.timeZone=timeZone;}
  buildMetrics(run){
    const date=localDate(new Date(run.finishedAt||run.startedAt),this.timeZone),data=this.registry.getControlPlaneData({candidateScope:'decision'});
    const projection=buildControlPlaneProjection(data),todayRows=projection.tabs.TODAY||[];
    const applications=this.registry.listApplicationExecutions({status:'APPLIED'}).filter(value=>sameLocalDate(value.finishedAt||value.updatedAt,date,this.timeZone)).length;
    const unresolved=this.registry.db.prepare("SELECT COUNT(*) count FROM operational_signals WHERE status IN ('OPEN','RECOVERING','ESCALATED')").get()?.count||0;
    const errors=Array.isArray(run.errors)?run.errors:[];
    return{localDate:date,completedLocal:formatHumanTime(run.finishedAt||run.startedAt,{timeZone:this.timeZone,now:this.clock()}),dailyStatus:run.status==='PARTIAL'?'COMPLETED_WITH_LIMITATIONS':'COMPLETED',reviewed:Number(run.evaluationsCompleted||run.summary?.evaluation?.completed||0),newJobs:Number(run.jobsFound||run.summary?.discovery?.newJobs||0),passed:Number(run.eligible||run.summary?.eligibility?.eligible||0),shortlisted:Number(run.shortlisted||run.summary?.ranking?.shortlisted||0),promoted:Number(run.summary?.evaluation?.apply||0),today:todayRows.length,attention:Number(data.attentionCounts?.total||0),topThree:todayRows.slice(0,3).map(row=>({rank:row.Rank,company:row.Company,role:row.Role,stage:row.Stage,recommendation:row.Recommendation||'UNKNOWN'})),applicationsConfirmed:applications,unresolvedFailures:unresolved,limitedSources:errors.filter(value=>value.severity==='INFO').length,systemStatus:data.operationalSummary?.overall||'UNKNOWN'};
  }
  enqueueForLatestCompletedRun(){
    const boundary=Number(process.env.CAREER_OPS_DAILY_SUMMARY_HOUR||17)*60+Number(process.env.CAREER_OPS_DAILY_SUMMARY_MINUTE||0);if(localMinute(this.clock(),this.timeZone)<boundary)return{status:'BEFORE_DAILY_TERMINAL_BOUNDARY'};
    const run=this.registry.getLatestDailyOperationalRun();if(!run||!['SUCCESS','PARTIAL'].includes(run.status))return{status:'NO_TERMINAL_DAILY_RUN'};
    const metrics=this.buildMetrics(run),today=localDate(this.clock(),this.timeZone);if(metrics.localDate!==today)return{status:'NO_VALID_RUN_TODAY',runId:run.id,runDate:metrics.localDate,today};
    const event=this.registry.db.prepare("SELECT event_id FROM workflow_events WHERE aggregate_type='OPERATIONAL_RUN' AND aggregate_id=? AND event_type IN ('OPERATIONAL_RUN_COMPLETED','OPERATIONAL_RUN_PARTIAL') ORDER BY occurred_at DESC,rowid DESC LIMIT 1").get(run.id);
    const delivery=this.registry.notificationOutbox.enqueueDailyCompletionSummary({operationalRunId:run.id,eventId:event?.event_id||null,localDate:metrics.localDate,metrics});
    return{status:delivery.existing?'ALREADY_ENQUEUED':delivery.status,runId:run.id,metrics,delivery};
  }
}
