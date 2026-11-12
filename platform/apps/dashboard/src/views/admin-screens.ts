// U09 (QUESTIONS #686): the administration screens, loaded on their own (a separate chunk) when a
// person opens one, so the first load of the dashboard stays within its 80 kB budget (ADR-M54).
import messages from 'virtual:dashboard-admin-catalog';

import { addMessages } from '../i18n.js';

// The `dashboard.admin.*` messages come with this chunk.
addMessages(messages);

export { Admin } from './Admin.js';
export { AdminConfig } from './AdminConfig.js';
export { AdminProject } from './AdminProject.js';
export { AdminUser } from './AdminUser.js';
export { AdminAgent } from './AdminAgent.js';
export { AdminAgents } from './AdminAgents.js';
export { AdminHold } from './AdminHold.js';
