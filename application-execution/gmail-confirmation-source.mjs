import { correlateConfirmationEmail } from './reconciliation.mjs';

const quote=value=>`"${String(value||'').replaceAll('"','')}"`;

/** Read-only, bounded Gmail safety net. It never treats a generic receipt as
 * confirmation: recipient, time window, confirmation language and exact
 * company or role identity must all correlate to one execution. */
export class GmailApplicationConfirmationSource {
  constructor({transport}={}){if(!transport)throw new TypeError('Gmail transport is required');this.transport=transport;}
  async evidenceFor({execution,job}={}){
    if(!execution||!job)return[];
    const after=Math.max(0,Math.floor(new Date(execution.startedAt||execution.createdAt).getTime()/1000)-3600),identity=[job.company,job.title].filter(Boolean).map(quote).join(' OR '),query=`after:${after} (${identity}) ("application submitted" OR "application received" OR "thanks for applying" OR "postulación enviada" OR "se envió tu postulación")`;
    const result=await this.transport.searchMessages({query,maxResults:20}),evidence=[];
    for(const item of result.messages){const message=await this.transport.getMessageMetadata(item.id),match=correlateConfirmationEmail({message,execution,job});if(match)evidence.push(match);}
    return evidence;
  }
}
