// D-08 X04 PR 3b (design/ADR-M69 §2.4, §2.8; QUESTIONS #535, #540, #541): the credentials of a
// run's `read_documents` tool, issued by the worker in the run preparation and revoked at the end
// of the run, at a kill and for an abandoned run. Only the wrapping token and the index ID go on;
// revoking twice is harmless and the run events are written once per tool.
import type { RedactedSecret, RunDatabaseCredentials, ToolGrant } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  endRunCredentials,
  issueToolSecrets,
  revokeToolCredentials,
  smallerUsd,
} from '../../packages/core/src/tools/credentials.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';
import { contract } from '../run-contract/helpers.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const INDEX = '44444444-4444-4444-8444-444444444444';

const secret = (value: string): RedactedSecret => ({ reveal: () => value });

const grant = (key: string, permissions: ToolGrant['permissions'] = ['read_documents']) =>
  ({
    tool_key: key,
    tool_version: '1.0.0',
    transport: 'http',
    image_digest: `sha256:${'d'.repeat(64)}`,
    permissions,
    call_rules_sha256: 'a'.repeat(64),
    backing_services: ['knowledge-db:5432', 'litellm:4000'],
    max_calls: 100,
  }) as ToolGrant;

function fakeScope(grants: ToolGrant[]) {
  const events: { event_type: string; payload: Record<string, unknown> }[] = [];
  const stored = contract({
    schema_version: 3,
    allowed_tools: ['editor', ...grants.map((g) => `tool:${g.tool_key}`)],
    tool_grants: grants,
  });
  const scope = {
    tenantId: '33333333-3333-4333-8333-333333333333',
    runContracts: { getByRunId: () => Promise.resolve({ contract_json: stored }) },
    runEvents: {
      list: () => Promise.resolve([...events]),
      append: (_run: string, event_type: string, payload: Record<string, unknown>) => {
        events.push({ event_type, payload });
        return Promise.resolve();
      },
    },
  } as unknown as TenantScope;
  return { scope, events };
}

function fakeCredentials(fail = false) {
  const calls: string[] = [];
  const creds: RunDatabaseCredentials = {
    issueRunLogin: (input) => {
      calls.push(`issue ${input.runId} ${input.grantRole} ${String(input.ttlSeconds)}`);
      return Promise.resolve({ username: secret('v-login'), password: secret('PW') });
    },
    revokeRunLogins: (runId) => {
      calls.push(`revoke ${runId}`);
      return fail ? Promise.reject(new Error('sealed')) : Promise.resolve();
    },
  };
  return { creds, calls };
}

describe('issuing the secrets of a read_documents tool (QUESTIONS #535, #541)', () => {
  it('one login and one model key per tool, wrapped together; others get nothing', async () => {
    const { scope } = fakeScope([]);
    const { creds, calls } = fakeCredentials();
    const wrapped: { fields: string[]; ttl: number }[] = [];
    const keys: string[] = [];
    const result = await issueToolSecrets(
      scope,
      {
        databaseCredentials: creds,
        wrapper: {
          wrap: (fields, options) => {
            wrapped.push({ fields: Object.keys(fields), ttl: options.ttlSeconds });
            return Promise.resolve(secret('wrapping-token'));
          },
        },
        costController: {
          issueToolKey: (input) => {
            keys.push(`${input.toolKey} ${input.model} ${input.maxBudgetUsd} ${input.gate}`);
            return Promise.resolve({ keyId: 'k', key: secret('sk-tool'), expiresAt: new Date() });
          },
        },
      },
      {
        runId: RUN,
        projectId: PROJECT,
        grants: [grant('project-docs'), grant('other-tool', [] as never)],
        indexIds: new Map([['project-docs', INDEX]]),
        models: new Map([['project-docs', 'bge-m3']]),
        ttlSeconds: 3900,
        wrapTtlSeconds: 900,
        toolBudgetUsd: '0.5',
      },
    );
    expect(calls).toEqual([`issue ${RUN} kdocs_p${PROJECT.replaceAll('-', '')}_read 3900`]);
    expect(keys).toEqual(['project-docs bge-m3 0.5 G4']);
    expect(wrapped).toEqual([{ fields: ['db_username', 'db_password', 'llm_key'], ttl: 900 }]);
    expect([...result.keys()]).toEqual(['project-docs']);
    expect(result.get('project-docs')!.indexId).toBe(INDEX);
  });

  it('without the database engine a read_documents run cannot get its tool', async () => {
    const { scope } = fakeScope([]);
    await expect(
      issueToolSecrets(
        scope,
        {
          databaseCredentials: undefined,
          wrapper: { wrap: () => Promise.resolve(secret('x')) },
          costController: { issueToolKey: () => Promise.reject(new Error('unused')) },
        },
        {
          runId: RUN,
          projectId: PROJECT,
          grants: [grant('project-docs')],
          indexIds: new Map([['project-docs', INDEX]]),
          models: new Map([['project-docs', 'bge-m3']]),
          ttlSeconds: 3900,
          wrapTtlSeconds: 900,
          toolBudgetUsd: '0.5',
        },
      ),
    ).rejects.toThrow();
  });

  it('X06: a read_code tool gets a login of the code read role and no model key', async () => {
    const { scope } = fakeScope([]);
    const kinds: string[] = [];
    const wrapped: string[][] = [];
    const { creds } = fakeCredentials();
    const result = await issueToolSecrets(
      scope,
      {
        databaseCredentials: {
          ...creds,
          issueRunLogin: (input) => {
            kinds.push(`${input.kind ?? 'docs'} ${input.grantRole}`);
            return creds.issueRunLogin(input);
          },
        },
        wrapper: {
          wrap: (fields) => {
            wrapped.push(Object.keys(fields));
            return Promise.resolve(secret('wrapping-token'));
          },
        },
        costController: { issueToolKey: () => Promise.reject(new Error('no key for code')) },
      },
      {
        runId: RUN,
        projectId: PROJECT,
        grants: [grant('code-index', ['read_code'])],
        indexIds: new Map([['code-index', INDEX]]),
        models: new Map(),
        ttlSeconds: 3900,
        wrapTtlSeconds: 900,
        toolBudgetUsd: '0.5',
      },
    );
    expect(kinds).toEqual([`code kcode_p${PROJECT.replaceAll('-', '')}_read`]);
    expect(wrapped).toEqual([['db_username', 'db_password']]);
    expect(result.get('code-index')).toMatchObject({ indexId: INDEX });
  });

  it('the tool key never gets more than the run key', () => {
    expect(smallerUsd('0.5', '2')).toBe('0.5');
    expect(smallerUsd('0.5', '0.1')).toBe('0.1');
  });
});

