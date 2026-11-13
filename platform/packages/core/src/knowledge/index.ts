// The index of a project's documents (task X04 PR 3a, design/ADR-M89).
export { chunkKey, chunkMarkdown, isMarkdownPath } from './chunk.js';
export {
  buildProjectIndex,
  type BuildIndexInput,
  type BuiltIndex,
  type KnowledgeDeps,
} from './indexer.js';
// The code index of a project (task X06, design/ADR-M108).
export { isSkippedPath, resolveImport } from './code-paths.js';
export {
  buildCodeIndex,
  type BuildCodeIndexInput,
  type BuiltCodeIndex,
  type CodeIndexDeps,
} from './code-indexer.js';
