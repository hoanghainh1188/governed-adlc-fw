// Unit tests for the 5-minute local demo mode (D-08 V23, issue #561).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadProjectConfig } from '@sdlc/config';
import { parsePlanFile } from '../../packages/core/src/plans/parse';
import { DEMO_PERSON_A, DEMO_PERSON_B, demoProjectConfig } from '../../deploy/demo/src/demo-config';
import { demoDown, demoDownRefusal } from '../../deploy/demo/src/down';
import { DEMO_PROFILES, DEMO_PROJECT, demoApiUrl, demoEnv } from '../../deploy/demo/src/env-file';
import { demoPreflight, type DemoHostFacts } from '../../deploy/demo/src/preflight';
import { demoUp, type Exec, type Sdlc } from '../../deploy/demo/src/up';
import { runWalkthrough } from '../../deploy/demo/src/walkthrough';
import { repoRoot } from '../workspace/helpers';

const GIB = 1024 ** 3;
const root = repoRoot();
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function cleanFacts(overrides: Partial<DemoHostFacts> = {}): DemoHostFacts {
  return {
    nodeEnv: 'development',
    envFile: '/repo/platform/deploy/.demo/.env',
    envFileExists: false,
    nonDemoVolumes: [],
    demoVolumes: [],
    docker: { composeVersion: '2.29.1', memoryBytes: 8 * GIB },
    opensslVersion: 'OpenSSL 3.3.1 4 Jun 2024',
    ...overrides,
  };
}

describe('V23 local demo preflight guardrails (#561)', () => {
  it('allows a clean development host with Docker >= 4 GiB and OpenSSL 3', () => {
    expect(demoPreflight(cleanFacts())).toEqual([]);
  });

  it('refuses NODE_ENV=production', () => {
    const refusals = demoPreflight(cleanFacts({ nodeEnv: 'production' }));
    expect(refusals.map((r) => r.code)).toContain('production_env');
  });

  it('refuses when non-demo sdlc_* volumes exist', () => {
    const refusals = demoPreflight(cleanFacts({ nonDemoVolumes: ['sdlc_postgres-data'] }));
    expect(refusals.map((r) => r.code)).toContain('non_demo_volumes_exist');
  });

  it('refuses when existing sdlc-demo_* volumes or .demo/.env already exist', () => {
    const refusals = demoPreflight(
      cleanFacts({ envFileExists: true, demoVolumes: ['sdlc-demo_postgres-data'] }),
    );
    expect(refusals.map((r) => r.code)).toEqual(['env_exists', 'demo_volumes_exist']);
  });

  it('refuses unknown volumes, missing Docker, old compose, low memory, or old OpenSSL', () => {
    expect(demoPreflight(cleanFacts({ nonDemoVolumes: null })).map((r) => r.code)).toContain(
      'volumes_unknown',
    );
    expect(demoPreflight(cleanFacts({ docker: null })).map((r) => r.code)).toContain('no_docker');
    expect(
      demoPreflight(
        cleanFacts({
          docker: { composeVersion: '2.20.0', memoryBytes: 2 * GIB },
          opensslVersion: 'LibreSSL 3.3.6',
        }),
      ).map((r) => r.code),
    ).toEqual(['compose_old', 'docker_memory', 'openssl_old']);
  });
});

describe('V23 demo env, project config, and sample plan (#561)', () => {
  it('writes an isolated Lite Mode env file from .env.example', () => {
    const example = fs.readFileSync(path.join(root, 'platform/deploy/.env.example'), 'utf8');
    const out = demoEnv(example);
    expect(out).toMatch(/^COMPOSE_PROJECT_NAME=sdlc-demo$/m);
    expect(out).toMatch(/^SDLC_OBSERVABILITY_ENABLED=false$/m);
    expect(out).toMatch(/^LITELLM_MASTER_KEY=$/m);
    expect(out).toMatch(/^LITELLM_SALT_KEY=$/m);
    expect(demoApiUrl(out)).toBe('http://127.0.0.1:8090');
    expect(DEMO_PROFILES).toEqual(['core', 'models', 'platform']);
  });

  it('produces a valid project config with U10 uploaded plans enabled', () => {
    const res = loadProjectConfig(demoProjectConfig());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.oversight.uploaded_plan_risks).toEqual(['low', 'medium']);
    expect(res.config.access.evidence_build_roles).toEqual(['person_a', 'person_b']);
    expect(res.config.access.evidence_read_roles).toEqual(['person_a', 'person_b']);
  });

  it('ships a valid sample-plan.yaml accepted by parsePlanFile', () => {
    const yaml = fs.readFileSync(path.join(root, 'platform/deploy/demo/sample-plan.yaml'), 'utf8');
    const parsed = parsePlanFile(yaml, 'INT-2026-0001');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.plannedFiles).toContain('src/orders/pricing.ts');
    expect(parsed.plan.allowedTools).toEqual(['file_editor', 'terminal']);
  });
});

