#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { CandidateKnowledgeProvider } from './candidate-knowledge/provider.mjs';

function usage() {
  console.log(`Usage:
  node candidate-kb.mjs validate
  node candidate-kb.mjs hash
  node candidate-kb.mjs summary
  node candidate-kb.mjs skill <name>
  node candidate-kb.mjs project [skill]
  node candidate-kb.mjs gap [topic]
  node candidate-kb.mjs preferences

The provider is read-only and performs no LLM or network calls.`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') return usage();
  const provider = new CandidateKnowledgeProvider({ strictHash: command !== 'hash' });
  if (command === 'validate') {
    const snapshot = provider.load();
    console.log(JSON.stringify({ valid: true, metadata: snapshot.metadata }, null, 2));
  } else if (command === 'hash') {
    console.log(JSON.stringify({ contentHash: provider.load().metadata.hash }, null, 2));
  } else if (command === 'summary') {
    const snapshot = provider.load();
    console.log(JSON.stringify({
      metadata: snapshot.metadata, identity: snapshot.identity,
      counts: {
        experiences: snapshot.experience.length, projects: snapshot.projects.length,
        skills: snapshot.skills.length, stories: snapshot.stories.length,
        gaps: snapshot.gaps.length, evidence: snapshot.evidence.length,
      },
    }, null, 2));
  } else if (command === 'skill') {
    if (!rest.length) throw new Error('skill requires a name');
    console.log(JSON.stringify(provider.findEvidence(rest.join(' ')), null, 2));
  } else if (command === 'project') {
    console.log(JSON.stringify(provider.getProjects({ skill: rest.join(' ') || undefined }), null, 2));
  } else if (command === 'gap') {
    console.log(JSON.stringify(provider.getGaps(rest.join(' ')), null, 2));
  } else if (command === 'preferences') {
    console.log(JSON.stringify(provider.getPreferences(), null, 2));
  } else {
    throw new Error(`unknown command: ${command}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
