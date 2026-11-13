// D-08 X04 PR 3b (design/ADR-M69 §2.4, §2.8; QUESTIONS #535, #537, #540): the database logins of a
// run's tools from OpenBao's database engine. One role per run, `kdocs-<run_id>`, whose only grant
// is the project's read role; the run ID alone finds the leases and the role again, so no lease ID
// is kept or travels. The statement is built from checked names only.
import {
  creationStatements,
  DatabaseCredentials,
  REVOCATION_STATEMENTS,
  runDatabaseRole,
  SecretsError,
} from '@sdlc/secrets';
import { describe, expect, it } from 'vitest';

const RUN = '11111111-1111-4111-8111-111111111111';
const ROLE = `kdocs_p${'a1'.repeat(16)}_read`;

interface Request {
  operation: string;
  method: string;
  path: string;
  body?: unknown;
  accept?: readonly number[];
}

function caller(answers: Record<string, { status: number; body?: unknown }> = {}) {
  const requests: Request[] = [];
  const call = (request: Request) => {
    requests.push(request);
    const answer = answers[`${request.method} ${request.path}`] ?? { status: 204 };
    return Promise.resolve({ status: answer.status, body: answer.body });
  };
  return { call, requests };
}

const CREDS = {
  'GET database/creds/kdocs-11111111-1111-4111-8111-111111111111': {
    status: 200,
    body: {
      lease_id: 'database/creds/kdocs-…/LEASE-CANARY',
      data: { username: 'v-tool-login', password: 'PASSWORD-CANARY' },
    },
  },
};

describe('the run database login (QUESTIONS #540)', () => {
  it('writes the run role, then reads one login; the login is redacted', async () => {
    const { call, requests } = caller(CREDS);
    const creds = new DatabaseCredentials('database', call);
    const login = await creds.issueRunLogin({ runId: RUN, grantRole: ROLE, ttlSeconds: 3600 });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST database/roles/kdocs-${RUN}`,
      `GET database/creds/kdocs-${RUN}`,
    ]);
    expect(requests[0]!.body).toEqual({
      db_name: 'knowledge-db',
      creation_statements: creationStatements(ROLE),
      revocation_statements: REVOCATION_STATEMENTS,
      default_ttl: 3600,
      max_ttl: 3600,
    });
    expect(login.password.reveal()).toBe('PASSWORD-CANARY');
    expect(JSON.stringify(login)).not.toContain('CANARY');
    // The lease ID is not returned: nothing could keep or pass it on.
    expect(Object.keys(login).sort()).toEqual(['password', 'username']);
  });

  it('grants the project read role only: login, no other right, an end date', () => {
    const [statement] = creationStatements(ROLE);
    expect(statement).toContain(`IN ROLE ${ROLE};`);
    expect(statement).toContain("VALID UNTIL '{{expiration}}'");
    for (const right of ['NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION']) {
      expect(statement).toContain(right);
    }
    expect(REVOCATION_STATEMENTS.join(' ')).toContain('pg_terminate_backend');
    expect(REVOCATION_STATEMENTS.join(' ')).toContain('DROP ROLE IF EXISTS "{{name}}"');
  });

  it.each<[string, { runId?: string; grantRole?: string; ttlSeconds?: number }]>([
    ['a run ID that is not a UUID', { runId: '../../sys' }],
    ['another role', { grantRole: 'kdocs_issuer' }],
    ['a role with SQL', { grantRole: `${ROLE}; DROP ROLE x` }],
    ['the platform role', { grantRole: 'platform_app' }],
    ['a lifetime over one day', { ttlSeconds: 86_401 }],
    ['a lifetime under one minute', { ttlSeconds: 30 }],
  ])('refuses %s before any request', async (_name, change) => {
    const { call, requests } = caller(CREDS);
    const error = await new DatabaseCredentials('database', call)
      .issueRunLogin({ runId: RUN, grantRole: ROLE, ttlSeconds: 3600, ...change })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretsError);
    expect(requests).toEqual([]);
  });

  it('an answer without a login is refused, with no value in the error', async () => {
    const { call } = caller({
      [`GET database/creds/kdocs-${RUN}`]: { status: 200, body: { data: {} } },
    });
    await expect(
      new DatabaseCredentials('database', call).issueRunLogin({
        runId: RUN,
        grantRole: ROLE,
        ttlSeconds: 3600,
      }),
    ).rejects.toMatchObject({ key: 'secrets.openbao.invalid_response' });
  });

  it('revokes every lease of the run by its prefix, then deletes the role; twice is harmless', async () => {
    const { call, requests } = caller({
      [`DELETE database/roles/kdocs-${RUN}`]: { status: 404 },
    });
    const creds = new DatabaseCredentials('database', call);
    await creds.revokeRunLogins(RUN);
    await creds.revokeRunLogins(RUN);
    // X06: the prefix also ends `kdocs-<run>-code`; both roles are deleted.
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST sys/leases/revoke-prefix/database/creds/kdocs-${RUN}`,
      `DELETE database/roles/kdocs-${RUN}`,
      `DELETE database/roles/kdocs-${RUN}-code`,
      `POST sys/leases/revoke-prefix/database/creds/kdocs-${RUN}`,
      `DELETE database/roles/kdocs-${RUN}`,
      `DELETE database/roles/kdocs-${RUN}-code`,
    ]);
    expect(requests[1]!.accept).toEqual([404]);
    expect(runDatabaseRole(RUN)).toBe(`kdocs-${RUN}`);
  });
});

describe('X06: the login of a read_code tool (ADR-M108 §2.8, QUESTIONS #700)', () => {
  const CODE_ROLE = `kcode_p${'a1'.repeat(16)}_read`;

  it('uses the role kdocs-<run>-code and grants the code read role only', async () => {
    const { call, requests } = caller({
      [`GET database/creds/kdocs-${RUN}-code`]: CREDS[`GET database/creds/kdocs-${RUN}`],
    });
    const login = await new DatabaseCredentials('database', call).issueRunLogin({
      runId: RUN,
      grantRole: CODE_ROLE,
      ttlSeconds: 3600,
      kind: 'code',
    });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST database/roles/kdocs-${RUN}-code`,
      `GET database/creds/kdocs-${RUN}-code`,
    ]);
    expect((requests[0]!.body as { creation_statements: string[] }).creation_statements).toEqual(
      creationStatements(CODE_ROLE, 'code'),
    );
    expect(login.password.reveal()).toBe('PASSWORD-CANARY');
    expect(runDatabaseRole(RUN, 'code')).toBe(`kdocs-${RUN}-code`);
  });

  it("never pairs a kind with the other kind's read role", async () => {
    for (const [kind, role] of [
      ['code', ROLE],
      ['docs', CODE_ROLE],
    ] as const) {
      const { call, requests } = caller(CREDS);
      await expect(
        new DatabaseCredentials('database', call).issueRunLogin({
          runId: RUN,
          grantRole: role,
          ttlSeconds: 3600,
          kind,
        }),
      ).rejects.toBeInstanceOf(SecretsError);
      expect(requests).toEqual([]);
    }
  });
});
