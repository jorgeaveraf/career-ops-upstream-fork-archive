export function providerFailureOutcome({ required = true, code = 'UPSTREAM_UNAVAILABLE', message = '' } = {}) {
  if (required !== false) return { required: true, status: 'FAILED', code, message, affectsRunStatus: true };
  return { required: false, status: 'SUCCESS', code: 'OPTIONAL_UNAVAILABLE', message, affectsRunStatus: false };
}
