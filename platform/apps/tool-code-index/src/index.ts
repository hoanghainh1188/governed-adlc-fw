// The register tool `read_code` (task X06 PR 2, design/ADR-M108 §2.8): its MCP handling and the
// checks of its runtime files, for the tests. The process itself is `main.ts`.
export {
  answerText,
  callArguments,
  DEFAULT_LIMIT,
  handleMessage,
  isSafePath,
  logLineOf,
  TOOL_NAMES,
  type CallArgs,
  type CodePlace,
  type JsonRpcAnswer,
  type McpDeps,
  type ToolName,
} from './mcp.js';
export { readRuntime, RuntimeError } from './runtime.js';
