#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { openCandidateKnowledge } from './candidate-knowledge/provider.mjs';
import { createDiscoveryStrategy } from './discovery-strategy/engine.mjs';
import { generateDiscoveryStrategyTasks } from './discovery-strategy/tasks.mjs';

function usage() {
  console.log(`Usage:
  npm run discovery:strategy -- summary
  npm run discovery:strategy -- tasks
  npm run discovery:strategy -- explain <task-id>
  npm run discovery:strategy -- --help

This command is local and read-only. It does not open a browser or write Registry state.`);
}

function main() {
  const args = process.argv.slice(2); const command = args[0] || 'summary';
  if (['--help', '-h'].includes(command)) { usage(); return; }
  const strategy = createDiscoveryStrategy({ candidateProvider: openCandidateKnowledge({ projectRoot: process.cwd() }) });
  const tasks = generateDiscoveryStrategyTasks(strategy);
  if (command === 'summary') {
    console.log(JSON.stringify({
      version: strategy.version, revision: strategy.revision, candidateKbRevision: strategy.candidateKbRevision,
      roles: strategy.roles, technologies: strategy.technologies, preferences: strategy.preferences,
      sourcePriorities: strategy.sourcePriorities,
      runbooks: Object.fromEntries(Object.entries(strategy.platforms).map(([source, runbook]) => [source, runbook.phases.map(phase => phase.id)])),
      taskCounts: Object.fromEntries([...new Set(tasks.map(task => task.source))].map(source => [source, tasks.filter(task => task.source === source).length])),
    }, null, 2)); return;
  }
  if (command === 'tasks') { console.log(JSON.stringify(tasks, null, 2)); return; }
  if (command === 'explain') {
    const task = tasks.find(item => item.id === args[1]);
    if (!task) throw new Error(`unknown strategy task: ${args[1] || '(missing)'}`);
    console.log(JSON.stringify({ id: task.id, source: task.source, strategy: task.strategyId, query: task.query, objective: task.objective, explanation: task.explanation }, null, 2)); return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (error) { console.error(`Discovery Strategy failed: ${error.message}`); process.exitCode = 1; }
}