describe('V23 demo:down guardrails and --wipe (#561)', () => {
  it('refuses missing env or non-demo Compose project', () => {
    expect(demoDownRefusal(undefined)).toBe('no_env');
    expect(demoDownRefusal('COMPOSE_PROJECT_NAME=sdlc\n')).toBe('not_demo');
    expect(demoDownRefusal(`COMPOSE_PROJECT_NAME=${DEMO_PROJECT}\n`)).toBeUndefined();
  });

  it('passes -p sdlc-demo and removes demoDir only when --wipe is true', async () => {
    const demoDir = makeTempDir('sdlc-demo-down-');
    fs.writeFileSync(path.join(demoDir, '.env'), `COMPOSE_PROJECT_NAME=${DEMO_PROJECT}\n`);

    const calls: { cmd: string; args: readonly string[] }[] = [];
    const exec: Exec = (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };

    // Without --wipe: keeps demoDir.
    const keep = await demoDown({ repoRoot: root, demoDir, wipe: false, exec });
    expect(keep.status).toBe(0);
    expect(calls[0]?.args).toContain('-p');
    expect(calls[0]?.args).toContain(DEMO_PROJECT);
    expect(calls[0]?.args).not.toContain('--volumes');
    expect(fs.existsSync(demoDir)).toBe(true);

    // With --wipe: passes --volumes and deletes demoDir.
    const wiped = await demoDown({ repoRoot: root, demoDir, wipe: true, exec });
    expect(wiped.status).toBe(0);
    expect(calls[1]?.args).toContain('--volumes');
    expect(fs.existsSync(demoDir)).toBe(false);
  });
});

