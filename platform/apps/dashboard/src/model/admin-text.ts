// The catalog text of a refused or failed administration change (U09): the API's own sentence
// (`api.error.<code>`), with the role that conflicts (`conflicting_role`) or the configuration's
// problems in the API's words (`config_rejected`); otherwise the general text of an action.
import { cleanText } from '@sdlc/api-schemas';

import { ApiError } from '../api/client.js';
import { t } from '../i18n.js';
import { adminErrorKey } from './admin.js';
import { actionErrorText } from './decisions.js';

/** At most this many configuration problems in one message. */
const MAX_PROBLEMS = 10;

export function adminErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return actionErrorText(error);
  const key = adminErrorKey(error.code);
  if (key === null) return actionErrorText(error);
  const text = t(key);
  // An agent register refusal: the API's own sentence names the agent and the reason.
  if (error.reasonMessage !== undefined && error.reasonMessage !== '') {
    return `${text} ${cleanText(error.reasonMessage)}`;
  }
  if (error.code === 'conflicting_role' && error.reason !== undefined) {
    return `${text} ${t('dashboard.admin.error.conflicting_role', { role: cleanText(error.reason) })}`;
  }
  const problems = (error.details ?? [])
    .map((d) => d.message)
    .filter((m): m is string => m !== undefined && m !== '')
    .slice(0, MAX_PROBLEMS)
    .map((m) => cleanText(m));
  return problems.length === 0 ? text : `${text} ${problems.join(' ')}`;
}
