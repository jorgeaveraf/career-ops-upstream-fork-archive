import { WorkflowTimelineService } from '../workflow-events/timeline.mjs';
import { formatHumanTime } from '../human-time/presentation.mjs';

export const WORKFLOW_DISPLAY_STAGES = Object.freeze(['DISCOVER','DECIDE','PREPARE','APPLY','TRACK_LEARN','COMMUNITY','SYSTEM']);
export const WORKFLOW_DISPLAY_STATUSES = Object.freeze(['IDLE','QUEUED','PROCESSING','WAITING_FOR_HUMAN','READY_FOR_REVIEW','COMPLETED','FAILED','BLOCKED']);

const EVENT_STATUS = Object.freeze({
  JOB_ENTERED_ACTIVE_SET:'IDLE', JOB_CARRIED_OVER:'IDLE', JOB_DECISION_IMPORTED:'IDLE', JOB_HELD:'IDLE', JOB_NEXT_STAGE_REQUESTED:'QUEUED',
  ENRICHMENT_QUEUED:'QUEUED', ENRICHMENT_STARTED:'PROCESSING', EVALUATION_COMPLETED:'PROCESSING', PACKAGE_GENERATED:'PROCESSING', ENRICHMENT_COMPLETED:'READY_FOR_REVIEW', ENRICHMENT_BLOCKED:'BLOCKED', ENRICHMENT_FAILED:'FAILED',
  APPLICATION_APPROVED:'QUEUED', APPLICATION_HUMAN_ANSWER_PROVIDED:'QUEUED', APPLICATION_EXECUTION_STARTED:'PROCESSING', APPLICATION_SUBMIT_ATTEMPTED:'PROCESSING', APPLICATION_NEEDS_HUMAN:'WAITING_FOR_HUMAN', APPLICATION_VERIFICATION_UNKNOWN:'WAITING_FOR_HUMAN', APPLICATION_CONFIRMED:'COMPLETED', APPLICATION_FAILED:'FAILED', APPLICATION_CANCELLED:'BLOCKED',
  COMMUNITY_DISCOVERED:'IDLE', COMMUNITY_DECISION_IMPORTED:'QUEUED', COMMUNITY_JOIN_REQUESTED:'PROCESSING', COMMUNITY_JOIN_PENDING:'WAITING_FOR_HUMAN', COMMUNITY_NEEDS_HUMAN:'WAITING_FOR_HUMAN', COMMUNITY_JOIN_CONFIRMED:'COMPLETED', COMMUNITY_SUPPRESSED:'COMPLETED', COMMUNITY_MONITORING_COMPLETED:'COMPLETED',
});

const ENRICHMENT_PROCESSING = new Set(['RESEARCHING','EVALUATING','GENERATING_PACKAGE']);
const latest = values => values.filter(Boolean).sort().at(-1) || null;
const blockerText = execution => execution?.blocker?.question || execution?.blocker?.code || '';

export function formatWorkflowUpdatedAt(value, { timeZone = 'America/Mexico_City', now = new Date() } = {}) {
  return formatHumanTime(value, { timeZone, now });
}

function authoritativeJobState({ humanDecision = 'NO_ACTION', applicationDecision = 'NO_ACTION', enrichment, execution } = {}) {
  if (execution?.status === 'APPLIED') return { stage:'TRACK_LEARN', workflowStatus:'COMPLETED', attentionRequired:false };
  if (execution?.status === 'NEEDS_HUMAN') return { stage:'APPLY', workflowStatus:'WAITING_FOR_HUMAN', attentionRequired:true, humanBlocker:blockerText(execution) };
  if (execution?.status === 'EXECUTING') return { stage:'APPLY', workflowStatus:'PROCESSING', attentionRequired:false };
  if (execution?.status === 'FAILED') return { stage:'APPLY', workflowStatus:'FAILED', attentionRequired:true };
  if (execution?.status === 'CANCELLED') {
    const reauthorization = applicationDecision === 'HOLD' && enrichment?.status === 'READY_FOR_REVIEW';
    return reauthorization
      ? { stage:'APPLY', workflowStatus:'WAITING_FOR_HUMAN', attentionRequired:true, humanBlocker:'A new exact application authorization is required.' }
      : { stage:'APPLY', workflowStatus:'COMPLETED', attentionRequired:false };
  }
  if (applicationDecision === 'APPROVE_TO_APPLY') return { stage:'APPLY', workflowStatus:'QUEUED', attentionRequired:false };
  if (enrichment?.status === 'READY_FOR_REVIEW') return { stage:'PREPARE', workflowStatus:'READY_FOR_REVIEW', attentionRequired:true };
  if (enrichment?.status === 'BLOCKED') return { stage:'PREPARE', workflowStatus:'BLOCKED', attentionRequired:true, humanBlocker:enrichment.terminalReason || '' };
  if (enrichment?.status === 'FAILED') return { stage:'PREPARE', workflowStatus:'FAILED', attentionRequired:true, humanBlocker:enrichment.terminalReason || enrichment.lastErrorCode || '' };
  if (enrichment?.status === 'PENDING') return { stage:'PREPARE', workflowStatus:'QUEUED', attentionRequired:false };
  if (ENRICHMENT_PROCESSING.has(enrichment?.status)) return { stage:'PREPARE', workflowStatus:'PROCESSING', attentionRequired:false };
  if (humanDecision === 'NEXT_STAGE') return { stage:'PREPARE', workflowStatus:'QUEUED', attentionRequired:false };
  if (humanDecision === 'HOLD') return { stage:'DECIDE', workflowStatus:'IDLE', attentionRequired:false };
  return { stage:'DISCOVER', workflowStatus:'IDLE', attentionRequired:false };
}

