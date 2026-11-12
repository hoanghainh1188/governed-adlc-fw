// `adlc admin agent …` over the API (B13 AC7, handbook Ch.20, ADR-M37 §2.8) against a mocked
// API: registering with a hashed instructions file, approving (the last approval changes the
// status), stopping, usage errors.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { instructionsSha256 } from '../../packages/core/src/agents/rules.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { agentBody, OTHER_USER, roundBody } from './fixtures.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();
const REGISTER = [
  'admin',
  'agent',
  'register',
  '--key',
  'coder',
  '--version',
  '1.0.0',
  '--owner',
  OTHER_USER,
  '--instructions',
  'AGENTS.md@v1',
  '--max-autonomy',
  'L2',
];

describe('adlc admin agent', () => {
  it('registers with the hash of a local instructions file', async () => {
    const h = await harness({
      routes: { 'POST /v1/admin/agents': { status: 201, body: agentBody() } },
    });
    const file = join(h.home, 'AGENTS.md');
    await writeFile(file, '# AGENTS\nRun pnpm test.\n');
    expect(
      await h.run([...REGISTER, '--instructions-file', file, '--tools', 'terminal, file_editor']),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      key: 'coder',
      version: '1.0.0',
      owner_id: OTHER_USER,
      instructions_sha256: instructionsSha256(Buffer.from('# AGENTS\nRun pnpm test.\n')),
      instructions_ref: 'AGENTS.md@v1',
      allowed_tools: ['terminal', 'file_editor'],
      max_autonomy: 'L2',
    });
    expect(h.out[0]).toBe(
      t('cli.admin.agent.registered', { key: 'coder', version: '1.0.0', status: 'proposed' }),
    );
  });

  it('O06: pins the repository root file too, and removes it with none', async () => {
    const h = await harness({
      routes: {
        'POST /v1/admin/agents': {
          status: 201,
          body: agentBody({
            instructions_ref: 'packages/web/AGENTS.md@v1',
            root_instructions_ref: 'AGENTS.md@v2',
            root_instructions_sha256: 'd'.repeat(64),
          }),
        },
        'PATCH /v1/admin/agents/coder': { status: 200, body: agentBody({ version: '1.1.0' }) },
      },
    });
    const root = join(h.home, 'ROOT-AGENTS.md');
    await writeFile(root, '# Monorepo\n');
    const argv = REGISTER.map((a) => (a === 'AGENTS.md@v1' ? 'packages/web/AGENTS.md@v1' : a));
    expect(
      await h.run([
        ...argv,
        '--instructions-sha256',
        'c'.repeat(64),
        '--root-instructions',
        'AGENTS.md@v2',
        '--root-instructions-file',
        root,
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toMatchObject({
      instructions_ref: 'packages/web/AGENTS.md@v1',
      root_instructions_ref: 'AGENTS.md@v2',
      root_instructions_sha256: instructionsSha256(Buffer.from('# Monorepo\n')),
    });
    expect(
      await h.run([
        'admin',
        'agent',
        'update',
        '--key',
        'coder',
        '--version',
        '1.1.0',
        '--root-instructions',
        'none',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[1]?.body).toEqual({ version: '1.1.0', root_instructions_ref: null });
  });

  it.each([
    [[...REGISTER, '--instructions-sha256', 'a'.repeat(64), '--root-instructions', 'AGENTS.md@v2']],
    [[...REGISTER, '--instructions-sha256', 'a'.repeat(64), '--root-instructions-file', 'x']],
    [
      [
        ...REGISTER,
        '--instructions-sha256',
        'a'.repeat(64),
        '--root-instructions',
        'none',
        '--root-instructions-file',
        'x',
      ],
    ],
  ])('O06: a root file needs both options, none takes no file (%#)', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.requests).toEqual([]);
  });

  it.each([
    [REGISTER],
    [[...REGISTER, '--instructions-sha256', 'a'.repeat(64), '--instructions-file', 'AGENTS.md']],
    [['admin', 'agent', 'approve', '--key', 'coder', '--purpose', 'activate']],
    [['admin', 'agent', 'activate', '--key', 'coder']],
    [['admin', 'agent', 'suspend', '--key', 'coder']],
  ])('prints the usage for %j (exit 2, no request)', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.requests).toEqual([]);
    expect(h.err).toEqual([t('cli.admin.api.usage')]);
  });

  it('records an approval and says what is still missing; the last one activates', async () => {
    let calls = 0;
    const h = await harness({
      routes: {
        'POST /v1/admin/agents/coder/approvals': () => ({
          status: 200,
          body: roundBody(++calls === 2),
        }),
      },
    });
    const argv = ['admin', 'agent', 'approve', '--key', 'coder', '--purpose', 'activate'];
    expect(await h.run([...argv, '--as', 'owner'])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ purpose: 'activate', as: 'owner' });
    expect(h.out).toEqual([
      t('cli.admin.agent.approval', {
        key: 'coder',
        version: '1.0.0',
        purpose: 'activate',
        capacity: 'owner',
        missing: 'person_b',
      }),
    ]);
    expect(await h.run([...argv, '--as', 'person_b'])).toBe(EXIT.ok);
    expect(h.out.at(-1)).toBe(
      t('cli.admin.agent.status_changed', { key: 'coder', version: '1.0.0', status: 'active' }),
    );
  });

  // L09 (ADR-M86 §2.5, §2.8): an activation names its evaluation; `warn` answers a warning.
  describe('evaluations (L09)', () => {
    const APPROVE = ['admin', 'agent', 'approve', '--key', 'coder', '--purpose', 'activate'];
    const verdict = (result: string, params: Record<string, string>) => ({
      mode: 'warn',
      code: 'EVAL-2026-0007',
      result,
      qualifies: result === 'passed',
      params: { key: 'coder', code: 'EVAL-2026-0007', ...params },
    });

    it('sends --evaluation and prints the numbers of a qualifying evaluation', async () => {
      const params = { rate: '0.875', low: '0.625', high: '1.000', tasks: '8' };
      const h = await harness({
        routes: {
          'POST /v1/admin/agents/coder/approvals': {
            status: 200,
            body: { ...roundBody(false), evaluation: verdict('passed', params) },
          },
        },
      });
      expect(await h.run([...APPROVE, '--as', 'owner', '--evaluation', 'EVAL-2026-0007'])).toBe(
        EXIT.ok,
      );
      expect(h.requests[0]?.body).toEqual({
        purpose: 'activate',
        as: 'owner',
        evaluation_code: 'EVAL-2026-0007',
      });
      expect(h.out.at(-1)).toBe(
        t('cli.admin.agent.evaluation_passed', {
          key: 'coder',
          code: 'EVAL-2026-0007',
          ...params,
        }),
      );
    });

    it('prints the warning of warn mode with the catalog text and its numbers', async () => {
      const params = { rate: '0.375', low: '0.125', high: '0.750', min: '0.500' };
      const h = await harness({
        routes: {
          'POST /v1/admin/agents/coder/approvals': {
            status: 200,
            body: {
              ...roundBody(false),
              evaluation: verdict('evaluation_below_threshold', params),
            },
          },
        },
      });
      expect(await h.run([...APPROVE, '--as', 'owner', '--evaluation', 'EVAL-2026-0007'])).toBe(
        EXIT.ok,
      );
      const text = t('agent_register.error.evaluation_below_threshold', {
        key: 'coder',
        code: 'EVAL-2026-0007',
        ...params,
      });
      expect(text).toContain('0.375');
      expect(h.out.at(-1)).toBe(t('cli.admin.agent.evaluation_warning', { text }));
    });

    it('a missing evaluation in warn mode names --evaluation', async () => {
      const h = await harness({
        routes: {
          'POST /v1/admin/agents/coder/approvals': {
            status: 200,
            body: {
              ...roundBody(false),
              evaluation: { ...verdict('missing', {}), code: null },
            },
          },
        },
      });
      expect(await h.run([...APPROVE, '--as', 'owner'])).toBe(EXIT.ok);
      expect(h.out.at(-1)).toContain('--evaluation');
    });

    it('show prints the latest evaluation and whether it qualifies', async () => {
      const detail = (evaluation: unknown) => ({ ...agentBody(), rounds: [], evaluation });
      const h = await harness({
        routes: {
          'GET /v1/admin/agents/coder': {
            status: 200,
            body: detail(
              verdict('passed', { rate: '1.000', low: '1.000', high: '1.000', tasks: '8' }),
            ),
          },
          'GET /v1/admin/agents/other': { status: 200, body: detail(null) },
        },
      });
      expect(await h.run(['admin', 'agent', 'show', '--key', 'coder'])).toBe(EXIT.ok);
      expect(h.out.at(-1)).toBe(
        t('cli.admin.agent.evaluation_line', {
          code: 'EVAL-2026-0007',
          mode: 'warn',
          verdict: t('cli.admin.agent.evaluation_qualifies'),
        }),
      );
      expect(await h.run(['admin', 'agent', 'show', '--key', 'other'])).toBe(EXIT.ok);
      expect(h.out.at(-1)).toBe(t('cli.admin.agent.evaluation_none', { mode: '-' }));
    });
  });

  it('shows a refusal with the register text (exit 1)', async () => {
    const h = await harness({
      routes: {
        'POST /v1/admin/agents/coder/approvals': apiError(409, 'agent_refused', {
          reason: 'approval_duplicate',
          reason_message: 'Agent coder: you already approved.',
        }),
      },
    });
    expect(
      await h.run([
        'admin',
        'agent',
        'approve',
        '--key',
        'coder',
        '--purpose',
        'activate',
        '--as',
        'owner',
      ]),
    ).toBe(EXIT.failed);
    expect(h.err[1]).toBe(
      t('cli.api.reason', {
        reason: 'approval_duplicate',
        message: 'Agent coder: you already approved.',
      }),
    );
  });

  it('suspends with a reason, lists overdue agents only when asked', async () => {
    const h = await harness({
      routes: {
        'POST /v1/admin/agents/coder/suspend': {
          status: 200,
          body: agentBody({ status: 'suspended' }),
        },
        'GET /v1/admin/agents': {
          status: 200,
          body: {
            items: [
              agentBody({ status: 'active', last_recertified_at: '2026-01-05' }),
              agentBody({
                agent_key: 'fresh',
                status: 'active',
                last_recertified_at: '2026-10-01',
              }),
            ],
          },
        },
      },
    });
    expect(
      await h.run(['admin', 'agent', 'suspend', '--key', 'coder', '--reason', 'incident']),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ reason_code: 'incident' });
    expect(await h.run(['admin', 'agent', 'list', '--overdue', '--json'])).toBe(EXIT.ok);
    const listed = JSON.parse(h.out.at(-1) ?? '{}') as { items: { key: string }[] };
    expect(listed.items.map((agent) => agent.key)).toEqual(['coder']);
    // L10: the server filters overdue agents and adds their latest evaluation.
    expect(h.requests.at(-1)?.url.search).toBe('?overdue=true');
  });

  // L10 (ADR-M86 §2.6): a recertification names its evaluation; aging is said either way.
  describe('evaluations in the recertification (L10)', () => {
    const RECERTIFY = ['admin', 'agent', 'recertify', '--key', 'coder'];
    const passed = (aging: Record<string, unknown>) => ({
      mode: 'required',
      code: 'EVAL-2026-0009',
      result: 'passed',
      qualifies: true,
      params: {
        key: 'coder',
        code: 'EVAL-2026-0009',
        rate: '0.875',
        low: '0.6',
        high: '1.0',
        tasks: '8',
      },
      aging,
    });
    const recertified = (evaluation: unknown) => ({
      'POST /v1/admin/agents/coder/recertify': {
        status: 200,
        body: { ...agentBody({ status: 'active' }), evaluation },
      },
    });

    it('sends --evaluation and prints the comparison with the last activation', async () => {
      const params = { before: 'EVAL-2026-0002', shared: '8', rate: '0.875', before_rate: '1.000' };
      const h = await harness({
        routes: recertified(passed({ status: 'compared', reason: null, params })),
      });
      expect(await h.run([...RECERTIFY, '--evaluation', 'EVAL-2026-0009'])).toBe(EXIT.ok);
      expect(h.requests[0]?.body).toEqual({ evaluation_code: 'EVAL-2026-0009' });
      expect(h.out.at(-1)).toBe(t('cli.admin.agent.aging_compared', params));
    });

    it.each([
      ['no_activation_evaluation', {}],
      ['too_few_shared_tasks', { before: 'EVAL-2026-0002', shared: '2', min: '8' }],
    ] as const)('says when the comparison was skipped: %s', async (reason, params) => {
      const h = await harness({
        routes: recertified(passed({ status: 'skipped', reason, params })),
      });
      expect(await h.run([...RECERTIFY, '--evaluation', 'EVAL-2026-0009'])).toBe(EXIT.ok);
      expect(h.out.at(-1)).toBe(t(`cli.admin.agent.aging_skipped.${reason}`, params));
    });

    it('prints a drop in warn mode as a warning with its numbers', async () => {
      const params = {
        key: 'coder',
        code: 'EVAL-2026-0009',
        before: 'EVAL-2026-0002',
        shared: '8',
        rate: '0.000',
        before_rate: '1.000',
        p_value: '0.0078',
      };
      const h = await harness({
        routes: recertified({
          mode: 'warn',
          code: 'EVAL-2026-0009',
          result: 'evaluation_quality_dropped',
          qualifies: false,
          params,
        }),
      });
      expect(await h.run([...RECERTIFY, '--evaluation', 'EVAL-2026-0009'])).toBe(EXIT.ok);
      const text = t('agent_register.error.evaluation_quality_dropped', params);
      expect(text).toContain('0.0078');
      expect(h.out.at(-1)).toBe(t('cli.admin.agent.evaluation_warning', { text }));
    });

    it('list --overdue prints each agent’s latest evaluation', async () => {
      const h = await harness({
        routes: {
          'GET /v1/admin/agents': {
            status: 200,
            body: {
              items: [
                {
                  ...agentBody({ status: 'active', last_recertified_at: '2026-01-05' }),
                  evaluation: passed({ status: 'compared', reason: null, params: {} }),
                },
                {
                  ...agentBody({
                    agent_key: 'other',
                    status: 'active',
                    last_recertified_at: '2026-01-05',
                  }),
                  evaluation: null,
                },
              ],
            },
          },
        },
      });
      expect(await h.run(['admin', 'agent', 'list', '--overdue'])).toBe(EXIT.ok);
      expect(h.out).toContain(
        t('cli.admin.agent.overdue_evaluation', {
          code: 'EVAL-2026-0009',
          verdict: t('cli.admin.agent.evaluation_qualifies'),
        }),
      );
      expect(h.out.at(-1)).toBe(t('cli.admin.agent.overdue_no_evaluation'));
    });
  });
});
