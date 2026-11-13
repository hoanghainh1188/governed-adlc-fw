// Agent memory settings (X13 PR 1, design/ADR-M74 §2.2, QUESTIONS #574): `memory` is off by
// default with the caps Harry chose; the bounds of each cap; rule M36 (an error) keeps a file's cap
// within the total and allows proposals only when an agent may run at L2.
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

describe('memory', () => {
  it('is off by default: 20 files, 4,000 characters per file, 12,000 in total', () => {
    const { config, warnings } = loadValid();
    expect(config.memory).toEqual({
      mode: 'off',
      max_files: 20,
      max_file_chars: 4000,
      max_total_chars: 12000,
    });
    expect(warnings).toEqual([]);
  });

  it('accepts read and read_propose on a project whose agents may run at L2', () => {
    expect(loadValid('memory:\n  mode: read\n').config.memory.mode).toBe('read');
    expect(loadValid('memory:\n  mode: read_propose\n').config.memory.mode).toBe('read_propose');
  });

  it.each([
    ['max_files: 0', 'memory.max_files'],
    ['max_files: 51', 'memory.max_files'],
    ['max_file_chars: 499', 'memory.max_file_chars'],
    ['max_file_chars: 8001', 'memory.max_file_chars'],
    ['max_total_chars: 999', 'memory.max_total_chars'],
    ['max_total_chars: 24001', 'memory.max_total_chars'],
    ['mode: on', 'memory.mode'],
    ['path: notes', 'memory'],
  ])('refuses %s', (line, path) => {
    const paths = keysAndPaths(loadErrors(`memory:\n  ${line}\n`)).map(([, p]) => p);
    expect(paths).toContain(path);
  });

  it('M36: a file cap above the total cap is an error', () => {
    expect(
      keysAndPaths(loadErrors('memory:\n  max_file_chars: 5000\n  max_total_chars: 4000\n')),
    ).toContainEqual(['config.rule.memory_file_over_total', 'memory.max_file_chars']);
  });

  it('M36: read_propose on an L1-only project is an error; read is allowed there', () => {
    const l1 = 'autonomy:\n  max_by_risk: { low: L1, medium: L1, high: L1, critical: L0 }\n';
    expect(keysAndPaths(loadErrors(`${l1}memory:\n  mode: read_propose\n`))).toContainEqual([
      'config.rule.memory_propose_needs_l2',
      'memory.mode',
    ]);
    expect(loadValid(`${l1}memory:\n  mode: read\n`).config.memory.mode).toBe('read');
  });
});