function fallbackActivity(state, { humanDecision, enrichment, execution } = {}) {
  if (execution?.status === 'NEEDS_HUMAN' && execution?.blocker?.code === 'VERIFICATION_UNKNOWN') return 'Submission was attempted but external confirmation could not be verified.';
  if (execution?.status === 'NEEDS_HUMAN') return 'Application paused for a human answer.';
  if (execution?.status === 'APPLIED') return 'Application submission confirmed.';
  if (execution?.status === 'EXECUTING') return 'Application execution started.';
  if (enrichment?.status === 'READY_FOR_REVIEW') return 'Job research and application preparation completed.';
  if (state.workflowStatus === 'PROCESSING') return 'Job research and application preparation started.';
  if (state.workflowStatus === 'QUEUED') return 'Job preparation queued.';
  if (humanDecision === 'HOLD') return 'Job held for later review.';
  return '';
}

export class WorkflowStatusService {
  constructor({ registry, timeline, clock = () => new Date(), timeZone = 'America/Mexico_City' } = {}) {
    if (!registry && !timeline) throw new TypeError('registry or timeline is required');
    this.registry = registry; this.timeline = timeline || new WorkflowTimelineService({ db: registry.db }); this.clock = clock; this.timeZone = timeZone;
  }

  resolveJobStatus(jobId, authoritative = {}) {
    const events = this.timeline.getForJob(jobId); const lastEvent = events.at(-1) || null;
    const state = authoritativeJobState(authoritative);
    const timestamp = latest([lastEvent?.timestamp, authoritative.execution?.updatedAt, authoritative.enrichment?.updatedAt, authoritative.enrichment?.requestedAt]);
    return { jobId, correlationId:lastEvent?.correlationId || null, stage:state.stage, workflowStatus:state.workflowStatus, lastEvent:lastEvent?.eventType || null,
      startedAt:authoritative.execution?.startedAt || authoritative.enrichment?.currentStageStartedAt || null, updatedAt:timestamp,
      completedAt:authoritative.execution?.finishedAt || authoritative.enrichment?.enrichmentCompletion?.lastEnriched || null,
      lastActivity:lastEvent?.summary || fallbackActivity(state, authoritative), lastUpdated:formatWorkflowUpdatedAt(timestamp, { timeZone:this.timeZone, now:this.clock() }),
      attentionRequired:state.attentionRequired, humanBlocker:state.humanBlocker || '', recentEvents:events.slice(-5) };
  }

  getJobStatus(jobId) {
    if (!this.registry) throw new TypeError('registry is required for authoritative job status');
    const state = new Map(this.registry.getHumanFieldState().filter(item => item.entityType === 'JOB' && item.entityId === jobId).map(item => [item.field, item.value]));
    return this.resolveJobStatus(jobId, { humanDecision:state.get('human_decision') || 'NO_ACTION', applicationDecision:state.get('application_decision') || 'NO_ACTION', enrichment:this.registry.listEnrichmentRequests({ jobId }).at(-1), execution:this.registry.listApplicationExecutions({ jobId }).at(-1) });
  }

  getCommandStatus(commandId) {
    if (!this.registry) throw new TypeError('registry is required for command status');
    const command = this.registry.getWorkflowCommand(commandId); if (!command) return null;
    const status = command.status === 'RECEIVED' ? 'QUEUED' : command.status;
    return { commandId, commandType:command.commandType, correlationId:command.correlationId, status, result:command.resultSummary || command.errorMessage || '', requestedAt:command.requestedAt, startedAt:command.startedAt, completedAt:command.completedAt, lastUpdated:formatWorkflowUpdatedAt(command.completedAt || command.startedAt || command.requestedAt, { timeZone:this.timeZone, now:this.clock() }) };
  }

  getCommunityStatus(communityId) {
    if (!this.registry) throw new TypeError('registry is required for community status');
    const community = this.registry.getFacebookCommunity(communityId); if (!community) return null;
    const events = this.timeline.getForCommunity(communityId), lastEvent = events.at(-1) || null; let workflowStatus = EVENT_STATUS[lastEvent?.eventType] || 'IDLE';
    if (community.membershipState === 'JOINED_CONFIRMED') workflowStatus='COMPLETED';
    else if (['NEEDS_HUMAN','CHALLENGE','AUTH_REQUIRED','VERIFICATION_UNKNOWN','JOIN_REQUESTED'].includes(community.membershipState)) workflowStatus='WAITING_FOR_HUMAN';
    return { communityId, correlationId:lastEvent?.correlationId || null, stage:'COMMUNITY', workflowStatus, lastEvent:lastEvent?.eventType || null, lastActivity:lastEvent?.summary || '', updatedAt:lastEvent?.timestamp || community.lastCheckedAt || community.lastSeenAt, lastUpdated:formatWorkflowUpdatedAt(lastEvent?.timestamp || community.lastCheckedAt || community.lastSeenAt, { timeZone:this.timeZone, now:this.clock() }), attentionRequired:['WAITING_FOR_HUMAN','FAILED','BLOCKED'].includes(workflowStatus), recentEvents:events.slice(-5) };
  }

  getRecentActive(limit = 25) {
    const ids=[]; for (const event of this.timeline.getRecent(Math.max(50,limit*4)).reverse()) { const id=event.refs.jobId || (event.refs.aggregateType === 'JOB' ? event.refs.aggregateId : null); if (id && !ids.includes(id)) ids.push(id); if (ids.length >= limit) break; }
    return ids.map(id => this.getJobStatus(id)).filter(item => item.workflowStatus !== 'IDLE');
  }
}

export function workflowStatusFromEvent(eventType) { return EVENT_STATUS[eventType] || 'IDLE'; }
