// B07 session 2 (ADR-M30 §2.4b, §2.9): the pure parts of the HOTL block window and the gate
// deadline, on the working calendar of the configuration. The database side: integration/db.
import { loadProjectConfig } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { waitedSeconds } from '../../packages/core/src/workflow/step.js';
import {
  blockWindowDuration,
  blockWindowEnd,
  gateBefore,
} from '../../packages/core/src/workflow/hotl.js';
import {
  gateClockStart,
  gateDeadline,
  overdueRoute,
} from '../../packages/core/src/workflow/overdue.js';
import { MIN_TIMER_MS } from '../../apps/worker/src/workflows/intent-workflow.js';

const loaded = loadProjectConfig('');
if (!loaded.ok) throw new Error('defaults must load');
const config = loaded.config;

describe('HOTL block window (QUESTIONS #88)', () => {
  it('counts oversight.hotl_block_window in working hours of the calendar', () => {
    // Friday 16:00 in Ho Chi Minh City + 4 working hours = Monday 11:00 local.
    expect(blockWindowEnd(new Date('2026-10-02T09:00:00Z'), config)).toEqual(
      new Date('2026-10-05T04:00:00Z'),
    );
  });

  it('resolves per-gate overrides and falls back to hotl_block_window (V21, #557)', () => {
    const custom = loadProjectConfig(`
oversight:
  hotl_block_window: { value: 1, unit: working_hours }
  hotl_block_window_by_gate:
    G2: { value: 15, unit: minutes }
    G3: { value: 30, unit: minutes }
    G5: { value: 15, unit: minutes }
    G6: { value: 0, unit: minutes }
`);
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;

    const passAt = new Date('2026-10-02T09:00:00Z');
    expect(blockWindowDuration(custom.config, 'G2')).toEqual({ value: 15, unit: 'minutes' });
    expect(blockWindowEnd(passAt, custom.config, 'G2')).toEqual(new Date('2026-10-02T09:15:00Z'));
    expect(blockWindowEnd(passAt, custom.config, 'G3')).toEqual(new Date('2026-10-02T09:30:00Z'));
    expect(blockWindowEnd(passAt, custom.config, 'G5')).toEqual(new Date('2026-10-02T09:15:00Z'));
    // G6=0m closes immediately with no wait.
    expect(blockWindowEnd(passAt, custom.config, 'G6')).toEqual(passAt);
    // Unspecified gate (or no gate argument) falls back to hotl_block_window.
    expect(blockWindowDuration(custom.config, 'G1')).toEqual({ value: 1, unit: 'working_hours' });
    expect(blockWindowEnd(passAt, custom.config)).toEqual(new Date('2026-10-02T10:00:00Z'));
  });

  it('closes a 0-valued working-unit override immediately even on a weekend (V21, #557)', () => {
    const custom = loadProjectConfig(`
oversight:
  hotl_block_window_by_gate:
    G6: { value: 0, unit: working_hours }
`);
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;

    // Saturday in Ho Chi Minh City: must still return passAt immediately, not Monday morning.
    const saturday = new Date('2026-10-03T05:00:00Z');
    expect(blockWindowEnd(saturday, custom.config, 'G6')).toEqual(saturday);
    // G2 has no override, so it falls back to the 4 working-hour default (Monday 09:00 + 4h = 13:00 local = 06:00 UTC).
    expect(blockWindowEnd(saturday, custom.config, 'G2')).toEqual(new Date('2026-10-05T06:00:00Z'));
  });

  it('rejects invalid gates and negative durations in hotl_block_window_by_gate (V21, #557)', () => {
    const invalidGate = loadProjectConfig(`
oversight:
  hotl_block_window_by_gate:
    G7: { value: 0, unit: minutes }
`);
    expect(invalidGate.ok).toBe(false);

    const negativeDuration = loadProjectConfig(`
oversight:
  hotl_block_window_by_gate:
    G6: { value: -5, unit: minutes }
`);
    expect(negativeDuration.ok).toBe(false);
  });

  it('orders gates', () => {
    expect(gateBefore('G2', 'G4')).toBe(true);
    expect(gateBefore('G3', 'G3')).toBe(false);
    expect(gateBefore('G4', 'G2')).toBe(false);
  });
});

describe('gate deadline (QUESTIONS #90, D4)', () => {
  const entered = new Date('2026-09-28T03:00:00Z'); // Monday 10:00 local

  it('is hitl_gate_deadline (1 working day) after the clock start', () => {
    expect(gateDeadline(entered, config)).toEqual(new Date('2026-09-29T03:00:00Z'));
  });

  it('starts at the entry, or at a later request for changes', () => {
    const intent = { gate_entered_at: entered, updated_at: entered };
    expect(gateClockStart(intent, null)).toEqual(entered);
    const later = new Date('2026-09-28T05:00:00Z');
    expect(gateClockStart(intent, later)).toEqual(later);
    // A request for changes from before this entry does not move the clock back.
    expect(gateClockStart(intent, new Date('2026-09-27T05:00:00Z'))).toEqual(entered);
  });

  it('routes to intent when Person A holds the gate role, otherwise technical', () => {
    expect(overdueRoute({ roles: ['person_a'] })).toBe('intent');
    expect(overdueRoute({ roles: ['person_b', 'second_approver'] })).toBe('technical');
    expect(overdueRoute({ roles: [] })).toBe('technical');
  });
});

describe('waited_seconds (FR-12)', () => {
  it('counts wall-clock seconds since the gate entry', () => {
    const intent = { gate_entered_at: new Date('2026-09-28T01:00:00Z') };
    expect(waitedSeconds(intent, new Date('2026-09-28T01:01:30.900Z'))).toBe(90);
    expect(waitedSeconds(intent, new Date('2026-09-28T00:59:00Z'))).toBe(0);
    expect(waitedSeconds({ gate_entered_at: null }, new Date())).toBeNull();
  });

  it('the workflow never sets a timer shorter than one second', () => {
    expect(MIN_TIMER_MS).toBe(1000);
  });
});
