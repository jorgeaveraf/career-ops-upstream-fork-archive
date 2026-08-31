function parts(date, timeZone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, minuteOfDay: Number(values.hour) * 60 + Number(values.minute) };
}

export function shouldRunScheduled({ registry, now = new Date(), timeZone = 'America/Mexico_City', hour = 8, minute = 30 } = {}) {
  if (!registry) throw new TypeError('registry is required');
  const current = parts(now, timeZone); const scheduledMinute = Number(hour) * 60 + Number(minute);
  if (current.minuteOfDay < scheduledMinute) return { run: false, reason: 'BEFORE_SCHEDULE', date: current.date, timeZone };
  const latest = registry.getLatestOperationalRun();
  if (latest && parts(new Date(latest.startedAt), timeZone).date === current.date) {
    return { run: false, reason: 'ALREADY_RAN_TODAY', date: current.date, timeZone, operationalRunId: latest.id, status: latest.status };
  }
  return { run: true, reason: 'DUE', date: current.date, timeZone };
}
