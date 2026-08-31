import { hashStable } from '../acquisition/normalize.mjs';
import { scoreFacebookAuthenticity } from '../discovery-strategy/facebook-authenticity.mjs';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
export function canonicalFacebookUrl(value) { try { const url = new URL(value); if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return ''; url.hash=''; [...url.searchParams.keys()].forEach(key => url.searchParams.delete(key)); url.pathname=url.pathname.replace(/\/{2,}/g,'/'); if(!url.pathname.endsWith('/'))url.pathname+='/'; return url.toString(); } catch { return ''; } }
export function extractPublicEmails(text, sourceUrl) {
  const matches = [...clean(text).matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)];
  return [...new Map(matches.map(match => { const email=match[0].toLowerCase(); return [email,{ email, raw:match[0], location:`text:${match.index}`, sourceUrl, confidence:'HIGH', evidenceHash:hashStable(`${sourceUrl}:${match.index}:${match[0]}`) }]; })).values()];
}
export function classifyFacebookOpportunity(post = {}) {
  const text=clean(post.text).toLowerCase();
  if (!text) return 'UNKNOWN';
  const pool=/talent pool|talent network|register here|we match you|multiple opportunities/.test(text);
  const hiring=/\b(hiring|vacancy|vacante|job opening|empleo|buscamos|se busca)\b/.test(text);
  const contract=/\b(contract|contractor|contrato)\b/.test(text);
  const freelance=/\b(freelance|project opportunity|proyecto freelance)\b/.test(text);
  const discussion=/\b(what do you think|qué opinan|discussion|tutorial|course|webinar)\b/.test(text) && !hiring;
  if (discussion) return 'NOT_OPPORTUNITY'; if (freelance) return 'FREELANCE'; if (contract) return 'CONTRACT'; if (hiring && pool) return 'HIRING_SIGNAL'; if (hiring) return 'JOB'; if (/\b(opportunity|oportunidad|position available|puesto disponible)\b/.test(text)) return 'UNKNOWN'; return 'NOT_OPPORTUNITY';
}
export function extractFacebookPost(raw, { communityId, runId, retrievedAt } = {}) {
  const url=canonicalFacebookUrl(raw.url); const text=clean(raw.text); const emails=extractPublicEmails(text,url);
  const links=(raw.links||[]).map(item=>typeof item==='string'?item:item.url).filter(Boolean);
  const images=(raw.images||[]).map((url,index)=>({url, index, evidenceHash:hashStable(`${url}:${index}`), flag:'IMAGE_EVIDENCE_PRESENT', researchNeed:'EXTRACT_IMAGE_EVIDENCE'}));
  const explicitCompany=text.match(/(?:company|empresa|at|en)\s*[:—-]?\s*([A-Z][A-Za-z0-9&. -]{2,40})\b/)?.[1]?.trim()||'';
  const externalCompanyLink=links.find(link=>!/facebook\.com/i.test(link));
  const companyIdentityStatus=explicitCompany&&externalCompanyLink?'CONFIRMED':explicitCompany?'LIKELY':'UNKNOWN';
  const descriptionQuality=text.length>=500?'high':text.length>=180?'medium':'low';
  const signal={ applicationEmail:emails.length>0, companyIdentified:companyIdentityStatus==='CONFIRMED', descriptionQuality,
    stackDefined:/\b(python|javascript|typescript|n8n|make|zapier|gcp|aws|azure|llm|rag|data)\b/i.test(text),
    responsibilitiesClear:/responsibilit|responsabilidades|you will|deberás|funciones/i.test(text), salaryVisible:/(?:usd|mxn|\$)\s?[\d,.]+/i.test(text),
    poolLanguage:/talent pool|talent network|we match you|multiple opportunities/i.test(text), communityOnly:/join our group|community event/i.test(text), recruiterSpam:/send dm|dm me|inbox me/i.test(text)&&text.length<180, registerHere:/register here|regístrate/i.test(text), marketplace:/marketplace/i.test(text) };
  const authenticity=scoreFacebookAuthenticity(signal); const externalId=clean(raw.externalId)||url.match(/\/(?:posts|permalink)\/(\d+)/)?.[1]||'';
  const postKey=hashStable(externalId?`facebook:${externalId}`:`${communityId}:${clean(raw.author)}:${raw.postedAt||''}:${hashStable(text)}`);
  const evidence=[{id:`fb-evidence-${hashStable(`${url}:${hashStable(text)}`)}`,sourceUrl:url,sourceType:'FACEBOOK_POST',fetchedAt:retrievedAt,extractionMethod:'parsed',rawSnippet:text.slice(0,2000),rawHash:hashStable(text),confidence:'MEDIUM',browserRunId:runId}];
  const compensation=(text.match(/(?:USD|US\$|MXN|\$)\s?[\d,.]+(?:\s*[-–]\s*(?:USD|US\$|MXN|\$)?\s?[\d,.]+)?/i)?.[0]||'').replace(/[.,]+$/,'');
  const remoteStatus=/\b(remote|remoto|worldwide|latam)\b/i.test(text)?'REMOTE':/\b(hybrid|híbrido)\b/i.test(text)?'HYBRID':/\b(on[- ]?site|presencial)\b/i.test(text)?'ONSITE':'UNKNOWN';
  const employmentType=/\b(freelance)\b/i.test(text)?'FREELANCE':/\b(contract|contractor|contrato)\b/i.test(text)?'CONTRACT':/\bfull[- ]?time|tiempo completo\b/i.test(text)?'FULL_TIME':'UNKNOWN';
  return { id:`facebook-post-${postKey}`,postKey,communityId,externalId,canonicalUrl:url,authorDisplayName:clean(raw.author),postedAt:raw.postedAt||null,rawText:text,textHash:hashStable(text),links,emails,imageRefs:images,imageEvidencePresent:images.length>0,opportunityType:classifyFacebookOpportunity({text}),companyName:explicitCompany,companyIdentityStatus,location:/\b(?:mexico|méxico|latam|latin america|worldwide)\b/i.exec(text)?.[0]||'',remoteStatus,employmentType,compensation,confidence:companyIdentityStatus==='CONFIRMED'&&descriptionQuality!=='low'?'HIGH':companyIdentityStatus!=='UNKNOWN'?'MEDIUM':'LOW',authenticity,evidence,browserRunId:runId };
}
