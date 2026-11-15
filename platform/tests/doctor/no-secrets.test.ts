// `pnpm doctor` prints no secret (D-08 V07 AC3). Marker values stand for secrets in the env file,
// in log lines and in the worker's answer; no marker may reach the facts or the output (text, JSON).
import fs from 'node:fs';
import path from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { evaluate } from '../../deploy/doctor/src/checks/index.js';
import {
  ENV_ALLOWLIST,
  parseEnvFacts,
  requiredSecrets,
} from '../../deploy/doctor/src/env-facts.js';
import { parseWorkerGitHub } from '../../deploy/doctor/src/host.js';
import { findLogEvents } from '../../deploy/doctor/src/logs.js';
import { renderJson, renderText } from '../../deploy/doctor/src/render.js';
import { repoRoot } from '../workspace/helpers';
import { healthyFacts } from './fixtures.js';

// Built at run time: no secret-shaped literal in the repository.
const MARK = ['zz', 'secret', 'marker', String(Date.now())].join('-');
const example = fs.readFileSync(path.join(repoRoot(), 'platform/deploy/.env.example'), 'utf8');
const required = requiredSecrets(example);

function envText(): string {
  const lines = required.map((key, i) => `${key}=${MARK}${String(i)}`);
  lines.push('COMPOSE_PROJECT_NAME=sdlc', 'SDLC_OPENBAO_TLS_DIR=/srv/tls');
  lines.push(`SOME_UNKNOWN_TOKEN=${MARK}-unknown`);
  return lines.join('\n');
}

describe('pnpm doctor prints no secret', () => {
  it('.env.example names the secrets; every one is a real placeholder key', () => {
    expect(required.length).toBeGreaterThan(5);
    expect(required).toContain('PLATFORM_APP_DB_PASSWORD');
    expect(required).toContain('LITELLM_MASTER_KEY');
    for (const key of ENV_ALLOWLIST) expect(required).not.toContain(key);
  });

  it('the env facts keep allowlisted settings and secret states only', () => {
    const facts = parseEnvFacts(envText(), required);
    expect(JSON.stringify(facts)).not.toContain(MARK);
    expect(Object.keys(facts.values).sort()).toEqual([
      'COMPOSE_PROJECT_NAME',
      'SDLC_OPENBAO_TLS_DIR',
    ]);
    expect(new Set(Object.values(facts.secrets))).toEqual(new Set(['set']));
  });

  it('log lines with secrets in any field give event codes only', () => {
    const lines = [
      JSON.stringify({ event: 'worker.evidence_missing', token: MARK, message: MARK }),
      JSON.stringify({ event: 'worker.started', password: MARK }),
      JSON.stringify({
        event: 'worker.failed',
        message: `${t('secrets.login_failed', { status: 400, file: MARK })}`,
      }),
      `not json ${MARK}`,
    ];
    const found = findLogEvents(lines.join('\n'));
    expect(found).toEqual({
      events: ['worker.approle_login_failed', 'worker.evidence_missing'],
      started: ['sdlc-worker'],
      webhookDelivered: false,
    });
    expect(JSON.stringify(found)).not.toContain(MARK);
  });

  it("the worker's answer drops every field it does not know", () => {
    const answer = JSON.stringify({
      ok: true,
      private_key: MARK,
      app: { permissions: { contents: 'write' }, token: MARK },
      repos: [
        { repo: 'acme/shop', installed: true, selection: 'selected', permissions: {}, jwt: MARK },
      ],
    });
    expect(JSON.stringify(parseWorkerGitHub(0, answer))).not.toContain(MARK);
  });

  it('the whole output, text and JSON, holds no marker', () => {
    const facts = healthyFacts({
      envFile: {
        path: '/srv/sdlc/.env',
        exists: true,
        mode: 0o100600,
        facts: parseEnvFacts(envText(), required),
      },
      logs: findLogEvents(JSON.stringify({ event: 'api.evidence_missing', secret_id: MARK })),
    });
    const results = evaluate(facts);
    expect(renderText(results, '/srv/sdlc/.env').join('\n')).not.toContain(MARK);
    expect(renderJson(results, '/srv/sdlc/.env')).not.toContain(MARK);
  });
});
