const clean = value => String(value || '').toLowerCase();
const countMatches = (text, terms) => terms.filter(term => clean(text).includes(term)).length;
const bounded = value => Math.max(0, Math.min(100, Math.round(value)));
export function scoreFacebookCommunity(candidate = {}, strategy = {}) {
  const text = `${candidate.name || ''} ${candidate.description || ''} ${candidate.topic || ''}`.toLowerCase();
  const relevanceTerms = [...(strategy.roles?.primary || []), ...(strategy.roles?.secondary || []), ...(strategy.technologies || []), 'automation','remote','latam','ai','data','python','cloud','llm'].map(clean).filter(Boolean);
  const relevance = bounded(countMatches(text, relevanceTerms) * 12);
  const activity = bounded(candidate.activityScore ?? (/active|posts? (?:a|per) (?:day|week)|publicaciones/i.test(text) ? 65 : candidate.recentActivity ? 55 : 20));
  const opportunity = bounded(candidate.opportunityScore ?? countMatches(text, ['job','jobs','hiring','vacante','empleo','contract','freelance','project']) * 20);
  const qualitySignals = countMatches(text, ['salary','compensation','stack','responsibilities','company','apply','email','remote']);
  const spamSignals = countMatches(text, ['course','curso','affiliate','crypto','earn money','engagement','marketing','promoción','promotion','register here']);
  const spam = bounded(candidate.spamScore ?? spamSignals * 22);
  const quality = bounded(relevance * 0.4 + activity * 0.2 + opportunity * 0.3 + qualitySignals * 3 - spam * 0.45);
  const recommendation = spam >= 75 ? 'REJECTED' : quality >= 70 ? 'RECOMMENDED' : quality >= 48 ? 'CONSIDER' : quality >= 25 ? 'LOW_VALUE' : 'UNKNOWN';
  const reasons = [`Relevance ${relevance}/100`, `Activity ${activity}/100`, `Opportunity signal ${opportunity}/100`, `Spam ${spam}/100`];
  return { relevanceScore: relevance, activityScore: activity, opportunityScore: opportunity, spamScore: spam, qualityScore: quality, recommendation, reasons };
}
