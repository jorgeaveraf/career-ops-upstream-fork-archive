import { normalizeJobTitle } from '../acquisition/normalize.mjs';

export function normalizedText(...values) {
  return values.filter(value => typeof value === 'string').join('\n').normalize('NFKC').toLowerCase();
}

export function hasPhrase(haystack, phrase) {
  const needle = String(phrase || '').trim().toLowerCase();
  if (!needle) return false;
  if (/^[a-z]{2,3}$/.test(needle)) return new RegExp(`\\b${needle}\\b`, 'i').test(haystack);
  return haystack.includes(needle);
}

export function firstPhrase(haystack, phrases) {
  return (phrases || []).find(phrase => hasPhrase(haystack, phrase)) || '';
}

export function detectEmploymentModel(job) {
  const content = normalizedText(job?.title, job?.location, job?.description, job?.employmentType);
  const rules = [
    ['fractional', /\bfractional\b/],
    ['part_time', /\bpart[ -]?time\b|\b20\s*(?:hours|hrs)\b/],
    ['contract', /\bcontract(?:or|ing)?\b|\bfreelance\b|\bindependent consultant\b/],
    ['full_time', /\bfull[ -]?time\b|\bpermanent employee\b/],
  ];
  for (const [model, pattern] of rules) if (pattern.test(content)) return { model, matched: content.match(pattern)?.[0] || model };
  return { model: 'unknown', matched: '' };
}

function periodKey(value) {
  const raw = String(value || '').toLowerCase();
  if (/hour|hourly/.test(raw)) return 'hour';
  if (/month|monthly/.test(raw)) return 'month';
  if (/year|annual|annually/.test(raw)) return 'year';
  return '';
}

function structuredCompensation(job) {
  const raw = job?.salary || job?.compensation || job?.rawMetadata?.salary;
  if (!raw || typeof raw !== 'object') return null;
  const min = Number(raw.min ?? raw.minimum);
  const max = Number(raw.max ?? raw.maximum);
  const hasMin = Number.isFinite(min) && min >= 0;
  const hasMax = Number.isFinite(max) && max >= 0;
  if (!hasMin && !hasMax) return null;
  return {
    min: hasMin ? min : null,
    max: hasMax ? max : null,
    currency: String(raw.currency || '').trim().toUpperCase(),
    period: periodKey(raw.period || raw.interval) || 'year',
    source: 'structured_compensation',
    confidence: 'high',
  };
}

function parsedHourlyCompensation(job) {
  const content = normalizedText(job?.description);
  const patterns = [
    /\b(usd|mxn|eur)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:-|to)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:\/|per\s+)(?:hour|hr)\b/i,
    /\$\s*(\d+(?:\.\d+)?)\s*(?:-|to)\s*\$\s*(\d+(?:\.\d+)?)\s*(?:\/|per\s+)(?:hour|hr)\b/i,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (!match) continue;
    const currencyFirst = /^[a-z]/i.test(match[1]);
    return {
      min: Number(match[currencyFirst ? 2 : 1]),
      max: Number(match[currencyFirst ? 3 : 2]),
      currency: currencyFirst ? match[1].toUpperCase() : 'USD',
      period: 'hour', source: 'description_parse', confidence: 'low',
    };
  }
  return null;
}

export function compensationSignal(job, employmentModel, policy) {
  const value = structuredCompensation(job) || parsedHourlyCompensation(job);
  if (!value) return { status: 'UNKNOWN', value: null, comparison: 'not_available', reason: 'Compensation is not stated.' };
  const target = policy?.compensation?.[employmentModel];
  if (!target || target.minimum == null) {
    return { status: value.confidence === 'high' ? 'KNOWN' : 'LOW_CONFIDENCE', value, target: null, comparison: 'no_matching_floor', reason: 'Compensation is present, but no matching profile floor applies.' };
  }
  if (!value.currency || value.currency !== target.currency || value.period !== target.period) {
    return { status: 'LOW_CONFIDENCE', value, target, comparison: 'not_comparable', reason: 'Compensation cannot be compared without converting currency or period.' };
  }
  const upper = value.max ?? value.min;
  const lower = value.min ?? value.max;
  const status = value.confidence === 'high' ? 'KNOWN' : 'LOW_CONFIDENCE';
  if (upper < target.minimum) return { status, value, target, comparison: 'below_minimum', reason: `Compensation appears below the configured ${employmentModel} minimum.` };
  if (target.desired != null && lower >= target.desired) return { status, value, target, comparison: 'at_or_above_desired', reason: `Compensation appears to meet the configured ${employmentModel} desired level.` };
  return { status, value, target, comparison: 'meets_minimum', reason: `Compensation appears to meet the configured ${employmentModel} minimum.` };
}

export function minimumWeeklyHours(job) {
  const content = normalizedText(job?.description);
  const match = content.match(/\b(?:minimum|min\.?|at least)?\s*(\d{1,2})\s*(?:hours|hrs)\s*(?:per|a|\/)\s*week\b/);
  return match ? Number(match[1]) : null;
}

export function normalizedTitleTokens(value) {
  return normalizeJobTitle(value).split(' ').filter(Boolean);
}
