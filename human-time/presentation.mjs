export const HUMAN_TIME_ZONE = 'America/Mexico_City';

const MONTHS = Object.freeze(['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic']);

function zonedParts(value, timeZone = HUMAN_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const entries = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]);
  return { date, ...Object.fromEntries(entries) };
}

function dayNumber(parts) { return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000; }

export function formatHumanTime(value, { timeZone = HUMAN_TIME_ZONE, now = new Date(), relative = true } = {}) {
  if (!value) return '';
  const target = zonedParts(value, timeZone), current = zonedParts(now, timeZone);
  if (!target || !current) return String(value);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(target.date).replace(/\s/g, ' ').toUpperCase();
  const delta = dayNumber(current) - dayNumber(target);
  if (relative && delta === 0) return `Hoy · ${time}`;
  if (relative && delta === 1) return `Ayer · ${time}`;
  return `${Number(target.day)} ${MONTHS[Number(target.month) - 1]} ${target.year} · ${time}`;
}

export function formatHumanDate(value, { timeZone = HUMAN_TIME_ZONE } = {}) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split('-').map(Number);
    return `${day} ${MONTHS[month - 1]} ${year}`;
  }
  const target = zonedParts(value, timeZone);
  return target ? `${Number(target.day)} ${MONTHS[Number(target.month) - 1]} ${target.year}` : String(value);
}

export function containsRawUtc(value) { return /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/.test(String(value || '')); }
