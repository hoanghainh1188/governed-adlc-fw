// HOTL at the human gates G2 and G3 (task B07 session 2, QUESTIONS #88 option A, ADR-M30 §2.4b),
// and at G5 (task C07, ADR-M34 §2.8: the platform passes a run whose changes are in scope and
// within its caps; the block window applies, and C08 waits for it before G6 acts).
//
// When the policy conditions hold, the platform records a system `pass` at once and tells the
// people of the gate's matrix cell. Within `oversight.hotl_block_window` (working calendar), a
// holder of the gate's role can still block the passed gate with a rejection or a request for
// changes, even though the intent already waits at a later gate: a request for changes takes the
// intent back to the gate, a rejection ends it. An explicit `/approve` passes at once and opens no
// window: a person decided.
//
// Rules that are design, not configuration:
// - No system `pass` at a HITL gate (the registry refuses it; D-03 section 6).
// - The pass conditions (QUESTIONS #88): G2 a spec is linked; G3 a plan with at least one planned
//   file. A forced-HITL change flag already makes G3 HITL through the policy engine. B08 and B09
//   add their own conditions here.
// - No pass again on an input that a person sent back (Harry, B07 session 2 plan, D1): the gate
//   waits for a new spec or plan, or for an explicit approval.
// Tunable values come from the project configuration: the matrix (HOTL or HITL, the roles told),
// the block window and the working calendar.
import { deadlineFrom } from '@sdlc/config';
import {
  GATE_CODES,
  type Duration,
  type GateCode,
  type HotlBlockWindowGate,
  type ProjectConfig,
} from '@sdlc/contracts';

import type { CommandGate } from '../commands/gate-input.js';

/**
 * Gates the platform may pass (HOTL) and a person may block within the block window. C08 PR 2: G6
 * (CI passed; a request for changes within the window means a new run after G4; E01 waits for the
 * window before it acts at G7).
 */
export const PASSABLE_GATES = ['G1', 'G2', 'G3', 'G5', 'G6'] as const satisfies readonly GateCode[];
export type PassableGate = (typeof PASSABLE_GATES)[number];

