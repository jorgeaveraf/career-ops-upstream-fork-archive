#!/usr/bin/env node
import { chmodSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const name=String(process.argv[2]||'').trim();
if(!/^[A-Z][A-Z0-9_]+$/.test(name))throw new Error('A valid environment variable name is required');
const envPath=path.resolve(process.argv[3]||'.env');
const value=readFileSync(0,'utf8').replace(/[\r\n]+$/,'');
if(!value)throw new Error('Refusing to persist an empty secret');
const escaped=value.replaceAll('\\','\\\\').replaceAll('"','\\"');
const line=`${name}="${escaped}"`,source=readFileSync(envPath,'utf8'),pattern=new RegExp(`^${name}=.*$`,'m');
writeFileSync(envPath,pattern.test(source)?source.replace(pattern,line):`${source.replace(/\n?$/,'\n')}${line}\n`,{encoding:'utf8',mode:0o600});
chmodSync(envPath,0o600);
