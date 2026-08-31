export class NotificationProvider {
  constructor({ id = 'notification-provider', channel = 'unknown' } = {}) { this.id = id; this.channel = channel; }
  async sendSummary(_message) { throw new Error('sendSummary is not implemented'); }
}

export class MemoryNotificationProvider extends NotificationProvider {
  constructor() { super({ id: 'memory', channel: 'email' }); this.messages = []; }
  async sendSummary(message) {
    this.messages.push(structuredClone(message));
    return { id: `memory-${this.messages.length}`, status: 'SENT' };
  }
}

export class ResendEmailProvider extends NotificationProvider {
  constructor({ apiKey, from, to, fetchImpl = globalThis.fetch, endpoint = 'https://api.resend.com/emails' } = {}) {
    super({ id: 'resend', channel: 'email' });
    if (!apiKey) throw new TypeError('RESEND_API_KEY is required');
    if (!from) throw new TypeError('CAREER_OPS_EMAIL_FROM is required');
    if (!to) throw new TypeError('CAREER_OPS_EMAIL_TO is required');
    this.apiKey = apiKey; this.from = from; this.to = to; this.fetch = fetchImpl; this.endpoint = endpoint;
  }
  async sendSummary({ subject, text, idempotencyKey }) {
    let response;
    try { response = await this.fetch(this.endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from: this.from, to: [this.to], subject, text }),
    }); } catch (cause) { const error=new Error('email provider outcome is unknown after a transport failure');error.code='EMAIL_SEND_AMBIGUOUS';error.ambiguous=true;error.cause=cause;throw error; }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`email provider ${response.status}: ${body.message || response.statusText}`);
      error.code = response.status===429||response.status>=500?'EMAIL_SEND_TRANSIENT':'EMAIL_SEND_PERMANENT';error.transient=error.code==='EMAIL_SEND_TRANSIENT'; throw error;
    }
    return { id: body.id || null, status: 'SENT' };
  }
}

function recommendationBlock(item, index) {
  const why = (item.reasons || []).filter(Boolean).slice(0, 3);
  return [
    `${index + 1}. ${item.company}`, `Role: ${item.role}`, `Priority: ${item.priority}`,
    ...(why.length ? ['Why:', ...why.map(reason => `- ${reason}`)] : []),
    item.packageReady ? 'Package: Ready for review' : null,
    item.jobUrl ? `Job: ${item.jobUrl}` : null,
  ].filter(Boolean).join('\n');
}

export function buildEmailMessage(summary, { from, to } = {}) {
  const reviewCount = Math.max(summary.ranking.shortlisted, summary.packages.ready);
  const opportunityLabel = reviewCount === 1 ? 'opportunity' : 'opportunities';
  const reviewVerb = reviewCount === 1 ? 'requires' : 'require';
  const attention = summary.errors.some(item => item.severity === 'ATTENTION');
  const subject = attention
    ? `Career Ops Alert — ${summary.errors.filter(item => item.severity === 'ATTENTION').length} issue(s) require attention`
    : `Career Ops Daily Report — ${reviewCount} ${opportunityLabel} ${reviewVerb} review`;
  const sections = [
    "Career Ops completed today's operational run.", '',
    `New opportunities: ${summary.discovery.newJobs}`,
    `Shortlisted: ${summary.ranking.shortlisted}`,
    `Packages ready: ${summary.packages.ready}`,
  ];
  if (summary.topRecommendations.length) {
    sections.push('', 'Top recommendations:', '', ...summary.topRecommendations.map(recommendationBlock));
  }
  const attentionErrors = summary.errors.filter(item => item.severity === 'ATTENTION');
  if (attentionErrors.length) {
    sections.push('', 'System attention:', ...attentionErrors.map(item => `- [${item.code}] ${item.message}`));
  }
  if (summary.dashboardUrl) sections.push('', `Dashboard: ${summary.dashboardUrl}`);
  sections.push('', `System status: ${summary.run.status === 'SUCCESS' ? 'Healthy' : summary.run.status}`,
    `Run: ${summary.run.id}`);
  return { from, to, subject, text: sections.join('\n') };
}

export function notificationProviderFromEnv(env = process.env) {
  if (String(env.CAREER_OPS_NOTIFICATIONS_ENABLED).toLowerCase() !== 'true') return null;
  const provider = String(env.CAREER_OPS_EMAIL_PROVIDER || 'resend').toLowerCase();
  if (provider !== 'resend') throw new Error(`unsupported email provider: ${provider}`);
  return new ResendEmailProvider({
    apiKey: env.RESEND_API_KEY, from: env.CAREER_OPS_EMAIL_FROM, to: env.CAREER_OPS_NOTIFICATION_RECIPIENT || env.CAREER_OPS_EMAIL_TO,
  });
}