describe('V23 demo:up and walkthrough orchestration (#561)', () => {
  it('bootstraps Lite Mode, throw-away OpenBao, and two demo users without GitHub App', async () => {
    const demoDir = makeTempDir('sdlc-demo-up-');
    const example = fs.readFileSync(path.join(root, 'platform/deploy/.env.example'), 'utf8');
    const execCalls: {
      cmd: string;
      args: readonly string[];
      env?: Readonly<Record<string, string>>;
    }[] = [];
    const sdlcCalls: { argv: readonly string[] }[] = [];

    const exec: Exec = (cmd, args, opts) => {
      execCalls.push({ cmd, args, env: opts?.env });
      if (cmd.endsWith('init-env.sh')) {
        fs.writeFileSync(args[0]!, example, { mode: 0o600 });
        return Promise.resolve({ status: 0, stdout: '', stderr: '' });
      }
      if (cmd === 'docker' && args.join(' ').includes('bao operator init')) {
        return Promise.resolve({
          status: 0,
          stdout: JSON.stringify({
            unseal_keys_b64: [
              'share-aaaaaaaaaaaaaaaaaaaaaa',
              'share-bbbbbbbbbbbbbbbbbbbbbb',
              'share-cccccccccccccccccccccc',
            ],
            root_token: 'hvs.rootdemotoken00000000000000',
          }),
          stderr: '',
        });
      }
      if (cmd.endsWith('bootstrap.sh') && args[0] === 'configure') {
        return Promise.resolve({
          status: 0,
          stdout: 'admin-token: hvs.admindemotoken0000000000000',
          stderr: '',
        });
      }
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };

    const sdlc: Sdlc = (argv) => {
      sdlcCalls.push({ argv });
      if (argv[0] === 'ops' && argv[1] === 'bootstrap') {
        return Promise.resolve({
          status: 0,
          stdout: JSON.stringify({ token: 'sdlc_pat_demo_a' }),
          stderr: '',
        });
      }
      if (argv[0] === 'ops' && argv[1] === 'token') {
        return Promise.resolve({
          status: 0,
          stdout: JSON.stringify({ token: 'sdlc_pat_demo_b' }),
          stderr: '',
        });
      }
      if (argv[0] === 'admin' && argv[1] === 'config' && argv[2] === 'show') {
        return Promise.resolve({ status: 0, stdout: JSON.stringify({ version: 1 }), stderr: '' });
      }
      return Promise.resolve({ status: 0, stdout: '{}', stderr: '' });
    };

    const res = await demoUp({
      repoRoot: root,
      demoDir,
      exec,
      sdlc,
      log: () => undefined,
    });

    expect(res.composeProject).toBe(DEMO_PROJECT);
    expect(res.apiUrl).toBe('http://127.0.0.1:8090');
    expect(
      execCalls.some((c) => c.cmd.endsWith('up.sh') && c.args.join(',') === 'core,models,platform'),
    ).toBe(true);
    expect(execCalls.some((c) => c.env?.SDLC_OPENBAO_THROWAWAY === '1')).toBe(true);
    expect(sdlcCalls.some((c) => c.argv.includes(DEMO_PERSON_A.email))).toBe(true);
    expect(sdlcCalls.some((c) => c.argv.includes(DEMO_PERSON_B.email))).toBe(true);
    expect(sdlcCalls.filter((c) => c.argv[0] === 'login')).toHaveLength(2);
  });

  it('walks an intent through G1-G3, verifies Rule M21 refusal, and builds an Evidence Pack', async () => {
    const calls: { argv: readonly string[]; who: string }[] = [];
    const personAHome = '/tmp/demo/person-a';
    const personBHome = '/tmp/demo/person-b';
    let currentGate = 'G1';

    const sdlc: Sdlc = (argv, env) => {
      const who = env.XDG_CONFIG_HOME === personAHome ? 'person-a' : 'person-b';
      calls.push({ argv, who });
      if (argv[0] === 'intent' && argv[1] === 'create') {
        return Promise.resolve({
          status: 0,
          stdout: JSON.stringify({ code: 'INT-1' }),
          stderr: '',
        });
      }
      if (argv[0] === 'intent' && argv[1] === 'show') {
        return Promise.resolve({
          status: 0,
          stdout: JSON.stringify({
            current_gate: currentGate,
            gate_entered_at: '2026-11-23T00:00:00.000Z',
          }),
          stderr: '',
        });
      }
      if (argv[0] === 'gate' && argv[1] === 'approve' && argv[2] === 'G1') {
        currentGate = 'G2';
        return Promise.resolve({ status: 0, stdout: '{}', stderr: '' });
      }
      if (argv[0] === 'admin' && argv[1] === 'role' && argv[2] === 'grant' && who === 'person-a') {
        return Promise.resolve({ status: 1, stdout: '', stderr: 'conflicting_role: Rule M21' });
      }
      if (argv[0] === 'gate' && argv[2] === 'G3' && who === 'person-a') {
        return Promise.resolve({ status: 1, stdout: '', stderr: 'self_approval: Rule M21' });
      }
      if (argv[0] === 'evidence' && argv[1] === 'build') {
        return Promise.resolve({
          status: 0,
          stdout: JSON.stringify({
            created: true,
            pack: {
              version: 1,
              manifest: { sha256: 'a'.repeat(64) },
              markdown: { sha256: 'b'.repeat(64) },
            },
          }),
          stderr: '',
        });
      }
      return Promise.resolve({ status: 0, stdout: '{}', stderr: '' });
    };

    const result = await runWalkthrough({
      repoRoot: root,
      personAConfigHome: personAHome,
      personBConfigHome: personBHome,
      apiUrl: 'http://127.0.0.1:8090',
      sdlc,
      log: () => undefined,
    });

    expect(result).toEqual({
      intent: 'INT-1',
      selfApprovalBlocked: true,
      evidenceVersion: 1,
    });
    expect(
      calls.some(
        (c) =>
          c.who === 'person-a' &&
          c.argv[0] === 'intent' &&
          c.argv.includes('--data-class') &&
          c.argv.includes('internal'),
      ),
    ).toBe(true);
    expect(
      calls.some((c) => c.who === 'person-a' && c.argv[0] === 'plan' && c.argv.includes('--file')),
    ).toBe(true);
    expect(
      calls.some((c) => c.who === 'person-a' && c.argv[0] === 'admin' && c.argv[1] === 'role'),
    ).toBe(true);
    expect(
      calls.some((c) => c.who === 'person-b' && c.argv[0] === 'intent' && c.argv[1] === 'show'),
    ).toBe(true);
    expect(
      calls.some((c) => c.who === 'person-b' && c.argv[0] === 'evidence' && c.argv[1] === 'build'),
    ).toBe(true);
  });
});
