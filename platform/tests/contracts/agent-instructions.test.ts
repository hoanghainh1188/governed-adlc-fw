// C07 (QUESTIONS #126, ADR-M34 §2.4): the paths OpenHands 1.48.0 reads as instructions, folded.
import {
  isAgentInstructionPath,
  isRootLevelInstructionPath,
  readsAsInstructions,
  unpinnedInstructionPaths,
  unpinnedInstructionPathsIn,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

describe('isAgentInstructionPath', () => {
  it.each([
    'AGENTS.md',
    'agents.md',
    'Agents.MD',
    'agent.md',
    'CLAUDE.md',
    'claude.md',
    'GEMINI.md',
    '.cursorrules',
    '.CursorRules',
    'apps/api/AGENTS.md',
    'deep/a/b/agents.md',
    '.agents/skills/deploy.md',
    '.agents/skills/sub/SKILL.md',
    '.openhands/skills/x.md',
    '.OpenHands/Microagents/repo.md',
    'AGENTS\u200B.md',
    './AGENTS.md',
  ])('%j is an instruction file', (path) => {
    expect(isAgentInstructionPath(path)).toBe(true);
  });

  it.each([
    'README.md',
    'docs/CLAUDE.md',
    'apps/agent.md',
    'src/.cursorrules',
    'docs/GEMINI.md',
    '.agents/README.md',
    '.openhands/setup.sh',
    'x/.openhands/skills/a.md',
    'AGENTS.md.bak',
    '',
  ])('%j is not an instruction file', (path) => {
    expect(isAgentInstructionPath(path)).toBe(false);
  });
});

describe('unpinnedInstructionPaths (G4)', () => {
  it('leaves out the pinned file only, by its exact path', () => {
    expect(
      unpinnedInstructionPaths(
        ['AGENTS.md', 'agents.md', 'src/main.ts', 'apps/api/AGENTS.md', 'README.md'],
        'AGENTS.md',
      ),
    ).toEqual(['agents.md', 'apps/api/AGENTS.md']);
  });

  it('is empty for a repository with only the pinned file', () => {
    expect(unpinnedInstructionPaths(['AGENTS.md', 'src/a.ts'], 'AGENTS.md')).toEqual([]);
  });
});

// O06 (ADR-M106 §2.4): what OpenHands 1.48.0 reads when it works in a project folder.
describe('isRootLevelInstructionPath', () => {
  it.each([
    'AGENTS.md',
    'claude.md',
    '.cursorrules',
    '.agents/skills/x.md',
    '.openhands/microagents/a',
  ])('counts %j', (path) => expect(isRootLevelInstructionPath(path)).toBe(true));
  it.each([
    'packages/web/AGENTS.md',
    'docs/CLAUDE.md',
    'README.md',
    'packages/.agents/skills/x.md',
  ])('does not count %j', (path) => expect(isRootLevelInstructionPath(path)).toBe(false));
});

describe('readsAsInstructions with a folder', () => {
  const web = 'packages/web';
  it.each([
    ['packages/web/AGENTS.md', true],
    ['packages/web/CLAUDE.md', true],
    ['packages/web/.agents/skills/x.md', true],
    ['packages/web/src/AGENTS.md', true],
    ['AGENTS.md', true],
    ['.openhands/skills/y.md', true],
    ['packages/api/AGENTS.md', false],
    ['packages/api/CLAUDE.md', false],
    ['packages/web2/AGENTS.md', false],
    ['packages/web/src/main.ts', false],
  ])('%j: %s', (path, expected) => expect(readsAsInstructions(path, web)).toBe(expected));

  it('an empty folder is the repository rule', () => {
    expect(readsAsInstructions('packages/api/AGENTS.md', '')).toBe(true);
    expect(readsAsInstructions('packages/web/CLAUDE.md', '')).toBe(false);
  });

  it('leaves out only the exact pinned paths', () => {
    const paths = [
      'AGENTS.md',
      'packages/web/AGENTS.md',
      'packages/web/src/AGENTS.md',
      'packages/api/AGENTS.md',
      'CLAUDE.md',
    ];
    expect(
      unpinnedInstructionPathsIn(paths, 'packages/web', ['packages/web/AGENTS.md', 'AGENTS.md']),
    ).toEqual(['packages/web/src/AGENTS.md', 'CLAUDE.md']);
  });
});
