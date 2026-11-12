// The passkey step-up of an administration change (task U09, design/ADR-M73 §2.4b, QUESTIONS
// #681, #685): a challenge bound to the area, the change, the path and the body, the browser's
// WebAuthn ceremony, and the answer the write puts in its body as `step_up`. The API checks it
// again and uses it once.
import { startAuthentication } from '@simplewebauthn/browser';

import type { ConfirmChange } from '../api/admin-writes.js';
import { stepUpOptions } from '../api/writes.js';
import { PasskeyCancelled } from './step-up.js';

export const confirmAdminChange: ConfirmChange = async (action, request) => {
  const { challenge_id: challengeId, options } = await stepUpOptions({ action, request });
  try {
    const response = await startAuthentication({ optionsJSON: options });
    return { challenge_id: challengeId, response };
  } catch {
    throw new PasskeyCancelled('cancelled');
  }
};
