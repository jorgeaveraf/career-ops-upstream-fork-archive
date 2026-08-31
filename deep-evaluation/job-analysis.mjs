import { hashStable } from '../acquisition/normalize.mjs';

const TERMS = [
  ['RAG', 'skill', /\b(?:rag|retrieval[- ]augmented generation|contextual retrieval)\b/i],
  ['Python', 'technology', /\bpython\b/i],
  ['Kubernetes', 'technology', /\bkubernetes|\bk8s\b/i],
  ['Docker', 'technology', /\bdocker|containeri[sz](?:e|ed|ation)\b/i],
  ['AI systems', 'architecture', /\b(?:ai|llm)[ -](?:powered )?systems?\b/i],
  ['backend systems', 'architecture', /\bbackend (?:systems?|services?|platforms?)\b/i],
  ['ML model training', 'experience', /\b(?:machine learning|ml) (?:model )?(?:training|development)\b/i],
  ['systems architecture', 'architecture', /\b(?:systems? architecture|system design)\b/i],
  ['API integrations', 'architecture', /\b(?:api integrations?|systems? integration|api synchronization)\b/i],
  ['data platforms', 'architecture', /\b(?:data platforms?|data engineering|etl|elt)\b/i],
  ['production reliability', 'architecture', /\b(?:production reliability|idempotency|retries|auditability|monitoring)\b/i],
  ['financial systems', 'domain', /\b(?:financial systems?|fintech|accounting systems?)\b/i],
  ['stakeholder communication', 'soft_skill', /\b(?:stakeholder communication|communicat(?:e|ion) with stakeholders)\b/i],
  ['leadership', 'seniority', /\b(?:technical leadership|team leadership|lead engineers?)\b/i],
];

function clean(value) { return String(value ?? '').replace(/\r/g, '').trim(); }
function lines(value) { return clean(value).split(/\n+/).map(line => line.replace(/^\s*[-*•\d.)]+\s*/, '').trim()).filter(Boolean); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function seniority(title, description) {
  const text = `${title} ${description}`;
  if (/\b(?:director|head|vp|vice president)\b/i.test(text)) return 'director';
  if (/\bprincipal\b/i.test(text)) return 'principal';
  if (/\b(?:lead|staff)\b/i.test(text)) return 'lead_staff';
  if (/\bsenior|\bsr\.?\b/i.test(text)) return 'senior';
  if (/\bjunior|\bjr\.?\b/i.test(text)) return 'junior';
  return 'unspecified';
}

function sectionImportance(description, index) {
  const before = description.slice(0, index).split('\n').slice(-2).join(' ');
  if (/preferred|nice to have|bonus|plus/i.test(before)) return { importance: 'medium', priority: 'nice_to_have' };
  if (/required|requirements|must have|qualifications/i.test(before)) return { importance: 'high', priority: 'must_have' };
  return { importance: 'medium', priority: 'supporting' };
}

function evidenceNeeded(type) {
  if (type === 'soft_skill') return ['stories', 'experience', 'evidence'];
  if (type === 'domain' || type === 'business_context') return ['projects', 'experience', 'evidence'];
  if (type === 'seniority') return ['experience', 'stories', 'evidence'];
  return ['skills', 'projects', 'stories', 'evidence'];
}

export function analyzeJob(job) {
  const title = clean(job?.title);
  const company = clean(job?.company);
  const description = clean(job?.description);
  if (!title) throw new TypeError('job.title is required');
  if (!company) throw new TypeError('job.company is required');
  const requirements = [];
  for (const [label, type, pattern] of TERMS) {
    const match = pattern.exec(description);
    if (!match) continue;
    const context = sectionImportance(description, match.index);
    const sourceText = lines(description).find(line => pattern.test(line)) || label;
    requirements.push({ id: `req.${slug(label)}`, label, type, ...context, evidenceNeeded: evidenceNeeded(type), sourceText });
  }
  const hiddenSignals = unique([
    /ownership|own end.to.end/i.test(description) && 'ownership',
    /on[- ]call|incident response/i.test(description) && 'on_call',
    /fast[- ]paced|startup/i.test(description) && 'startup_pace',
    /manage|direct reports/i.test(description) && 'people_management',
    /research|publication/i.test(description) && 'research_heavy',
  ]);
  const responsibilities = lines(description).filter(line => /build|design|develop|lead|own|operate|deliver|collaborate|maintain/i.test(line)).slice(0, 12);
  const employmentModel = /contract|freelance/i.test(description) ? 'contract'
    : /full[- ]time/i.test(description) ? 'full_time' : 'unspecified';
  const locationModel = /worldwide|anywhere/i.test(`${job.location || ''} ${description}`) ? 'worldwide_remote'
    : /remote/i.test(`${job.location || ''} ${description}`) ? 'remote' : clean(job.location) || 'unspecified';
  const analysis = {
    title, company, seniority: seniority(title, description), responsibilities,
    requiredSkills: requirements.filter(item => item.priority === 'must_have').map(item => item.label),
    preferredSkills: requirements.filter(item => item.priority === 'nice_to_have').map(item => item.label),
    technologies: requirements.filter(item => item.type === 'technology').map(item => item.label),
    domains: requirements.filter(item => item.type === 'domain').map(item => item.label),
    employmentModel, locationModel, hiddenSignals, requirements,
  };
  return { ...analysis, hash: hashStable(JSON.stringify(analysis)) };
}
