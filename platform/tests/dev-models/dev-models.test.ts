// Unit & static tests for `pnpm dev:models:up` and `dev:models:down` (D-08 V24, issue #562).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkDevModelsGuardrails,
  validatePassphrase,
} from '../../deploy/dev-models/src/guardrails';
import {
  decryptDevKeys,
  devKeyFileFor,
  encryptDevKeys,
  readDevKeyFile,
  writeDevKeyFile,
} from '../../deploy/dev-models/src/keys';
import {
  DevModelsGuardrailError,
  DevModelsStepError,
  devModelsDown,
  devModelsUp,
  type Exec,
} from '../../deploy/dev-models/src/up';
import { repoRoot } from '../workspace/helpers';

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

describe('V24 guardrails: production refusal, TTY check, passphrase validation (#562)', () => {
  it('refuses NODE_ENV=production', () => {
    const refusals = checkDevModelsGuardrails({
      nodeEnv: 'production',
      stdinIsTTY: true,
      needsSecretPrompt: false,
    });
    expect(refusals.map((r) => r.code)).toEqual(['production_env']);
  });

  it('refuses non-TTY stdin when a secret prompt is required', () => {
    const refusals = checkDevModelsGuardrails({
      nodeEnv: 'development',
      stdinIsTTY: false,
      needsSecretPrompt: true,
    });
    expect(refusals.map((r) => r.code)).toEqual(['not_tty']);
  });

  it('validates passphrase length and rejects blank values', () => {
    expect(validatePassphrase('   ').ok).toBe(false);
    expect(validatePassphrase('short').ok).toBe(false);
    expect(validatePassphrase('valid-passphrase-123').ok).toBe(true);
  });
});

