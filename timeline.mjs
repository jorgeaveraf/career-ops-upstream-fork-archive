#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { openJobRegistry } from './registry/job-registry.mjs';
import { WorkflowTimelineService } from './workflow-events/timeline.mjs';

export function formatTimeline(entries) {
  return entries.map(item => `${item.timestamp}  ${item.stage.padEnd(11)} ${item.eventType.padEnd(36)} ${item.summary} [${item.source}]`).join('\n') || 'No workflow events found.';
}
export function runTimelineCli(argv = process.argv.slice(2), { registry = null } = {}) {
  const own = !registry; const store = registry || openJobRegistry();
  try {
    const json = argv.includes('--json'); const args=argv.filter(x=>x!=='--json'); const [mode,id]=args;
    const service=new WorkflowTimelineService({db:store.db}); let rows;
    if(mode==='correlation'&&id) rows=service.getByCorrelation(id);
    else if(mode==='job'&&id) rows=service.getForJob(id);
    else if(mode==='application'&&id) rows=service.getForApplication(id);
    else if(mode==='community'&&id) rows=service.getForCommunity(id);
    else if(mode==='recent') rows=service.getRecent(id || 50);
    else throw new TypeError('usage: npm run timeline -- <correlation|job|application|community|recent> [id|limit] [--json]');
    const output=json?JSON.stringify(rows,null,2):formatTimeline(rows); if(import.meta.url===pathToFileURL(process.argv[1]||'').href) console.log(output); return {rows,output};
  } finally { if(own) store.close(); }
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){try{runTimelineCli();}catch(error){console.error(error.message);process.exitCode=1;}}
