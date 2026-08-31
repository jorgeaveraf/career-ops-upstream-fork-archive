#!/usr/bin/env node
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const resultPath = path.join(root, 'data', 'v4-3-1-post-reboot-validation.json');
const preRebootBootEpoch = Number(process.env.CAREER_OPS_V431_PRE_REBOOT_BOOT_EPOCH || 0);
const node = process.execPath;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const run = (file, args, timeout = 60_000) => execFileSync(file, args, {
  cwd: root,
  encoding: 'utf8',
  timeout,
  env: process.env,
});
const currentBootEpoch = () => Number(run('/usr/sbin/sysctl', ['-n', 'kern.boottime']).match(/sec = (\d+)/)?.[1] || 0);
const checksFromHealth = output => ({
  workspaceAuth: /Workspace Auth:\s*\nOK — Headless authentication available \(workspace_broker\)/.test(output),
  googleSheets: /Google Sheets:\s*\nOK — Spreadsheet access verified/.test(output),
  candidateGmail: /Candidate Gmail:\s*\nOK — READY — jorgeaveraf@gmail\.com · bounded read verified/.test(output),
  commandSubscriber: /Command Subscriber:\s*\nOK — RUNNING — command_gateway_pull/.test(output),
  linkedInBrowser: /LinkedIn Browser:\s*\nOK — READY/.test(output),
});

async function main() {
  if (existsSync(resultPath)) {
    const prior = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (prior.verdict === 'PASS' && Number(prior.bootEpoch) > preRebootBootEpoch) return;
  }

  let healthOutput = '';
  let healthChecks = {};
  let subscriberLoaded = false;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const launchState = run('/bin/launchctl', ['print', `gui/${process.getuid()}/com.careerops.command-subscriber`], 10_000);
      subscriberLoaded = /state = running|pid = \d+/.test(launchState);
    } catch { subscriberLoaded = false; }
    try {
      healthOutput = run(node, ['health.mjs'], 90_000);
      healthChecks = checksFromHealth(healthOutput);
    } catch (error) {
      healthOutput = String(error.stdout || error.message || error);
      healthChecks = checksFromHealth(healthOutput);
    }
    if (subscriberLoaded && Object.values(healthChecks).every(Boolean)) break;
    await sleep(10_000);
  }

  let candidate = null;
  let watch = null;
  try { candidate = JSON.parse(run(node, ['candidate-gmail-auth.mjs', 'status'], 90_000)); }
  catch (error) { candidate = { status: 'BLOCKED', error: String(error.stdout || error.message || error) }; }
  try { watch = JSON.parse(run(node, ['operational-watch.mjs'], 120_000)); }
  catch (error) { watch = { status: 'FAILED', error: String(error.stdout || error.message || error) }; }

  const bootEpoch = currentBootEpoch();
  const rebootProven = bootEpoch > preRebootBootEpoch;
  const checks = {
    rebootProven,
    subscriberLoaded,
    ...healthChecks,
    candidateGmailFresh: candidate?.status === 'READY' && candidate?.sender === 'jorgeaveraf@gmail.com',
    operationalWatch: watch?.status === 'SUCCESS' && Number(watch?.summary?.openSignals || 0) === 0,
  };
  const result = {
    iteration: 'V4.3.1',
    checkedAt: new Date().toISOString(),
    preparedBootEpoch: preRebootBootEpoch,
    bootEpoch,
    verdict: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    candidate: { status: candidate?.status, sender: candidate?.sender, historyId: candidate?.historyId },
    watch: { status: watch?.status, runId: watch?.runId, openSignals: watch?.summary?.openSignals, escalations: watch?.summary?.escalations },
  };
  mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
  const temporary = `${resultPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, resultPath);
  chmodSync(resultPath, 0o600);
  if (result.verdict !== 'PASS') process.exitCode = 1;
}

main().catch(error => {
  console.error(`V4.3.1 post-reboot validation failed: ${error.message}`);
  process.exitCode = 1;
});
