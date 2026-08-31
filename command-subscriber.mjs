#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'url';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';
import { CommandGatewayPullTransport, CommandSubscriber } from './operations/command-subscriber.mjs';

export async function runCommandSubscriber({ env = process.env } = {}) {
  const subscriptionName = String(env.CAREER_OPS_PUBSUB_SUBSCRIPTION || '').trim();
  const projectId = String(env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || '').trim();
  if (!subscriptionName || !projectId) throw new Error('CAREER_OPS_PUBSUB_SUBSCRIPTION and GOOGLE_CLOUD_PROJECT are required');
  const provider=String(env.CAREER_OPS_COMMAND_SUBSCRIBER_PROVIDER||'').trim().toLowerCase();
  if(provider!=='command_gateway_pull')throw new Error('CAREER_OPS_COMMAND_SUBSCRIBER_PROVIDER must be command_gateway_pull in production');
  const transport=new CommandGatewayPullTransport({url:env.CAREER_OPS_COMMAND_GATEWAY_URL,secret:env.CAREER_OPS_COMMAND_SECRET});
  const registry = openJobRegistry({ dbPath: env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH });
  const subscriber = new CommandSubscriber({ registry, subscriptionName, projectId, transport });
  await subscriber.start();
  const stop = async signal => { console.log(JSON.stringify({ event: 'subscriber_stopping', signal })); await subscriber.close(); registry.close(); process.exit(0); };
  process.once('SIGTERM', () => void stop('SIGTERM')); process.once('SIGINT', () => void stop('SIGINT'));
  return subscriber;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) runCommandSubscriber().catch(error => { console.error(`Command subscriber failed: ${error.message}`); process.exitCode = 1; });