export function isPassableGate(gate: string): gate is PassableGate {
  return (PASSABLE_GATES as readonly string[]).includes(gate);
}
import type { Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { Registry } from '../registry/registry.js';
import { specHasCriteria } from './g2-criteria.js';
import { gateHistory } from './gate-history.js';
import { grantWithScope, SKIPPABLE_WINDOW_GATES } from '../break-glass/active.js';

/** True when `earlier` comes before `later` in the gate order. */
export function gateBefore(earlier: GateCode, later: GateCode): boolean {
  return GATE_CODES.indexOf(earlier) < GATE_CODES.indexOf(later);
}

function isHotlBlockWindowGate(gate: GateCode | undefined): gate is HotlBlockWindowGate {
  return gate === 'G2' || gate === 'G3' || gate === 'G5' || gate === 'G6';
}

/** Resolves the configured HOTL block window for `gate`, falling back to `oversight.hotl_block_window`. */
export function blockWindowDuration(config: ProjectConfig, gate?: GateCode): Duration {
  if (isHotlBlockWindowGate(gate)) {
    const override = config.oversight.hotl_block_window_by_gate?.[gate];
    if (override !== undefined) return override;
  }
  return config.oversight.hotl_block_window;
}

/**
 * When the block window of a HOTL pass closes: the pass time plus the resolved window on the
 * working calendar. A `0`-valued override disables waiting immediately, even outside working hours.
 */
export function blockWindowEnd(passAt: Date, config: ProjectConfig, gate?: GateCode): Date {
  const window = blockWindowDuration(config, gate);
  if (window.value === 0) return passAt;
  // A duration always gives an end; null would only come from "next planned work".
  return deadlineFrom(passAt, window, config.escalation.calendar) ?? passAt;
}

/** The pass conditions of a HOTL gate (QUESTIONS #88). The gate's input exists already. */
export async function hotlConditionsHold(
  scope: TenantScope,
  intent: Intent,
  gate: CommandGate,
): Promise<boolean> {
  switch (gate) {
    case 'G1':
      return false; // G1 is HITL at every tier (mandatory rule); never passed by the platform.
    case 'G2': {
      // S01 (D-02 §6.2): a spec with at least one acceptance criterion.
      const spec = await scope.specRefs.latest(intent.id);
      return spec !== undefined && specHasCriteria(spec);
    }
    case 'G3': {
      const plan = await scope.plans.latest(intent.id);
      return plan !== undefined && plan.planned_files.length > 0;
    }
  }
}

/** True when a person requested changes at `gate` for exactly this input (D1: no pass again). */
export async function sentBackForInput(
  scope: TenantScope,
  intentId: string,
  gate: GateCode,
  inputSha256: string,
): Promise<boolean> {
  const decisions = await scope.gateDecisions.listForIntent(intentId, gate);
  return decisions.some((d) => d.decision === 'request_changes' && d.input_sha256 === inputSha256);
}

export interface PassedGate {
  readonly gate: PassableGate;
  /** The `pass` decision. */
  readonly passId: string;
  readonly passAt: Date;
  readonly windowEnd: Date;
}

/** The earlier gates of the intent's path that the platform passed (HOTL) and nobody blocked. */
async function passedGates(
  scope: TenantScope,
  intent: Intent,
  config: ProjectConfig,
): Promise<{ passed: PassedGate[]; block: EarlierBlock | null }> {
  const passed: PassedGate[] = [];
  const current = intent.current_gate;
  if (intent.status !== 'in_gate' || current === null) return { passed, block: null };
  for (const gate of GATE_CODES) {
    if (!isPassableGate(gate) || !gateBefore(gate, current)) continue;
    const history = await gateHistory(scope, intent.id, gate);
    if (history.pass === null || history.passAt === null) continue;
    if (history.blockAfterPass !== null) {
      return { passed, block: { gate, ...history.blockAfterPass } };
    }
    passed.push({
      gate,
      passId: history.pass,
      passAt: history.passAt,
      windowEnd: blockWindowEnd(history.passAt, config, gate),
    });
  }
  return { passed, block: null };
}

export interface EarlierBlock {
  readonly gate: PassableGate;
  readonly decisionId: string;
  readonly decision: 'reject' | 'request_changes';
}

/**
 * A person's block of an earlier gate that the platform passed, if one was recorded: the step then
 * takes the intent back to that gate or ends it. The earliest blocked gate wins.
 */
export async function earlierBlock(
  scope: TenantScope,
  intent: Intent,
  config: ProjectConfig,
): Promise<EarlierBlock | null> {
  return (await passedGates(scope, intent, config)).block;
}

/**
 * The HOTL pass of `gate` whose block window is open at `at`, if any: a person may then reject the
 * gate or request changes although the intent waits at a later gate (`decideGate`).
 */
export async function openBlockWindow(
  scope: TenantScope,
  intent: Intent,
  gate: GateCode,
  config: ProjectConfig,
  at: Date,
): Promise<PassedGate | null> {
  const { passed } = await passedGates(scope, intent, config);
  return passed.find((p) => p.gate === gate && at.getTime() < p.windowEnd.getTime()) ?? null;
}

/**
 * When the last open HOTL block window of the intent closes, or null when none is open at `at`.
 * **C06 must not start a run before this time** (QUESTIONS #88): a person may still take the
 * intent back to G2 or G3 until then. Call it in the transaction that starts the run, after the
 * intent lock.
 */
export async function hotlBlockWindowOpenUntil(
  scope: TenantScope,
  registry: Registry,
  intentId: string,
  at: Date = registry.now(),
): Promise<Date | null> {
  const intent = await scope.intents.getById(intentId);
  if (!intent) return null;
  const { config } = await registry.policyFor(scope, intent.project_id);
  const { passed } = await passedGates(scope, intent, config);
  // H08 (ADR-M111 §2.2): an active break-glass grant with `hotl_window_skip` ends the windows of
  // G2 and G3. A person may still block those gates (`openBlockWindow`), as after any window.
  const skip = (await grantWithScope(scope, intentId, at, 'hotl_window_skip')) !== undefined;
  const open = passed
    .filter((p) => !(skip && SKIPPABLE_WINDOW_GATES.includes(p.gate)))
    .map((p) => p.windowEnd.getTime())
    .filter((end) => end > at.getTime());
  return open.length === 0 ? null : new Date(Math.max(...open));
}
