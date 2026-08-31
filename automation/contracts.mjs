export const OPERATIONAL_STATUSES = Object.freeze(['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED']);
export const OPERATIONAL_EXIT_CODES = Object.freeze({ SUCCESS: 0, FAILED: 1, PARTIAL: 2 });
export const ERROR_SEVERITIES = Object.freeze({ INFO: 'INFO', ATTENTION: 'ATTENTION' });

export function operationalError(stage, error, { severity = ERROR_SEVERITIES.ATTENTION, code } = {}) {
  return {
    stage,
    severity,
    code: code || error?.code || `${String(stage).toUpperCase()}_FAILED`,
    message: error?.message || String(error),
  };
}
