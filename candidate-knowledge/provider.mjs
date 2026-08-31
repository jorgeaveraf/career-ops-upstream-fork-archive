import { readFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { hashStable } from '../acquisition/normalize.mjs';
import {
  CANDIDATE_KB_SCHEMA_VERSION, GAP_STATUSES, KNOWLEDGE_CONFIDENCE, KNOWLEDGE_STATUSES,
} from './contracts.mjs';
import { resolveApplicationField } from './application-facts.mjs';

function clone(value) {
  return structuredClone(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function requiredText(value, name) {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(`${name} is required`);
  return result;
}

function isoDate(value, name) {
  const date = new Date(requiredText(value, name));
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be an ISO timestamp`);
  return date.toISOString();
}

function array(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function inside(root, relative, name) {
  const resolved = path.resolve(root, requiredText(relative, name));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`${name} must stay inside ${root}`);
  return resolved;
}

function ids(items, name) {
  const map = new Map();
  for (const item of array(items, name)) {
    const id = requiredText(item?.id, `${name} id`);
    if (map.has(id)) throw new Error(`duplicate ${name} id: ${id}`);
    map.set(id, item);
  }
  return map;
}

function resolveDotted(object, dotted) {
  return requiredText(dotted, 'preference path').split('.').reduce((value, key) => value?.[key], object);
}

export class CandidateKnowledgeProvider {
  constructor({ root = 'candidate', projectRoot = process.cwd(), strictHash = true } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.root = path.resolve(this.projectRoot, root);
    this.strictHash = strictHash;
    this.snapshot = null;
    this.index = null;
  }

  load() {
    const manifestPath = inside(this.root, 'manifest.yml', 'manifest');
    const manifest = yaml.load(readFileSync(manifestPath, 'utf8')) || {};
    if (manifest.schema_version !== CANDIDATE_KB_SCHEMA_VERSION) {
      throw new Error(`candidate KB schema ${manifest.schema_version} is not supported; expected ${CANDIDATE_KB_SCHEMA_VERSION}`);
    }
    const version = Number(manifest.kb_version);
    if (!Number.isInteger(version) || version <= 0) throw new TypeError('kb_version must be a positive integer');
    const sections = {};
    for (const [name, relative] of Object.entries(manifest.sections || {})) {
      sections[name] = yaml.load(readFileSync(inside(this.root, relative, `section ${name}`), 'utf8')) || {};
    }
    const sourceDocuments = {};
    const sourceHashes = {};
    const sources = ids(manifest.sources || [], 'sources');
    for (const source of sources.values()) {
      const sourcePath = inside(this.projectRoot, source.path, `source ${source.id}`);
      const raw = readFileSync(sourcePath, 'utf8');
      sourceHashes[source.id] = hashStable(raw.replace(/\r\n/g, '\n'));
      sourceDocuments[source.id] = source.path.endsWith('.yml') || source.path.endsWith('.yaml')
        ? (yaml.load(raw) || {})
        : raw;
    }
    const hashManifest = clone(manifest);
    if (hashManifest.metadata) delete hashManifest.metadata.content_hash;
    const hash = hashStable(JSON.stringify(stable({ manifest: hashManifest, sections, sourceHashes })));
    const declaredHash = String(manifest?.metadata?.content_hash || '');
    if (this.strictHash && declaredHash !== hash) {
      throw new Error(`candidate KB content hash mismatch: declared ${declaredHash || '(missing)'}, computed ${hash}`);
    }
    const updatedAt = new Date(requiredText(manifest?.metadata?.updated_at, 'metadata.updated_at'));
    if (Number.isNaN(updatedAt.getTime())) throw new TypeError('metadata.updated_at must be an ISO timestamp');
    const snapshot = {
      metadata: {
        schemaVersion: manifest.schema_version,
        version,
        updatedAt: updatedAt.toISOString(),
        hash,
        revision: `${version}:${hash.slice(0, 12)}`,
        sourceHashes,
        generationMethod: String(manifest?.metadata?.generation_method || ''),
      },
      sources: [...sources.values()],
      identity: sections.identity?.identity || {},
      experience: sections.experience?.experience || [],
      projects: sections.projects?.projects || [],
      skills: sections.skills?.skills || [],
      stories: sections.stories?.stories || [],
      gaps: sections.gaps?.gaps || [],
      preferences: sections.preferences?.preferences || {},
      evidence: sections.evidence?.claims || [],
      applicationFacts: sections.application_facts?.application_facts || { facts: [] },
    };
    this._validate(snapshot, sourceDocuments);
    this.snapshot = snapshot;
    this.index = this._index(snapshot);
    return this.getSnapshot();
  }

  _validate(snapshot, sourceDocuments) {
    const experience = ids(snapshot.experience, 'experience');
    const projects = ids(snapshot.projects, 'projects');
    const skills = ids(snapshot.skills, 'skills');
    const stories = ids(snapshot.stories, 'stories');
    const gaps = ids(snapshot.gaps, 'gaps');
    const evidence = ids(snapshot.evidence, 'evidence');
    const sources = ids(snapshot.sources, 'sources');
    for (const fact of array(snapshot.applicationFacts.facts || [], 'application facts')) {
      requiredText(fact.normalized_field, 'application fact normalized_field');
      if (fact.status !== 'CONFIRMED' || fact.source !== 'USER_CONFIRMED') throw new Error('application facts must be USER_CONFIRMED and CONFIRMED');
      if (fact.sensitivity !== 'APPLICATION_ONLY') throw new Error('application facts must be APPLICATION_ONLY');
      isoDate(fact.confirmed_at, 'application fact confirmed_at');
    }
    const allEntities = new Set([
      ...experience.keys(), ...projects.keys(), ...skills.keys(), ...stories.keys(), ...gaps.keys(), ...evidence.keys(),
    ]);
    const assertRefs = (owner, refs, target, kind) => {
      for (const ref of refs || []) if (!target.has(ref)) throw new Error(`${owner} references unknown ${kind}: ${ref}`);
    };
    for (const claim of evidence.values()) {
      if (!KNOWLEDGE_STATUSES.includes(claim.status)) throw new Error(`${claim.id} has invalid status ${claim.status}`);
      if (!KNOWLEDGE_CONFIDENCE.includes(claim.confidence)) throw new Error(`${claim.id} has invalid confidence ${claim.confidence}`);
      if (claim.status === 'CONFIRMED' && !(claim.source_refs || []).length) throw new Error(`${claim.id} confirmed claim requires source_refs`);
      if (claim.status === 'UNKNOWN' && claim.confidence !== 'low') throw new Error(`${claim.id} unknown claim confidence must be low`);
      if (claim.status === 'INFERRED' && claim.confidence === 'high') throw new Error(`${claim.id} inferred claim cannot have high confidence`);
      for (const ref of claim.source_refs || []) {
        if (!sources.has(ref.source_id)) throw new Error(`${claim.id} references unknown source: ${ref.source_id}`);
        requiredText(ref.locator, `${claim.id} source locator`);
      }
      for (const ref of claim.entity_refs || []) if (!allEntities.has(ref)) throw new Error(`${claim.id} references unknown entity: ${ref}`);
    }
    assertRefs('identity', snapshot.identity.evidence_refs, evidence, 'evidence');
    for (const item of experience.values()) {
      assertRefs(item.id, item.project_refs, projects, 'project');
      assertRefs(item.id, item.responsibility_claim_refs, evidence, 'evidence');
    }
    for (const item of projects.values()) {
      if (!experience.has(item.experience_ref)) throw new Error(`${item.id} references unknown experience: ${item.experience_ref}`);
      assertRefs(item.id, item.evidence_refs, evidence, 'evidence');
      assertRefs(item.id, item.story_refs, stories, 'story');
    }
    for (const item of skills.values()) {
      if (!KNOWLEDGE_CONFIDENCE.includes(item.confidence)) throw new Error(`${item.id} has invalid confidence ${item.confidence}`);
      assertRefs(item.id, item.project_refs, projects, 'project');
      assertRefs(item.id, item.evidence_refs, evidence, 'evidence');
      assertRefs(item.id, item.story_refs, stories, 'story');
    }
    for (const item of stories.values()) {
      assertRefs(item.id, item.project_refs, projects, 'project');
      assertRefs(item.id, item.skill_refs, skills, 'skill');
      assertRefs(item.id, item.evidence_refs, evidence, 'evidence');
      assertRefs(item.id, item.gap_refs, gaps, 'gap');
    }
    for (const item of gaps.values()) {
      if (!GAP_STATUSES.includes(item.status)) throw new Error(`${item.id} has invalid gap status ${item.status}`);
      if (!KNOWLEDGE_CONFIDENCE.includes(item.confidence)) throw new Error(`${item.id} has invalid confidence ${item.confidence}`);
      assertRefs(item.id, item.evidence_refs, evidence, 'evidence');
    }
    const preferenceSource = requiredText(snapshot.preferences.source_id, 'preferences.source_id');
    if (!sources.has(preferenceSource) || typeof sourceDocuments[preferenceSource] !== 'object') {
      throw new Error('preferences must reference a structured approved source');
    }
    for (const [name, dotted] of Object.entries(snapshot.preferences.mappings || {})) {
      if (resolveDotted(sourceDocuments[preferenceSource], dotted) === undefined) {
        throw new Error(`preference ${name} references missing profile path: ${dotted}`);
      }
    }
  }

  _index(snapshot) {
    const map = list => new Map(list.map(item => [item.id, item]));
    const skillNames = new Map();
    for (const skill of snapshot.skills) {
      for (const name of [skill.name, ...(skill.aliases || [])]) skillNames.set(normalized(name), skill.id);
    }
    return {
      experience: map(snapshot.experience), projects: map(snapshot.projects), skills: map(snapshot.skills),
      stories: map(snapshot.stories), gaps: map(snapshot.gaps), evidence: map(snapshot.evidence), skillNames,
    };
  }

  _ensureLoaded() {
    if (!this.snapshot) this.load();
  }

  getSnapshot() {
    this._ensureLoaded();
    return clone(this.snapshot);
  }

  getMetadata() {
    this._ensureLoaded();
    return clone(this.snapshot.metadata);
  }

  getIdentity() {
    this._ensureLoaded();
    return clone(this.snapshot.identity);
  }

  getExperiences() {
    this._ensureLoaded();
    return clone(this.snapshot.experience);
  }

  getProjects({ skill } = {}) {
    this._ensureLoaded();
    if (!skill) return clone(this.snapshot.projects);
    const match = this._skill(skill);
    return match ? clone((match.project_refs || []).map(id => this.index.projects.get(id))) : [];
  }

  getSkills() {
    this._ensureLoaded();
    return clone(this.snapshot.skills);
  }

  _skill(name) {
    const id = this.index.skillNames.get(normalized(name));
    return id ? this.index.skills.get(id) : null;
  }

  getSkill(name) {
    this._ensureLoaded();
    return clone(this._skill(name));
  }

  getGaps(query = '') {
    this._ensureLoaded();
    const needle = normalized(query);
    const result = needle
      ? this.snapshot.gaps.filter(item => normalized(`${item.topic} ${item.limitation}`).includes(needle))
      : this.snapshot.gaps;
    return clone(result);
  }

  getStoriesRelated({ skill, project } = {}) {
    this._ensureLoaded();
    let idsToKeep = null;
    if (skill) {
      const match = this._skill(skill);
      if (!match) return [];
      idsToKeep = new Set(match.story_refs || []);
    }
    if (project) {
      const match = this.index.projects.get(project) || this.snapshot.projects.find(item => normalized(item.name) === normalized(project));
      if (!match) return [];
      const projectStories = new Set(match.story_refs || []);
      idsToKeep = idsToKeep ? new Set([...idsToKeep].filter(id => projectStories.has(id))) : projectStories;
    }
    const stories = idsToKeep ? [...idsToKeep].map(id => this.index.stories.get(id)).filter(Boolean) : this.snapshot.stories;
    return clone(stories);
  }

  findEvidence(query) {
    this._ensureLoaded();
    const skill = this._skill(query);
    if (!skill) {
      const gaps = this.getGaps(query);
      return {
        status: 'UNKNOWN', query: String(query), skill: null, projects: [], evidence: [], stories: [], gaps,
        explanation: gaps.length
          ? 'The knowledge base documents this topic only as a gap; it is not a supported claim.'
          : 'No approved candidate evidence supports this topic.',
      };
    }
    return {
      status: 'CONFIRMED', query: String(query), skill: clone(skill),
      projects: clone((skill.project_refs || []).map(id => this.index.projects.get(id)).filter(Boolean)),
      evidence: clone((skill.evidence_refs || []).map(id => this.index.evidence.get(id)).filter(Boolean)),
      stories: clone((skill.story_refs || []).map(id => this.index.stories.get(id)).filter(Boolean)),
      gaps: clone(this.snapshot.gaps.filter(gap => (gap.evidence_refs || []).some(id => (skill.evidence_refs || []).includes(id)))),
      explanation: 'Confirmed candidate evidence is linked through approved local sources.',
    };
  }

  getPreferences() {
    this._ensureLoaded();
    const source = this.snapshot.sources.find(item => item.id === this.snapshot.preferences.source_id);
    const raw = yaml.load(readFileSync(inside(this.projectRoot, source.path, `source ${source.id}`), 'utf8')) || {};
    return Object.fromEntries(Object.entries(this.snapshot.preferences.mappings || {}).map(([name, dotted]) => [name, clone(resolveDotted(raw, dotted))]));
  }

  getApplicationFacts() { this._ensureLoaded(); return clone(this.snapshot.applicationFacts); }

  resolveApplicationField(field) { this._ensureLoaded(); return clone(resolveApplicationField(field, this.snapshot.applicationFacts)); }
}

export function openCandidateKnowledge(options) {
  return new CandidateKnowledgeProvider(options);
}
