// Shared helpers of the agent adapters (design/ADR-M88 §2.3, QUESTIONS #527): the task message
// (each adapter gives its own last rule), the checks of the task, the git commands of ADR-M29 §2.5
// with their parsers, the loop key, and the files an agent opened (X07). No I/O. Only
// `@sdlc/adapter-agent-*` imports this package.
export {
  commitCommand,
  diffCommand,
  parseCommitOutput,
  parseDiffOutput,
  SANDBOX_GIT,
  unquoteGitPath,
  type CommitAnswer,
  type DiffAnswer,
} from './git.js';
export { callKey, canonicalArguments, trailingEqual } from './loop.js';
export { fileReadsOf, workspacePath } from './reads.js';
export {
  agentWorkingDir,
  buildTaskMessage,
  checkTask,
  CI_FAILED_INSTRUCTION,
  feedbackBlock,
  INSTRUCTIONS_FILE,
  planTaskBlock,
  toolsOf,
  type TaskMessageOptions,
} from './task.js';