describe('V24 dev:models:up fresh bootstrap, reboot unseal, and token revocation (#562)', () => {
  it('refuses immediately when NODE_ENV=production without touching Docker', async () => {
    const dir = makeTempDir('sdlc-v24-prod-');
    let called = false;
    const exec: Exec = () => {
      called = true;
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };

    await expect(
      devModelsUp({
        repoRoot: root,
        envFile: path.join(dir, '.env'),
        nodeEnv: 'production',
        stdinIsTTY: true,
        scryptLogN: 10,
        exec,
        prompts: { hidden: () => Promise.resolve('') },
        log: () => undefined,
      }),
    ).rejects.toThrow(DevModelsGuardrailError);
    expect(called).toBe(false);
  });

  it('bootstraps a fresh machine, stores encrypted key file, revokes admin token, and starts models', async () => {
    const dir = makeTempDir('sdlc-v24-fresh-');
    const envFile = path.join(dir, '.env');
    const example = fs.readFileSync(path.join(root, 'platform/deploy/.env.example'), 'utf8');
    const calls: { cmd: string; args: readonly string[]; input?: string }[] = [];
    const logs: string[] = [];
    const answers = [
      'dev-passphrase-123456',
      'dev-passphrase-123456',
      'sk-ant-test-secret-key-999',
    ];

    const exec: Exec = (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input });
      if (cmd.endsWith('init-env.sh')) {
        fs.writeFileSync(args[0]!, example, { mode: 0o600 });
        return Promise.resolve({ status: 0, stdout: '', stderr: '' });
      }
      if (cmd.endsWith('bootstrap.sh') && args[0] === 'status') {
        return Promise.resolve({ status: 0, stdout: 'OpenBao is uninitialised\n', stderr: '' });
      }
      if (cmd.endsWith('bootstrap.sh') && args[0] === 'init') {
        return Promise.resolve({
          status: 0,
          stdout: [
            'Unseal Key 1: share-aaaaaaaaaaaaaaaaaaaaaa',
            'Unseal Key 2: share-bbbbbbbbbbbbbbbbbbbbbb',
            'Unseal Key 3: share-cccccccccccccccccccccc',
            'Initial Root Token: hvs.rootdevtoken00000000000000',
          ].join('\n'),
          stderr: '',
        });
      }
      if (cmd.endsWith('bootstrap.sh') && args[0] === 'configure') {
        return Promise.resolve({
          status: 0,
          stdout: 'admin-token: hvs.admindevtoken0000000000000',
          stderr: '',
        });
      }
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };

    const res = await devModelsUp({
      repoRoot: root,
      envFile,
      nodeEnv: 'development',
      stdinIsTTY: true,
      scryptLogN: 10,
      exec,
      prompts: { hidden: () => Promise.resolve(answers.shift() ?? '') },
      log: (line) => logs.push(line),
    });

    expect(res.state).toBe('uninitialised');
    expect(res.providerStored).toBe('anthropic');
    expect(fs.existsSync(res.keyFile)).toBe(true);
    expect(fs.statSync(res.keyFile).mode & 0o777).toBe(0o600);

    // Provider key must never appear in .env or logs.
    const writtenEnv = fs.readFileSync(envFile, 'utf8');
    expect(writtenEnv).not.toContain('sk-ant-test-secret-key-999');
    expect(logs.join('\n')).not.toContain('sk-ant-test-secret-key-999');

    // Delivered litellm-credentials, revoked admin token, and started core + models.
    expect(
      calls.some((c) => c.cmd.endsWith('bootstrap.sh') && c.args[0] === 'litellm-credentials'),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.cmd === 'docker' &&
          c.args.join(' ').includes('bao token revoke -self') &&
          c.input?.includes('hvs.admindevtoken0000000000000'),
      ),
    ).toBe(true);
    expect(calls.some((c) => c.cmd.endsWith('up.sh') && c.args.join(',') === 'core,models')).toBe(
      true,
    );
  });

  it('unseals existing sealed dev OpenBao after reboot without wiping volumes', async () => {
    const dir = makeTempDir('sdlc-v24-reboot-');
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'COMPOSE_PROJECT_NAME=sdlc\n', { mode: 0o600 });

    const keyFile = devKeyFileFor(envFile);
    const bytes = await encryptDevKeys(
      {
        project: 'sdlc',
        createdAt: new Date().toISOString(),
        shares: ['share-1111111111111111111111', 'share-2222222222222222222222'],
      },
      'reboot-passphrase-123',
      10,
    );
    writeDevKeyFile(keyFile, bytes);

    // Sanity check decrypt round-trip.
    const decrypted = await decryptDevKeys(
      readDevKeyFile(keyFile),
      'reboot-passphrase-123',
      'sdlc',
    );
    expect(decrypted.shares).toHaveLength(2);

    const calls: { cmd: string; args: readonly string[] }[] = [];
    const exec: Exec = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd.endsWith('bootstrap.sh') && args[0] === 'status') {
        return Promise.resolve({ status: 0, stdout: 'OpenBao is sealed\n', stderr: '' });
      }
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };

    const res = await devModelsUp({
      repoRoot: root,
      envFile,
      nodeEnv: 'development',
      stdinIsTTY: true,
      scryptLogN: 10,
      exec,
      prompts: { hidden: () => Promise.resolve('reboot-passphrase-123') },
      log: () => undefined,
    });

    expect(res.state).toBe('sealed');
    expect(res.providerStored).toBe('unchanged');
    expect(calls.some((c) => c.cmd.endsWith('bootstrap.sh') && c.args[0] === 'unseal')).toBe(true);
    expect(calls.some((c) => c.cmd.endsWith('bootstrap.sh') && c.args[0] === 'init')).toBe(false);
    expect(calls.some((c) => c.cmd.endsWith('up.sh') && c.args.join(',') === 'core,models')).toBe(
      true,
    );
  });

  it('revokes temporary admin token even when a later step fails', async () => {
    const dir = makeTempDir('sdlc-v24-fail-');
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'COMPOSE_PROJECT_NAME=sdlc\n', { mode: 0o600 });
    const answers = ['dev-passphrase-123456', 'dev-passphrase-123456', ''];
    let adminRevoked = false;

    const exec: Exec = (cmd, args, opts) => {
      if (cmd.endsWith('bootstrap.sh') && args[0] === 'status') {
        return Promise.resolve({ status: 0, stdout: 'OpenBao is uninitialised\n', stderr: '' });
      }
      if (cmd.endsWith('bootstrap.sh') && args[0] === 'init') {
        return Promise.resolve({
          status: 0,
          stdout: [
            'Unseal Key 1: share-aaaaaaaaaaaaaaaaaaaaaa',
            'Unseal Key 2: share-bbbbbbbbbbbbbbbbbbbbbb',
            'Unseal Key 3: share-cccccccccccccccccccccc',
            'Initial Root Token: hvs.rootdevtoken00000000000000',
          ].join('\n'),
          stderr: '',
        });
      }
      if (cmd.endsWith('bootstrap.sh') && args[0] === 'configure') {
        return Promise.resolve({
          status: 0,
          stdout: 'admin-token: hvs.admindevtoken0000000000000',
          stderr: '',
        });
      }
      if (cmd.endsWith('bootstrap.sh') && args[0] === 'litellm-credentials') {
        return Promise.resolve({ status: 1, stdout: '', stderr: 'simulated failure' });
      }
      if (
        cmd === 'docker' &&
        args.join(' ').includes('bao token revoke -self') &&
        opts?.input?.includes('hvs.admindevtoken0000000000000')
      ) {
        adminRevoked = true;
      }
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };

    await expect(
      devModelsUp({
        repoRoot: root,
        envFile,
        nodeEnv: 'development',
        stdinIsTTY: true,
        scryptLogN: 10,
        exec,
        prompts: { hidden: () => Promise.resolve(answers.shift() ?? '') },
        log: () => undefined,
      }),
    ).rejects.toThrow(DevModelsStepError);

    expect(adminRevoked).toBe(true);
  });

  it('devModelsDown stops litellm services without passing --volumes', async () => {
    const dir = makeTempDir('sdlc-v24-down-');
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'COMPOSE_PROJECT_NAME=sdlc\n');
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const exec: Exec = (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };

    const r = await devModelsDown({ repoRoot: root, envFile, exec });
    expect(r.status).toBe(0);
    expect(calls[0]?.args).toContain('stop');
    expect(calls[0]?.args).toContain('litellm');
    expect(calls[0]?.args).toContain('litellm-agent');
    expect(calls[0]?.args).not.toContain('--volumes');
  });
});

describe('V24 Claude Code bash hook blocks pnpm dev:models:up (R035)', () => {
  const hook = path.join(root, 'platform/tools/claude-hooks/guard-bash.mjs');

  function runHook(command: string) {
    return spawnSync('node', [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
    });
  }

  it('refuses pnpm dev:models:up and pnpm run dev:models:up with R035', () => {
    for (const cmd of ['pnpm dev:models:up', 'pnpm run dev:models:up']) {
      const r = runHook(cmd);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('R035');
    }
  });

  it('allows pnpm dev:models:down', () => {
    const r = runHook('pnpm dev:models:down');
    expect(r.status).toBe(0);
  });
});
