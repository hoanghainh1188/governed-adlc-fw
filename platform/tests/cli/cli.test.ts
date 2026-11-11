// `adlc` command line: argument handling without a database, for the operator commands
// (`adlc ops …`, renamed from `sdlc admin …` in B13, ADR-M37 §2.8). The audit check itself runs
// against PostgreSQL in tests/integration/db/audit-log.test.ts.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT, runCli, type CliContext } from '../../apps/cli/src/index.js';

function context(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    connect: () => {
      throw new Error('no database in unit tests');
    },
  };
  return { ctx, out, err };
}

describe('adlc', () => {
  it.each([[[]], [['audit']], [['unknown']]])(
    'prints the usage and exits 2 for %j',
    async (argv) => {
      const { ctx, err } = context({ SDLC_DB_URL: 'postgres://x' });
      expect(await runCli(argv, ctx)).toBe(EXIT.usage);
      expect(err).toEqual([t('cli.usage')]);
    },
  );

  it.each([
    [['audit', 'verify', '--bogus']],
    [['audit', 'verify', 'extra']],
    [['audit', 'verify', '--tenant', 'x']],
  ])('user audit verify (B13): prints its usage and exits 2 for %j', async (argv) => {
    const { ctx, err } = context({ SDLC_DB_URL: 'postgres://x' });
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.audit.usage')]);
  });

  it.each([
    [['ops']],
    [['ops', 'nothing']],
    [['ops', 'token']],
    [['ops', 'bootstrap', '--tenant', 'x']],
    [['ops', 'token', 'issue', '--tenant', 'x', '--email', 'a@b.c']],
    [['ops', 'token', 'revoke', '--tenant', 'x', '--id', 'y', '--bogus']],
    [['ops', 'audit', 'verify', '--bogus']],
    [['ops', 'tenant-admin', 'grant', '--tenant', 'x']],
    [['ops', 'role', 'grant', '--tenant', 'x', '--project', 'p', '--email', 'a@b.c']],
    [['ops', 'role', 'remove', '--tenant', 'x']],
    [
      [
        'ops',
        'token',
        'issue',
        '--tenant',
        'x',
        '--email',
        'a@b.c',
        '--name',
        'n',
        '--days',
        'ten',
      ],
    ],
  ])('ops: prints the ops usage and exits 2 for %j', async (argv) => {
    const { ctx, err } = context({ SDLC_DB_URL: 'postgres://x' });
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.ops.usage')]);
  });

  const REG = [
    'ops',
    'agent',
    'register',
    '--tenant',
    'x',
    '--key',
    'coder',
    '--version',
    '1',
    '--owner',
    'a@b.c',
    '--instructions',
    'AGENTS.md@v1',
    '--max-autonomy',
    'L2',
  ];

  it.each([
    [['ops', 'agent']],
    [['ops', 'agent', 'nothing']],
    [['ops', 'agent', 'suspend', '--tenant', 'x', '--key', 'coder']],
    [['ops', 'agent', 'list', '--tenant', 'x', '--bogus']],
    // B13 (QUESTIONS #153): register, update, activate, retire, owner and recertify go through
    // the API; an agent is never activated through ops.
    [[...REG, '--instructions-sha256', 'a'.repeat(64)]],
    [['ops', 'agent', 'activate', '--tenant', 'x', '--key', 'coder']],
    [['ops', 'agent', 'retire', '--tenant', 'x', '--key', 'coder', '--reason', 'unused']],
    [['ops', 'agent', 'owner', '--tenant', 'x', '--key', 'coder', '--owner', 'a@b.c']],
    [['ops', 'agent', 'recertify', '--tenant', 'x', '--key', 'coder']],
    [
      [
        'ops',
        'agent',
        'update',
        '--tenant',
        'x',
        '--key',
        'coder',
        '--version',
        '2',
        '--instructions-sha256',
        'a'.repeat(64),
        '--instructions-file',
        'AGENTS.md',
      ],
    ],
  ])('ops agent: prints the agent usage and exits 2 for %j', async (argv) => {
    const { ctx, err } = context({ SDLC_DB_URL: 'postgres://x' });
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.admin.agent.usage')]);
  });

  const setArgs = [
    'ops',
    'ai-record',
    'set',
    '--tenant',
    'x',
    '--project',
    'p',
    '--on-behalf-of',
    'pm@example.test',
    '--expected-version',
    '0',
    '--ai-allowed',
    'yes',
    '--classes',
    'internal',
    '--prod-logs',
    'no',
    '--disclosure',
    'standard_note',
  ];

  it.each([
    [['ops', 'ai-record']],
    [['ops', 'ai-record', 'delete', '--tenant', 'x', '--project', 'p']],
    [['ops', 'ai-record', 'show', '--tenant', 'x']],
    [setArgs.filter((a) => a !== '--on-behalf-of' && a !== 'pm@example.test')],
    [setArgs.map((a) => (a === '0' ? 'one' : a))],
    [[...setArgs, '--confirmed-by', 'Client contact']],
  ])('ops ai-record (B12): prints the AI record usage and exits 2 for %j', async (argv) => {
    const { ctx, err } = context({ SDLC_DB_URL: 'postgres://x' });
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.admin.ai_record.usage')]);
  });

  it('ops ai-record needs SDLC_DB_URL', async () => {
    const { ctx, err } = context();
    expect(await runCli(setArgs, ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.admin.missing_url')]);
  });

  it('ops agent needs SDLC_DB_URL', async () => {
    const { ctx, err } = context();
    expect(await runCli(['ops', 'agent', 'list', '--tenant', 'x'], ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.admin.missing_url')]);
  });

  it.each([
    [['ops', 'token', 'list', '--tenant', 'x', '--email', 'a@b.c']],
    [['ops', 'tenant-admin', 'list', '--tenant', 'x']],
    [['ops', 'role', 'revoke', '--tenant', 'x', '--project', 'p', '--id', 'y']],
  ])('ops needs SDLC_DB_URL for %j', async (argv) => {
    const { ctx, err } = context();
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.admin.missing_url')]);
  });

  it('ops audit verify needs SDLC_DB_URL', async () => {
    const { ctx, err } = context();
    expect(await runCli(['ops', 'audit', 'verify'], ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('audit.verify.missing_url')]);
  });

  describe('V19: --db-url-stdin', () => {
    const withStdin = (stdin: string, tty = false) => {
      const c = context();
      const connected: string[] = [];
      const ctx: CliContext = {
        ...c.ctx,
        connect: (config) => {
          connected.push(config.connectionString);
          throw new Error('no database in unit tests');
        },
        api: {
          fetch: () => Promise.reject(new Error('no network')),
          readHiddenLine: () => Promise.reject(new Error('no prompt')),
          readStdin: () => Promise.resolve(stdin),
          stdinIsTTY: tty,
        },
      };
      return { ...c, ctx, connected };
    };
    const tokenList = ['ops', 'token', 'list', '--tenant', 'x', '--email', 'a@b.c'];

    it.each([
      [tokenList],
      [['ops', 'ai-record', 'show', '--tenant', 'x', '--project', 'p']],
      [
        [
          'ops',
          'bootstrap',
          '--tenant',
          'x',
          '--tenant-name',
          'X',
          '--email',
          'a@b.c',
          '--name',
          'A',
        ],
      ],
    ])('reads the URL from standard input, not SDLC_DB_URL, for %j', async (argv) => {
      const { ctx, err, connected } = withStdin(
        'postgres://platform_app:pw@127.0.0.1:5432/platform\n',
      );
      expect(await runCli([...argv, '--db-url-stdin'], ctx)).toBe(EXIT.error);
      expect(connected).toEqual(['postgres://platform_app:pw@127.0.0.1:5432/platform']);
      expect(err.join('\n')).not.toContain('pw@');
    });

    it.each([
      ['not a url\n', false],
      ['', false],
      ['postgres://x\n', true],
    ] as const)('refuses stdin %j (terminal: %s) with exit code 2', async (stdin, tty) => {
      const { ctx, err, connected } = withStdin(stdin, tty);
      expect(await runCli([...tokenList, '--db-url-stdin'], ctx)).toBe(EXIT.usage);
      expect(err).toEqual([t('cli.ops.db_url_stdin')]);
      expect(connected).toEqual([]);
    });
  });

  it('reports an unexpected error with exit code 3', async () => {
    const { ctx, err } = context({ SDLC_DB_URL: 'postgres://x' });
    expect(await runCli(['ops', 'audit', 'verify'], ctx)).toBe(EXIT.error);
    expect(err).toEqual([t('cli.failed', { reason: 'no database in unit tests' })]);
  });
});
