const bounded = value => Math.max(0, Math.min(100, Math.round(value)));

export function scoreFacebookAuthenticity(signal = {}) {
  let score = 0; const reasons = [];
  const positive = [
    ['applicationEmail', 30, 'Visible application email'],
    ['companyIdentified', 20, 'Identifiable company'],
    ['stackDefined', 10, 'Defined technology stack'],
    ['responsibilitiesClear', 10, 'Clear responsibilities'],
    ['salaryVisible', 10, 'Visible compensation'],
  ];
  for (const [field, weight, reason] of positive) if (signal[field] === true) { score += weight; reasons.push(`+${weight} ${reason}`); }
  if (signal.descriptionQuality === 'high') { score += 20; reasons.push('+20 Complete description'); }
  else if (signal.descriptionQuality === 'medium') { score += 10; reasons.push('+10 Partial description'); }
  const negative = [
    ['poolLanguage', 35, 'Talent-pool language'], ['communityOnly', 20, 'Community-only post'],
    ['recruiterSpam', 40, 'Recruiter spam'], ['registerHere', 25, 'Registration funnel'],
    ['marketplace', 30, 'Marketplace signal'],
  ];
  for (const [field, weight, reason] of negative) if (signal[field] === true) { score -= weight; reasons.push(`-${weight} ${reason}`); }
  return { score: bounded(score), band: score >= 75 ? 'HIGH' : score >= 45 ? 'MEDIUM' : 'LOW', reasons };
}
