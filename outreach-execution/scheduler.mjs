const DAY = 86400000;
function localParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Mexico_City', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(date);
  return Object.fromEntries(parts.map(item => [item.type, item.value]));
}
function mexicoLocalToUtc({ year, month, day, hour, minute, second = 0 }) {
  const desired = Date.UTC(+year,+month-1,+day,+hour,+minute,+second);
  let guess = desired;
  for (let i=0;i<3;i++) { const p=localParts(new Date(guess)); const observed=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second); guess += desired-observed; }
  return new Date(guess);
}
export function nextBusinessDay(now = new Date(), { hour = 9, minute = 0 } = {}) {
  let cursor = new Date(now.getTime()+DAY);
  for (let i=0;i<7;i++,cursor=new Date(cursor.getTime()+DAY)) {
    const p=localParts(cursor); const weekday=new Intl.DateTimeFormat('en-US',{timeZone:'America/Mexico_City',weekday:'short'}).format(cursor);
    if (!['Sat','Sun'].includes(weekday)) return mexicoLocalToUtc({...p,hour:String(hour),minute:String(minute),second:'0'}).toISOString();
  }
  throw new Error('could not resolve next business day');
}
export function scheduleForPlan(plan, { now = new Date(), applicationConfirmed = false } = {}) {
  if (plan?.timing === 'BEFORE_APPLICATION') return now.toISOString();
  if (!applicationConfirmed) return null;
  if (plan?.timing === 'IMMEDIATELY_AFTER_APPLICATION') return now.toISOString();
  if (plan?.timing === 'NEXT_BUSINESS_DAY') return nextBusinessDay(now);
  return null;
}
export function isDue(value, now = new Date()) { return Boolean(value) && new Date(value).getTime() <= now.getTime(); }
