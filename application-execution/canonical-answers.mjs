import{existsSync,readFileSync}from'fs';import yaml from'js-yaml';import{resolveApplicationField}from'../candidate-knowledge/application-facts.mjs';
const clean=value=>String(value??'').trim();
export function loadCanonicalApplicationAnswers({profilePath='config/profile.yml',applicationFactsPath='candidate/application-profile.yml'}={}){
  const profile=yaml.load(readFileSync(profilePath,'utf8'))||{},candidate=profile.candidate||{},location=profile.location||{};const answers={fullName:clean(candidate.full_name),email:clean(candidate.email),phone:clean(candidate.phone),location:clean(candidate.location)||[location.city,location.country].map(clean).filter(Boolean).join(', '),residenceCountry:clean(location.country),linkedin:clean(candidate.linkedin),portfolio:clean(candidate.portfolio)||clean(candidate.github),language:{english:(profile.language?.vacancy_languages||[]).find(item=>String(item.language).toLowerCase()==='english')||null},compensation:{byEmploymentType:profile.compensation?.by_employment_type||{}}};
  if(Array.isArray(location.authorized_in)&&location.authorized_in.length)answers.authorizedIn=location.authorized_in.map(clean).filter(Boolean);
  if(typeof location.needs_sponsorship==='boolean')answers.needsSponsorship=location.needs_sponsorship;
  if(existsSync(applicationFactsPath))answers.applicationFacts=(yaml.load(readFileSync(applicationFactsPath,'utf8'))||{}).application_facts||{};
  if(existsSync('candidate/experience.yml'))answers.experience=(yaml.load(readFileSync('candidate/experience.yml','utf8'))||{}).experience||[];
  if(existsSync('candidate/skills.yml'))answers.skills=(yaml.load(readFileSync('candidate/skills.yml','utf8'))||{}).skills||[];
  if(existsSync('candidate/projects.yml'))answers.projects=(yaml.load(readFileSync('candidate/projects.yml','utf8'))||{}).projects||[];
  if(existsSync('cv.md')){const cv=readFileSync('cv.md','utf8'),match=cv.match(/## AI Systems Engineer\s+([^#]+?)(?=\n## )/s);if(match)answers.professionalSummary=clean(match[1]);}
  return Object.fromEntries(Object.entries(answers).filter(([,value])=>Array.isArray(value)?value.length:value!==''));
}

export function answerForField(field,answers={}){
  const label=`${field.label||''} ${field.name||''} ${field.autocomplete||''}`.toLowerCase();
  if(field.type==='file')return/cover/.test(label)?{kind:'cover'}:{kind:'resume'};
  if(/first.?name|given.?name/.test(label)&&answers.fullName)return{value:answers.fullName.split(/\s+/)[0]};
  if(/last.?name|family.?name|surname/.test(label)&&answers.fullName)return{value:answers.fullName.split(/\s+/).slice(1).join(' ')};
  if(/full.?name|your name|candidate.?name/.test(label)||clean(field.label).toLowerCase()==='name')if(answers.fullName)return{value:answers.fullName};
  if(/e-?mail/.test(label)&&answers.email)return{value:answers.email};
  if(/phone|mobile|tel/.test(label)&&answers.phone)return{value:answers.phone};
  if(/linkedin/.test(label)&&answers.linkedin)return{value:answers.linkedin};
  if(/portfolio|website|github/.test(label)&&answers.portfolio)return{value:answers.portfolio};
  if(/location|city|address/.test(label)&&answers.location)return{value:answers.location};
  if(/country of residence|residence country|pais de residencia|país de residencia/.test(label)&&answers.residenceCountry)return{value:answers.residenceCountry};
  const applicationFact=resolveApplicationField(field,answers.applicationFacts);if(applicationFact?.status==='ANSWERED')return{value:applicationFact.value,fact:applicationFact.fact,source:applicationFact.source};
  if(applicationFact?.status==='NEEDS_HUMAN')return null;
  if(/sponsor/.test(label)&&typeof answers.needsSponsorship==='boolean'&&/mexico|méxico/.test(label))return{value:answers.needsSponsorship?'Yes':'No'};
  return null;
}
