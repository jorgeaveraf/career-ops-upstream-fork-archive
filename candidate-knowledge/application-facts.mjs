const text=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const yesNo=(value,field)=>({value:value?'Yes':'No',fact:field});

export function indexApplicationFacts(applicationFacts={}){
  return Object.fromEntries((applicationFacts.facts||[]).filter(item=>item.status==='CONFIRMED').map(item=>[item.normalized_field,item]));
}

export function resolveApplicationField(field,applicationFacts={}){
  const facts=indexApplicationFacts(applicationFacts),label=text(`${field?.label||''} ${field?.name||''} ${field?.autocomplete||''}`);
  const result=(value,fact)=>({status:'ANSWERED',value,fact,source:'CANONICAL_USER_FACT'});
  const unknown=reason=>({status:'NEEDS_HUMAN',reason});
  if(/over the age of 18|18 years of age|mayor de 18/.test(label)&&facts.date_of_birth){const born=new Date(`${facts.date_of_birth.canonical_value}T00:00:00Z`),now=new Date(),age=now.getUTCFullYear()-born.getUTCFullYear()-((now.getUTCMonth()<born.getUTCMonth()||(now.getUTCMonth()===born.getUTCMonth()&&now.getUTCDate()<born.getUTCDate()))?1:0);return result(age>=18?'Yes':'No','date_of_birth');}
  if(/date of birth|birth date|fecha de nacimiento/.test(label)&&facts.date_of_birth)return result(facts.date_of_birth.canonical_value,'date_of_birth');
  if(/passport country|pais del pasaporte/.test(label)&&facts.passport_country)return result(facts.passport_country.canonical_value,'passport_country');
  if(/passport nationality|nacionalidad del pasaporte/.test(label)&&facts.passport_nationality)return result(facts.passport_nationality.canonical_value,'passport_nationality');
  if(/country of citizenship|citizenship country|pais de ciudadania/.test(label)&&facts.citizenship){
    const option=(field.options||[]).find(value=>text(value)===text(facts.passport_country?.canonical_value));
    return result(option||facts.passport_country?.canonical_value||facts.citizenship.canonical_value,'citizenship');
  }
  if(/citizenship|nationality|ciudadania|nacionalidad/.test(label)&&facts.citizenship)return result(facts.citizenship.canonical_value,'citizenship');
  if(/legally authorized|authorized to work|autorizad[oa].*trabajar/.test(label)){
    if(/mexico|méxico/.test(label)&&facts.legal_work_authorization_mexico)return {...result(yesNo(true).value,'legal_work_authorization_mexico')};
    if(/united states|u s |usa|estados unidos/.test(label))return result('No','no_foreign_work_authorization_inference');
    return unknown('No canonical evidence establishes work authorization for the named foreign jurisdiction.');
  }
  if(/sponsor|sponsorship|patrocinio/.test(label)){
    if(/mexico|méxico/.test(label)&&facts.legal_work_authorization_mexico)return result('No','legal_work_authorization_mexico');
    return unknown('Foreign sponsorship requirements are not implied by visa or citizenship facts.');
  }
  if(/(?:currently|current|hold|have).*(?:visa)|(?:visa).*(?:currently|current|hold|have)|visa actual/.test(label)){
    if(/united states|u s |usa|estados unidos/.test(label)&&Array.isArray(facts.current_foreign_visas?.canonical_value))return result('No','current_foreign_visas');
    if (/visa/.test(label)&&Array.isArray(facts.current_foreign_visas?.canonical_value)) return result('No','current_foreign_visas');
  }
  return null;
}
