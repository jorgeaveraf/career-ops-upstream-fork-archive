export const OUTREACH_EXECUTION_VERSION = '4.3';
export const CANDIDATE_GMAIL_SENDER = 'jorgeaveraf@gmail.com';
export const OUTREACH_HUMAN_STATUSES = Object.freeze([
  'NONE', 'READY', 'AUTHORIZED', 'SCHEDULED', 'SENDING', 'SENT',
  'NEEDS_YOU', 'VERIFICATION_REQUIRED', 'FAILED',
]);
export const AUTONOMOUS_CHANNELS = Object.freeze([
  'RECRUITER_EMAIL', 'HIRING_MANAGER_EMAIL', 'GENERAL_RECRUITING', 'LINKEDIN_PROFILE',
]);
export const MANUAL_CHANNELS = Object.freeze([
  'X', 'TWITTER', 'SLACK', 'DISCORD', 'WELLFOUND', 'COMMUNITY',
  'CONTACT_FORM', 'GITHUB', 'OTHER_SOCIAL', 'PLATFORM_MESSAGE',
]);
export const LINKEDIN_MODES = Object.freeze(['DIRECT_MESSAGE', 'CONNECTION_REQUEST_WITH_NOTE', 'INMAIL']);
export const OUTREACH_LIMITS = Object.freeze({ perRun: 5, emailPerDay: 10, linkedinPerDay: 10 });

export function manualOutreachRecommendation({ contact, channel, url, message, reason, timing } = {}) {
  return Object.freeze({ status:'MANUAL_OUTREACH_RECOMMENDED', contact:contact || null,
    channel:String(channel || 'OTHER_SOCIAL').toUpperCase(), publicUrl:String(url || ''),
    suggestedMessage:String(message || ''), reason:String(reason || ''), timing:String(timing || 'NONE'),
    suggestedAction:'Send suggested message manually' });
}

