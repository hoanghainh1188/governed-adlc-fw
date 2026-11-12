// `adlc next <INT>` (task V06, D-08 V06 AC1–AC4): the advice per waiting reason, gate and role,
// producers never told to approve (QUESTIONS #368), every text from the catalog, and the command
// against a mocked API that reads `GET /v1/me` and `GET /v1/intents/:intent` only.
import { WAITING_CAUSE_KEYS } from '@sdlc/api-schemas';
import { INTENT_WAIT_REASONS } from '@sdlc/contracts';
import { catalogFor, placeholdersOf, t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import {
  intentDetailSchema,
  meSchema,
  type IntentDetail,
  type Me,
} from '../../apps/cli/src/api/schemas.js';
import { adviceText } from '../../apps/cli/src/commands/next.js';
import {
  ADVICE_CODES,
  adviceKey,
  adviseNext,
  CAUSE_RULES,
  NOTE_CODES,
  noteKey,
  REASON_RULES,
} from '../../apps/cli/src/commands/next/advice.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { decisionBody, intentBody, meBody, OTHER_USER, PROJECT, USER } from './fixtures.js';
import { apiError, useHarness } from './harness.js';

const LATER = new Date('2026-10-04T00:00:00.000Z');
const CODE = 'INT-2026-0007';

interface DetailOptions {
  readonly intent?: Parameters<typeof intentBody>[0];
  readonly waitingFor?: {
    gate: string;
    mode: string;
    roles: string[];
    approvals_needed: number;
  } | null;
  readonly decisions?: Record<string, unknown>[];
}

function detail(options: DetailOptions = {}): IntentDetail {
  const intent = intentBody(options.intent);
  const gate = (intent.current_gate as string | null) ?? 'G2';
  return intentDetailSchema.parse({
    ...intent,
    waiting_for:
      options.waitingFor === undefined
        ? { gate, mode: 'HITL', roles: ['person_a'], approvals_needed: 1 }
        : options.waitingFor,
    spec: null,
    plan: null,
    decisions: options.decisions ?? [],
  });
}

function me(roles: string[], userId = OTHER_USER, tenantAdmin = false): Me {
  const base = meBody() as { user: Record<string, unknown> };
  return meSchema.parse({
    ...base,
    user: { ...base.user, id: userId },
    tenant_admin: tenantAdmin,
    roles: roles.map((role) => ({ project: PROJECT, role })),
  });
}

const waitsFor = (gate: string, roles: string[], needed = 1) => ({
  gate,
  mode: 'HITL',
  roles,
  approvals_needed: needed,
});

describe('AC3/AC4: every waiting reason and cause has advice, every advice a catalog text', () => {
  it('every IntentWaitReason has a rule', () => {
    expect(Object.keys(REASON_RULES).sort()).toEqual([...INTENT_WAIT_REASONS].sort());
  });

  it('every known G4 cause has a rule', () => {
    expect(Object.keys(CAUSE_RULES).sort()).toEqual(Object.keys(WAITING_CAUSE_KEYS).sort());
  });

  it('every advice and note code has an English text', () => {
    const en = catalogFor('en') ?? {};
    for (const code of ADVICE_CODES) expect(en[adviceKey(code)], code).toBeTypeOf('string');
    for (const code of NOTE_CODES) expect(en[noteKey(code)], code).toBeTypeOf('string');
  });

  it('the advice texts use only the parameters the advice gives', () => {
    const known = new Set([
      'intent',
      'project',
      'gate',
      'status',
      'issue',
      'pr',
      'data_class',
      'until',
      'cause',
      'reason',
      'roles',
      'needed',
      'comment',
    ]);
    for (const code of ADVICE_CODES) {
      for (const name of placeholdersOf(t(adviceKey(code))))
        expect(known, `${code}: ${name}`).toContain(name);
    }
  });

  it.each([...INTENT_WAIT_REASONS])(
    '%s: one advice with a full text for each kind of caller',
    (reason) => {
      for (const roles of [['person_a'], ['person_b'], ['viewer'], []]) {
        const next = adviseNext(
          detail({
            intent: {
              waiting_reason: reason,
              current_gate: 'G4',
              waiting_cause: 'agent_not_active',
            },
          }),
          me(roles),
        );
        expect(adviceText(next)).not.toMatch(/\{[a-z_]+\}/);
      }
    },
  );
});

describe('AC1: gate decisions name the command for the role holder', () => {
  it.each([
    ['G1', 'decide_gate', 'adlc gate approve G1 INT-2026-0007'],
    ['G2', 'decide_gate', 'adlc gate approve G2 INT-2026-0007'],
    ['G3', 'decide_gate', 'adlc gate approve G3 INT-2026-0007'],
    ['G4', 'decide_g4', 'adlc gate approve G4 INT-2026-0007'],
    ['G5', 'decide_g5', 'adlc gate approve G5 INT-2026-0007'],
    ['G6', 'decide_g6', 'adlc gate approve G6 INT-2026-0007'],
    ['G7', 'review_g7', 'pull request #31'],
    ['G8', 'decide_g8', 'adlc evidence show INT-2026-0007'],
  ])('%s → %s', (gate, code, command) => {
    const next = adviseNext(
      detail({
        intent: { current_gate: gate as never, waiting_reason: 'decision', pr_number: 31 },
        waitingFor: waitsFor(gate, ['person_b']),
      }),
      me(['person_b']),
    );
    expect(next.kind).toBe('you_act');
    expect(next.code).toBe(code);
    expect(adviceText(next)).toContain(command);
  });

  it('adds the comment command when the intent has an issue, and leaves it out otherwise', () => {
    const withIssue = adviseNext(detail({ intent: { current_gate: 'G2' } }), me(['person_a']));
    expect(adviceText(withIssue)).toContain('or comment /approve G2 on issue #12');
    const without = adviseNext(
      detail({ intent: { current_gate: 'G2', issue_number: null } }),
      me(['person_a']),
    );
    expect(adviceText(without)).not.toContain('/approve');
  });

  it('the gate-specific reasons give the same advice as decision at that gate', () => {
    for (const [reason, gate, code] of [
      ['g5_decision', 'G5', 'decide_g5'],
      ['g6_decision', 'G6', 'decide_g6'],
      ['g7_decision', 'G7', 'review_g7'],
      ['g8_decision', 'G8', 'decide_g8'],
    ] as const) {
      const next = adviseNext(
        detail({
          intent: { current_gate: gate, waiting_reason: reason },
          waitingFor: waitsFor(gate, ['person_b']),
        }),
        me(['person_b']),
      );
      expect(next.code).toBe(code);
    }
  });

  it.each(['review_too_large', 'review_size_unknown'])(
    'H05: G5 held with the cause %s: the allowing reason codes and the split',
    (cause) => {
      const facts = detail({
        intent: { current_gate: 'G5', waiting_reason: 'g5_decision', waiting_cause: cause },
        waitingFor: waitsFor('G5', ['person_a']),
      });
      const next = adviseNext(facts, me(['person_a']));
      expect(next).toMatchObject({ kind: 'you_act', code: 'decide_g5_review' });
      expect(adviceText(next)).toContain('--reason-code generated_change');
      expect(adviceText(next)).toContain('request-changes G5');
      // Another role waits for Person A, as at any decided gate.
      expect(adviseNext(facts, me(['person_b'])).code).toBe('waits_role');
    },
  );
});

describe('AC2: the advice follows the caller roles; producers never approve', () => {
  it('another role: waits for the gate roles, no command', () => {
    const next = adviseNext(
      detail({ intent: { current_gate: 'G3' }, waitingFor: waitsFor('G3', ['person_b']) }),
      me(['person_a']),
    );
    expect(next).toMatchObject({ kind: 'waits_for', code: 'waits_role', roles: ['person_b'] });
    expect(adviceText(next)).toContain('person_b');
    expect(adviceText(next)).not.toContain('adlc gate approve');
  });

  it.each([[['viewer']], [[]]])('roles %j: waits for the gate roles', (roles) => {
    const next = adviseNext(detail(), me(roles));
    expect(next.kind).toBe('waits_for');
  });

  it('a tenant admin without a project role is not offered the decision', () => {
    const next = adviseNext(detail(), me([], OTHER_USER, true));
    expect(next.code).toBe('waits_role');
  });

  it.each(['G7', 'G8'])('the intent creator at %s is a producer', (gate) => {
    const next = adviseNext(
      detail({
        intent: { current_gate: gate as never, created_by: USER, pr_number: 31 },
        waitingFor: waitsFor(gate, ['person_b']),
      }),
      me(['person_b'], USER),
    );
    expect(next).toMatchObject({ kind: 'waits_for', code: 'producer', producer: true });
    expect(adviceText(next)).not.toContain('adlc gate approve');
  });

  it.each(['G5', 'G6', 'G7', 'G8'])(
    'the person who approved G4 (allowed the run) is a producer at %s',
    (gate) => {
      const next = adviseNext(
        detail({
          intent: { current_gate: gate as never, created_by: USER },
          waitingFor: waitsFor(gate, ['person_b']),
          decisions: [
            decisionBody({ gate: 'G4', decided_by: OTHER_USER, approver_role: 'person_a' }),
          ],
        }),
        me(['person_b']),
      );
      expect(next.code).toBe('producer');
    },
  );

  it('the creator is no producer at G2 (Person A owns and approves the intent)', () => {
    const next = adviseNext(detail({ intent: { created_by: OTHER_USER } }), me(['person_a']));
    expect(next.code).toBe('decide_gate');
  });

  it('a producer is never told to merge at G7', () => {
    const next = adviseNext(
      detail({
        intent: {
          current_gate: 'G7',
          waiting_reason: 'g7_merge',
          created_by: OTHER_USER,
          pr_number: 31,
        },
        waitingFor: waitsFor('G7', ['person_b']),
      }),
      me(['person_b']),
    );
    expect(next.code).toBe('producer');
  });

  describe('g7_merge: only a holder of G7 role who is not a producer merges (AC2)', () => {
    const merge = (roles: string[], needed = 1) =>
      detail({
        intent: { current_gate: 'G7', waiting_reason: 'g7_merge', pr_number: 31 },
        waitingFor: waitsFor(
          'G7',
          needed > 1 ? ['person_b', 'second_approver'] : ['person_b'],
          needed,
        ),
        decisions: [],
      });

    it('person_b, not a producer: merge the pull request', () => {
      const next = adviseNext(merge([]), me(['person_b']));
      expect(next).toMatchObject({ kind: 'you_act', code: 'merge_g7' });
      expect(adviceText(next)).toContain('pull request #31');
    });

    it('the second approver merges when two approvals are needed', () => {
      expect(adviseNext(merge([], 2), me(['second_approver'])).code).toBe('merge_g7');
    });

    it.each([[['viewer']], [['person_a']], [['pm_brse']], [[]], [['second_approver']]])(
      'roles %j with one approval needed: waits for person_b, never told to merge',
      (roles) => {
        const next = adviseNext(merge([]), me(roles));
        expect(next).toMatchObject({ kind: 'waits_for', code: 'waits_role', roles: ['person_b'] });
        expect(adviceText(next)).not.toContain('merge');
      },
    );

    it('a tenant admin without G7 role waits', () => {
      expect(adviseNext(merge([]), me([], OTHER_USER, true)).code).toBe('waits_role');
    });

    it('without waiting_for: person_b, plus the second approver only for two approvals', () => {
      const noWaiting = detail({
        intent: { current_gate: 'G7', waiting_reason: 'g7_merge', pr_number: 31 },
        waitingFor: null,
      });
      expect(adviseNext(noWaiting, me(['person_b'])).code).toBe('merge_g7');
      expect(adviseNext(noWaiting, me(['second_approver'])).code).toBe('waits_role');
    });
  });

  describe('G5 and G6: the person who allowed the last run is a producer (core runProducers)', () => {
    const LAST = new Date('2026-10-05T00:00:00.000Z');
    const runs = [
      decisionBody({ gate: 'G4', decided_by: USER, approver_role: 'person_a' }),
      decisionBody({
        id: '66666666-6666-4666-8666-666666666666',
        gate: 'G4',
        decided_by: OTHER_USER,
        approver_role: 'person_a',
        created_at: LAST,
      }),
    ];
    const at = (gate: string) =>
      detail({
        intent: { current_gate: gate as never, waiting_reason: 'decision', created_by: USER },
        waitingFor: waitsFor(gate, ['person_a', 'person_b']),
        decisions: runs,
      });

    it.each(['G5', 'G6'])('%s: the latest G4 approver is never told to approve', (gate) => {
      const next = adviseNext(at(gate), me(['person_b']));
      expect(next).toMatchObject({ kind: 'waits_for', code: 'producer', producer: true });
      expect(adviceText(next)).not.toContain('adlc gate approve');
    });

    it.each([
      ['G5', 'decide_g5'],
      ['G6', 'decide_g6'],
    ])("%s: an earlier run's G4 approver may decide (%s)", (gate, code) => {
      expect(adviseNext(at(gate), me(['person_b'], USER)).code).toBe(code);
    });

    it.each(['G7', 'G8'])('%s: every G4 approver is a producer', (gate) => {
      expect(adviseNext(at(gate), me(['person_b'], USER)).code).toBe('producer');
    });
  });

  it('QUESTIONS #368: at G3 the plan submitter note is shown', () => {
    const next = adviseNext(
      detail({ intent: { current_gate: 'G3' }, waitingFor: waitsFor('G3', ['person_b']) }),
      me(['person_b']),
    );
    expect(next.code).toBe('decide_gate');
    expect(next.notes).toContain('g3_submitter');
  });

  it('an approval already given in this visit: waits for the others', () => {
    const next = adviseNext(
      detail({
        intent: { current_gate: 'G7', pr_number: 31 },
        waitingFor: waitsFor('G7', ['person_b', 'second_approver'], 2),
        decisions: [decisionBody({ gate: 'G7', decided_by: OTHER_USER, created_at: LATER })],
      }),
      me(['person_b']),
    );
    expect(next.code).toBe('already_approved');
    expect(adviceText(next)).toContain('approvals needed in all: 2');
  });

  it('an approval from an earlier visit of the gate does not count', () => {
    const next = adviseNext(
      detail({
        intent: { current_gate: 'G2', gate_entered_at: LATER },
        decisions: [decisionBody({ gate: 'G2', decided_by: OTHER_USER })],
      }),
      me(['person_a']),
    );
    expect(next.code).toBe('decide_gate');
  });
});

describe('holds: inputs, escalations, the platform, the set-up', () => {
  const at = (reason: string, gate = 'G4', extra: Parameters<typeof intentBody>[0] = {}) =>
    detail({ intent: { waiting_reason: reason, current_gate: gate as never, ...extra } });

  it.each([
    ['input_missing', 'G2', ['person_a'], 'link_spec', 'adlc spec link INT-2026-0007'],
    ['input_missing', 'G3', ['person_a'], 'write_plan', 'adlc plan submit INT-2026-0007'],
    ['new_plan_needed', 'G3', ['person_a'], 'new_plan', 'adlc plan submit'],
    ['plan_resubmit_needed', 'G4', ['person_a'], 'resubmit_plan', 'adlc plan submit'],
    ['spec_unavailable', 'G2', ['pm_brse'], 'fix_spec', 'adlc spec link'],
    ['spec_unclear', 'G2', ['person_a'], 'spec_unclear', 'acceptance criteria'],
    ['ai_record', 'G1', ['pm_brse'], 'ai_record', 'adlc ai-record show pilot'],
    ['proposal_review', 'G4', ['person_a'], 'proposal', 'adlc evidence proposal INT-2026-0007'],
  ])('%s at %s for %j → %s', (reason, gate, roles, code, text) => {
    const next = adviseNext(at(reason, gate), me(roles));
    expect(next).toMatchObject({ kind: 'you_act', code });
    expect(adviceText(next)).toContain(text);
  });

  it('a person without the default access role waits, with the default-roles note', () => {
    const next = adviseNext(at('input_missing', 'G3'), me(['person_b']));
    expect(next).toMatchObject({ kind: 'waits_for', roles: ['person_a'] });
    expect(next.notes).toContain('default_roles');
  });

  it.each(['frozen', 'run_review', 'g5_review', 'publish_review', 'g7_review', 'g8_review'])(
    'QUESTIONS #369: %s points to adlc escalation list --intent',
    (reason) => {
      const owner = adviseNext(at(reason), me(['person_b']));
      expect(owner.code).toBe('escalation');
      expect(adviceText(owner)).toContain('adlc escalation list --intent INT-2026-0007');
      const other = adviseNext(at(reason), me(['viewer']));
      expect(other.code).toBe('waits_escalation');
      expect(adviceText(other)).toContain('adlc escalation list --intent INT-2026-0007');
    },
  );

  it('the block window gives its close time and the comment commands', () => {
    const next = adviseNext(
      at('hotl_block_window', 'G4', { waiting_until: LATER }),
      me(['person_b']),
    );
    expect(next.kind).toBe('platform');
    expect(adviceText(next)).toContain('2026-10-04T00:00:00.000Z');
  });

  it.each([
    ['run_pending', 'run_pending'],
    ['ci_pending', 'ci_pending'],
    ['publish_retry', 'publish_retry'],
    ['g7_changes_requested', 'changes_requested'],
  ])('%s: the platform works, nothing to do', (reason, code) => {
    expect(adviseNext(at(reason), me(['person_a']))).toMatchObject({ kind: 'platform', code });
  });

  it('ci_missing (O06 AC3): the project adds CI, not only an admin', () => {
    const next = adviseNext(at('ci_missing', 'G6', { pr_number: 7 }), me(['person_a']));
    expect(next).toMatchObject({ kind: 'fix_setup', code: 'setup_ci', notes: [] });
    expect(adviceText(next)).toContain('#7');
    expect(adviceText(next)).toContain('Ch.14');
  });

  it('a running agent: the kill switch only for the kill roles', () => {
    expect(adviseNext(at('run_in_progress'), me(['person_a'])).code).toBe('run_running');
    expect(adviseNext(at('run_in_progress'), me(['pm_brse'])).code).toBe('run_watch');
  });

  it.each([
    ['git_host_unavailable', 'setup_git_host'],
    ['evidence_unavailable', 'setup_evidence'],
    ['later_gate', 'setup_later_gate'],
  ])('%s: the operator fixes it', (reason, code) => {
    expect(adviseNext(at(reason), me(['person_a']))).toMatchObject({ kind: 'fix_setup', code });
  });

  it.each(Object.keys(WAITING_CAUSE_KEYS))('g4_check with cause %s has advice', (cause) => {
    const next = adviseNext(at('g4_check', 'G4', { waiting_cause: cause }), me(['person_a']));
    expect(ADVICE_CODES).toContain(next.code);
    expect(adviceText(next)).not.toMatch(/\{[a-z_]+\}/);
  });

  it('g4_check with an agent cause: a tenant admin fixes it', () => {
    const next = adviseNext(
      at('g4_check', 'G4', { waiting_cause: 'agent_not_active' }),
      me(['person_a']),
    );
    expect(next).toMatchObject({ kind: 'fix_setup', code: 'setup_agent', notes: ['admin_only'] });
    expect(adviceText(next)).toContain('agent_not_active');
  });

  it('g4_check with a spec cause: link the spec again', () => {
    expect(
      adviseNext(at('g4_check', 'G4', { waiting_cause: 'spec_changed' }), me(['person_a'])).code,
    ).toBe('link_spec');
  });
});

describe('finished and unknown intents', () => {
  it.each(['done', 'rejected', 'cancelled'])('%s: nothing more to do', (status) => {
    const next = adviseNext(
      detail({
        intent: { status: status as never, current_gate: null, waiting_reason: null },
        waitingFor: null,
      }),
      me(['person_a']),
    );
    expect(next).toMatchObject({ kind: 'finished', code: 'finished' });
    expect(adviceText(next)).toContain(status);
  });

  it('blocked: Critical risk', () => {
    const next = adviseNext(
      detail({ intent: { status: 'blocked', waiting_reason: 'not_in_gate' }, waitingFor: null }),
      me(['person_a']),
    );
    expect(next.code).toBe('blocked');
  });

  it('a reason this CLI does not know yet: its code and adlc intent show', () => {
    const intent = { ...detail(), waiting_reason: 'future_reason' };
    const next = adviseNext(intent, me(['person_a']));
    expect(next.code).toBe('unknown');
    expect(adviceText(next)).toContain('"future_reason"');
    expect(adviceText(next)).toContain('adlc intent show INT-2026-0007');
  });

  it('no recorded reason (an API before U02): decides from waiting_for', () => {
    const next = adviseNext(
      detail({ intent: { waiting_reason: null } }),
      me(['person_a'], OTHER_USER),
    );
    expect(next.code).toBe('decide_gate');
  });
});

describe('adlc next (command, mocked API)', () => {
  const harness = useHarness();
  const routes = (intent: IntentDetail, roles = ['person_a']) => ({
    'GET /v1/me': { status: 200, body: me(roles) },
    [`GET /v1/intents/${CODE}`]: { status: 200, body: intent },
  });

  it('prints the intent, who decides, and the next step; reads only /v1/me and the intent', async () => {
    const h = await harness({ routes: routes(detail()) });
    expect(await h.run(['next', 'int-2026-0007'])).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      t('cli.next.header', { intent: CODE, project: 'pilot', status: 'in_gate', gate: 'G2' }),
    );
    expect(h.out.join('\n')).toContain('Next: Decide G2: adlc gate approve G2 INT-2026-0007');
    expect(h.requests.map((r) => `${r.method} ${r.url.pathname}`).sort()).toEqual([
      'GET /v1/intents/INT-2026-0007',
      'GET /v1/me',
    ]);
  });

  it('shows the hold and its cause', async () => {
    const intent = detail({
      intent: { current_gate: 'G4', waiting_reason: 'g4_check', waiting_cause: 'agent_not_active' },
    });
    const h = await harness({ routes: routes(intent) });
    expect(await h.run(['next', CODE])).toBe(EXIT.ok);
    const text = h.out.join('\n');
    expect(text).toContain(t('intent.waiting.g4_check'));
    expect(text).toContain(t('intent.waiting_cause.agent_not_active'));
    expect(text).toContain('Note: ');
  });

  it('--json: codes and the advice', async () => {
    const h = await harness({
      routes: routes(
        detail({ intent: { current_gate: 'G3' }, waitingFor: waitsFor('G3', ['person_b']) }),
        ['person_b'],
      ),
    });
    expect(await h.run(['next', CODE, '--json'])).toBe(EXIT.ok);
    const body = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(body).toMatchObject({
      intent: CODE,
      gate: 'G3',
      waiting_reason: 'decision',
      advice: { kind: 'you_act', code: 'decide_gate', producer: false, notes: ['g3_submitter'] },
    });
  });

  // No argument lists the evaluations that ended (L06, QUESTIONS #482): `eval-report.test.ts`.
  it.each([[['bogus']], [[CODE, 'extra']], [['--unknown', CODE]], [['--unknown']]])(
    '%j: usage, exit 2',
    async (args) => {
      const h = await harness({ routes: {} });
      expect(await h.run(['next', ...args])).toBe(EXIT.usage);
      expect(h.err).toEqual([t('cli.next.usage')]);
      expect(h.requests).toEqual([]);
    },
  );

  it('an intent the caller cannot see: the API refusal, exit 1', async () => {
    const h = await harness({
      routes: {
        'GET /v1/me': { status: 200, body: me(['person_a']) },
        [`GET /v1/intents/${CODE}`]: apiError(404, 'not_found'),
      },
    });
    expect(await h.run(['next', CODE])).toBe(EXIT.failed);
  });

  it('not logged in: exit 2, no request', async () => {
    const h = await harness({ loggedIn: false });
    expect(await h.run(['next', CODE])).toBe(EXIT.usage);
    expect(h.requests).toEqual([]);
  });

  it('cli.usage lists adlc next', () => {
    expect(t('cli.usage')).toContain('    adlc next <INT-…>');
  });
});