describe('revoking at the end, at a kill and for an abandoned run (ADR-M69 §2.8)', () => {
  it("revokes the run's logins once per call and records each tool once", async () => {
    const { scope, events } = fakeScope([grant('project-docs')]);
    const { creds, calls } = fakeCredentials();
    const revoked: unknown[] = [];
    const deps = {
      costController: {
        endRunKey: (input: unknown) => {
          revoked.push(input);
          return Promise.resolve({} as never);
        },
      },
      databaseCredentials: creds,
    };
    const from = new Date('2026-10-24T00:00:00Z');
    await endRunCredentials(scope, deps, RUN, from); // the kill
    await endRunCredentials(scope, deps, RUN, from); // the end of the run
    expect(revoked).toEqual([
      { runId: RUN, syncFrom: from, toolKeys: ['project-docs'] },
      { runId: RUN, syncFrom: from, toolKeys: ['project-docs'] },
    ]);
    expect(calls).toEqual([`revoke ${RUN}`, `revoke ${RUN}`]);
    expect(events).toEqual([
      { event_type: 'tool_credential_revoked', payload: { tool_key: 'project-docs' } },
    ]);
  });

  it('a failure is recorded once with a code, never thrown; a later success is recorded too', async () => {
    const { scope, events } = fakeScope([grant('project-docs')]);
    await revokeToolCredentials(scope, fakeCredentials(true).creds, RUN, [grant('project-docs')]);
    await revokeToolCredentials(scope, fakeCredentials(true).creds, RUN, [grant('project-docs')]);
    await revokeToolCredentials(scope, undefined, RUN, [grant('project-docs')]);
    await revokeToolCredentials(scope, fakeCredentials().creds, RUN, [grant('project-docs')]);
    expect(events).toEqual([
      {
        event_type: 'tool_credential_revoke_failed',
        payload: { tool_key: 'project-docs', reason: 'revoke_failed' },
      },
      { event_type: 'tool_credential_revoked', payload: { tool_key: 'project-docs' } },
    ]);
  });

  it('a run without a read_documents tool revokes its key only', async () => {
    const { scope, events } = fakeScope([]);
    const { creds, calls } = fakeCredentials();
    const revoked: unknown[] = [];
    await endRunCredentials(
      scope,
      {
        costController: {
          endRunKey: (input) => {
            revoked.push(input);
            return Promise.resolve({} as never);
          },
        },
        databaseCredentials: creds,
      },
      RUN,
      new Date(0),
    );
    expect(revoked).toEqual([{ runId: RUN, syncFrom: new Date(0) }]);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });
});
