// C07 (QUESTIONS #130 A, #126, ADR-M34 §2.3): the runner's check of a run's changed paths. Counts
// and a hash only; the pinned instructions file counts as an instruction change too.
import crypto from 'node:crypto';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { checkChangedPaths } from '../../apps/runner/src/index.js';

const loaded = loadProjectConfig('');
if (!loaded.ok) throw new Error('default configuration refused');
const policy = createSimplePolicyEngine({ config: loaded.config });

describe('checkChangedPaths', () => {
  it('counts paths outside the plan and agent instruction paths', () => {
    const result = checkChangedPaths(
      policy,
      ['apps/web/src/products/**', 'AGENTS.md'],
      [
        'apps/web/src/products/list.vue',
        'apps/api/src/orders.ts',
        'AGENTS.md',
        '.openhands/skills/x.md',
      ],
    );
    expect(result).toMatchObject({ changedFiles: 4, outOfScope: 2, instructionFiles: 2 });
  });

  it('hashes the sorted paths, whatever their order (G5 binds to it)', () => {
    const a = checkChangedPaths(policy, ['**'], ['b.ts', 'a.ts']);
    const b = checkChangedPaths(policy, ['**'], ['a.ts', 'b.ts']);
    expect(a.pathsSha256).toBe(b.pathsSha256);
    expect(a.pathsSha256).toBe(crypto.createHash('sha256').update('["a.ts","b.ts"]').digest('hex'));
  });

  it('an empty change is in scope with no instruction file', () => {
    expect(checkChangedPaths(policy, ['src/**'], [])).toMatchObject({
      changedFiles: 0,
      outOfScope: 0,
      instructionFiles: 0,
    });
  });

  it("O06: counts paths outside the folder, and the folder's own instruction files", () => {
    const result = checkChangedPaths(
      policy,
      ['**'],
      [
        'packages/web/src/a.ts',
        'packages/web/CLAUDE.md',
        'packages/web/.agents/skills/x.md',
        'packages/api/src/b.ts',
        'README.md',
      ],
      'packages/web',
    );
    expect(result).toMatchObject({ changedFiles: 5, outsideFolder: 2, instructionFiles: 2 });
    // Without a folder nothing is outside, and the rule is the repository's.
    expect(checkChangedPaths(policy, ['**'], ['packages/api/src/b.ts'])).toMatchObject({
      outsideFolder: 0,
      instructionFiles: 0,
    });
  });
});
