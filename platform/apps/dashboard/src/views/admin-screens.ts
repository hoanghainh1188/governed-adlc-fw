// U09 (QUESTIONS #686): the administration screens, loaded on their own (a separate chunk) when a
// person opens one, so the first load of the dashboard stays within its 80 kB budget (ADR-M54).
import messages from 'virtual:dashboard-admin-catalog';
import lessonMessages from 'virtual:dashboard-lessons-catalog';

import { addMessages } from '../i18n.js';

// The `dashboard.admin.*` messages come with this chunk.
addMessages(messages);
// X08b PR 3: the lessons screen rides in this chunk too; a second lazy chunk would split the
// first load into two files (a shared chunk), so it stays one chunk of on-demand screens.
addMessages(lessonMessages);

export { Admin } from './Admin.js';
export { AdminConfig } from './AdminConfig.js';
export { AdminProject } from './AdminProject.js';
export { AdminUser } from './AdminUser.js';
export { AdminAgent } from './AdminAgent.js';
export { AdminAgents } from './AdminAgents.js';
export { AdminHold } from './AdminHold.js';
export { Lessons } from './Lessons.js';
