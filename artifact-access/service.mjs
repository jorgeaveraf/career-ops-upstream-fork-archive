import { createHash } from 'crypto';
import { createReadStream, existsSync, statSync } from 'fs';
import http from 'http';

export const ARTIFACT_ACCESS_VERSION='3F.1';
export const DEFAULT_ARTIFACT_ACCESS_URL='http://127.0.0.1:4319';
const TYPES=Object.freeze({'resume.pdf':'resume','cover-letter.pdf':'cover-letter'});
const digest=value=>createHash('sha256').update(value).digest('hex');

function fileHash(file={}){return String(file.sha256||file.hash||file.contentHash||'').trim();}
function tokenFor({jobId,requestId,key,file}){return digest(`${jobId}:${requestId}:${key}:${fileHash(file)}`).slice(0,40);}

export function artifactAccessUrl({baseUrl=process.env.CAREER_OPS_ARTIFACT_ACCESS_URL||DEFAULT_ARTIFACT_ACCESS_URL,jobId,requestId,key,file}={}){
  if(!jobId||!requestId||!TYPES[key]||!file||!fileHash(file))return'';
  return `${String(baseUrl).replace(/\/$/,'')}/v3f/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(requestId)}/${TYPES[key]}/${tokenFor({jobId,requestId,key,file})}`;
}

export function createArtifactAccessHandler({registry}={}){
  if(!registry)throw new TypeError('registry is required');
  return(req,res)=>{try{
    const url=new URL(req.url,'http://127.0.0.1'),match=/^\/v3f\/artifacts\/([^/]+)\/([^/]+)\/(resume|cover-letter)\/([a-f0-9]{40})$/.exec(url.pathname);
    if(req.method!=='GET'||!match){res.writeHead(404);res.end('Not found');return;}
    const jobId=decodeURIComponent(match[1]),requestId=decodeURIComponent(match[2]),key=match[3]==='resume'?'resume.pdf':'cover-letter.pdf';
    const latest=registry.listEnrichmentRequests({jobId}).at(-1);if(!latest||latest.id!==requestId||latest.status!=='READY_FOR_REVIEW'){res.writeHead(410);res.end('Package is no longer current');return;}
    const file=latest.artifactManifest?.files?.[key],expected=file&&tokenFor({jobId,requestId,key,file});if(!file||expected!==match[4]){res.writeHead(404);res.end('Not found');return;}
    const path=file.path||file.absolutePath;if(!path||!existsSync(path)||!statSync(path).isFile()){res.writeHead(404);res.end('Artifact unavailable');return;}
    res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':statSync(path).size,'Content-Disposition':`inline; filename="${String(file.humanFilename||file.filename||key).replaceAll('"','')}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});createReadStream(path).pipe(res);
  }catch{res.writeHead(500);res.end('Artifact access failed');}};
}

export function startArtifactAccessServer({registry,host='127.0.0.1',port=4319}={}){const server=http.createServer(createArtifactAccessHandler({registry}));return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve(server));});}

