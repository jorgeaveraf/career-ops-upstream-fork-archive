#!/usr/bin/env node
import 'dotenv/config';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import path from 'path';
import { OAuth2Client } from 'google-auth-library';
import { selectApplicationChromeProfile } from './application-execution/browser-profile.mjs';
import { CandidateGmailTokenProvider, CandidateGmailTransport, candidateGmailCredentialsPath, inspectCandidateGmailConfig } from './outreach-execution/gmail-transport.mjs';

const SCOPES=['openid','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly'].join(',');
async function status(){const config=inspectCandidateGmailConfig();if(config.status!=='READY')return config;try{return await new CandidateGmailTransport({tokenProvider:new CandidateGmailTokenProvider()}).preflight();}catch(error){return{status:'BLOCKED',detail:error.message,code:error.code||'CANDIDATE_GMAIL_PREFLIGHT_FAILED'};}}
async function authorize(){
  const clientFile=String(process.env.GOOGLE_OAUTH_CLIENT_FILE||'').trim();if(!clientFile||!existsSync(clientFile))throw new Error('GOOGLE_OAUTH_CLIENT_FILE is required for candidate Gmail authorization');
  const source=JSON.parse(readFileSync(path.resolve(clientFile),'utf8')),installed=source.installed;if(!installed?.client_id||!installed?.client_secret)throw new Error('GOOGLE_OAUTH_CLIENT_FILE must contain an installed Desktop OAuth client');
  const selection=selectApplicationChromeProfile({profile:process.env.APPLICATION_BROWSER_PROFILE||'jorge',mode:process.env.APPLICATION_BROWSER_MODE||'application_submit',userDataDir:process.env.APPLICATION_BROWSER_USER_DATA_DIR||process.env.BROWSER_USER_DATA_DIR});if(selection.profileName.toLowerCase()!=='jorge')throw new Error('candidate Gmail authorization requires Chrome profile Jorge');
  const state=randomUUID();let resolveCode,rejectCode;const callback=new Promise((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});
  const server=createServer((request,response)=>{try{const url=new URL(request.url,'http://127.0.0.1');if(url.pathname!=='/oauth2callback')return void response.end('Not found');if(url.searchParams.get('state')!==state)throw new Error('OAuth state mismatch');const error=url.searchParams.get('error');if(error)throw new Error(`Google OAuth denied: ${error}`);const code=url.searchParams.get('code');if(!code)throw new Error('Google OAuth callback contained no code');response.end('Career Ops Candidate Gmail authorization complete. You may close this window.');resolveCode(code);}catch(error){response.statusCode=400;response.end('Career Ops authorization failed.');rejectCode(error);}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{
    const redirectUri=`http://localhost:${server.address().port}/oauth2callback`,oauth=new OAuth2Client(installed.client_id,installed.client_secret,redirectUri),url=oauth.generateAuthUrl({access_type:'offline',prompt:'consent',scope:SCOPES.split(','),state,login_hint:'jorgeaveraf@gmail.com',include_granted_scopes:false});
    console.log('Opening Google consent in the exact Chrome profile: Jorge');
    const child=spawn('/usr/bin/open',['-n','-a','Google Chrome','--args',`--user-data-dir=${selection.userDataDir}`,`--profile-directory=${selection.profileDirectory}`,'--new-window',url],{stdio:'ignore'});child.unref();
    let timeoutHandle;
    const code=await Promise.race([callback,new Promise((_,reject)=>{timeoutHandle=setTimeout(()=>reject(new Error('Google OAuth callback timed out')),300000);})]).finally(()=>clearTimeout(timeoutHandle));const {tokens}=await oauth.getToken(code);if(!tokens.refresh_token)throw new Error('Google did not return a refresh token');
    const target=candidateGmailCredentialsPath(),configDir=path.dirname(target),temporary=`${target}.${process.pid}.tmp`;mkdirSync(configDir,{recursive:true,mode:0o700});writeFileSync(temporary,`${JSON.stringify({type:'authorized_user',client_id:installed.client_id,client_secret:installed.client_secret,refresh_token:tokens.refresh_token,token_uri:'https://oauth2.googleapis.com/token'})}\n`,{mode:0o600});renameSync(temporary,target);chmodSync(target,0o600);return target;
  }finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}
async function main(){const command=process.argv[2]||'status';if(command==='status'){console.log(JSON.stringify(await status(),null,2));return;}if(command==='authorize'){await authorize();const result=await status();console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='READY'?0:1;return;}throw new Error('Usage: node candidate-gmail-auth.mjs status|authorize');}
main().catch(error=>{console.error(`Candidate Gmail auth failed: ${error.message}`);process.exitCode=1;});
