// D-08 E07 AC3: follows `platform/deploy/README.md`, section "Fresh deployment (operator)", step by
// step, on a throw-away Compose project: from an empty env file to the first intent at G1, with
// every profile the server runs (`core models platform sandbox`). Needs Docker. Skipped unless
// SDLC_FRESH_DEPLOY_TEST=1. Run with: pnpm test:fresh-deploy (CI: the weekly run and manual
// dispatch only). The static test `platform/tests/deploy/fresh-deploy-readme.test.ts` keeps the
// README and this test in step: every credentials command the README names runs here.
//
// Steps 2–13 run through `pnpm server:setup`'s own code (`serverSetup`, D-08 V16 AC6, V19 AC5) with
// throw-away keys: a scripted terminal plays the three key holders (it reads each share the command
// shows and types two of them back at the hidden prompts) and the operator (it keeps the admin
// token shown once); the GitHub App key and the model key are throw-away files. The command runs
// twice: steps 2–7 first, then, with the sandbox image built on the started platform, again with
// the settings of steps 8–13 (a second start: steps 2–7 skip what is done). A fake GitHub API over
// HTTPS (a throw-away certificate) answers the lookups of the project file. What stays with people
// (the team's tokens, the agent's approvals, step 14) follows `deploy-steps.ts` (shared with
// `pnpm test:upgrade`, O02).
//
// Own Compose project (own name, subnet, ports +31000, random env file), removed afterwards. The
// sandbox image: SDLC_SANDBOX_IMAGE when set, else `build.sh node24`.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MessageKey } from '@sdlc/messages';

import { serverSetup } from '../../../deploy/server-setup/src/setup';
import type { Terminal } from '../../../deploy/server-setup/src/terminal';
import { exec } from '../../../deploy/steps/dist/exec.js';
import { SecretBag } from '../../../deploy/steps/dist/secrets.js';
import { repoRoot } from '../../workspace/helpers';
import { CREDENTIALS_COMMANDS, Deployment } from './deploy-steps';

/**
 * Plays the key holders (keeps each share it is shown, types them back at the share prompts) and
 * the operator (keeps the admin token of step 8, checks the GitHub IDs).
 */
function people(d: Deployment): Terminal {
  const shares: string[] = [];
  let next = 0;
  let last: MessageKey | undefined;
  return {
    say: (key) => {
      last = key;
    },
    warn: () => undefined,
    print: () => undefined,
    pause: () => Promise.resolve(),
    clear: () => undefined,
    showSecret: (text) => {
      if (last === 'server_setup.token.show') d.useToken('admin', text);
      else shares.push(d.keep(text));
    },
    hidden: (key: MessageKey) => {
      if (key !== 'server_setup.share.prompt') return Promise.reject(new Error(`prompt ${key}`));
      const share = shares[next % 2]!;
      next += 1;
      return Promise.resolve(share);
    },
  };
}

/** A fake GitHub API over HTTPS with a throw-away certificate: `GET /users/<login>` only. */
async function fakeGithub(tmp: string): Promise<{ url: string; ca: string; close: () => void }> {
  const key = path.join(tmp, 'github-key.pem');
  const ca = path.join(tmp, 'github-cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      ca,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const ids: Record<string, number> = { 'fresh-a': 7001, 'fresh-b': 7002 };
  const server = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(ca) },
    (req, res) => {
      const login = /^\/users\/([^/]+)$/.exec(req.url ?? '')?.[1] ?? '';
      const id = ids[login];
      res.writeHead(id ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(id ? { id, login, type: 'User' } : { message: 'Not Found' }));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `https://127.0.0.1:${port}`, ca, close: () => server.close() };
}

const enabled = process.env.SDLC_FRESH_DEPLOY_TEST === '1';
const PORT_OFFSET = 31000;
const SETUP_TIMEOUT_MS = 30 * 60 * 1000;

describe.skipIf(!enabled)(
  'E07 AC3: a fresh deployment following the README (live)',
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-fresh-'));
    const subnet = `172.29.${20 + (process.pid % 10)}.0/24`;
    const d = new Deployment({
      root: repoRoot(),
      tmp,
      envFile: path.join(tmp, 'it.env'),
      project: {
        project: `sdlcfresh${process.pid}`,
        subnet,
        gateway: subnet.replace(/0\/24$/, '1'),
        portOffset: PORT_OFFSET,
      },
    });
    const litellmUrl = `http://127.0.0.1:${4000 + PORT_OFFSET}`;
    const timings: Record<string, number> = {};
    let github: { url: string; ca: string; close: () => void } | undefined;
    let image = '';
    const started = Date.now();
    const mark = (step: string) => {
      timings[step] = Math.round((Date.now() - started) / 1000);
    };

    beforeAll(async () => {
      // Step 2 of the throw-away project (own name, subnet and ports); server:setup then finds the
      // env file in server mode and goes on from there.
      d.settingsFile();
      mark('env');
      const file = (name: string, text: string) => {
        const p = path.join(tmp, name);
        fs.writeFileSync(p, text, { mode: 0o600 });
        return p;
      };
      const pem = d.keep(
        generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
          type: 'pkcs1',
          format: 'pem',
        }) as string,
      );
      const providerKey = d.keep(`sk-${randomBytes(24).toString('hex')}`);
      const base = {
        envFile: d.options.envFile,
        keyHolders: [{ name: 'Holder 1' }, { name: 'Holder 2' }, { name: 'Holder 3' }],
        appClientId: 'Iv23fresh0deploy0test',
        appKeyFile: file('app.pem', pem),
        providers: [
          { provider: 'anthropic' as const, apiKeyFile: file('anthropic.key', providerKey) },
        ],
        optional: [],
        throwawayTls: true,
      };
      const terminal = people(d);
      github = await fakeGithub(tmp);
      const deps = {
        repoRoot: repoRoot(),
        envFile: d.options.envFile,
        exec,
        terminal,
        bag: new SecretBag(),
        keys: { shares: 3, threshold: 2 },
        stopRequested: () => false,
        now: () => new Date(),
        // The CLI's own HOME (its saved login) and the fake GitHub API.
        cliEnv: {
          HOME: tmp,
          SDLC_GITHUB_API_URL: github.url,
          NODE_EXTRA_CA_CERTS: github.ca,
        },
      };
      const stopped = (error: unknown) => {
        const cause = (error as { cause?: { step?: string; detail?: string } }).cause;
        throw new Error(
          `server:setup stopped: ${cause?.step ?? ''} ${d.redact(cause?.detail ?? '')}`,
        );
      };
      // Steps 2–7: the command's own code, with every credentials command of README step 5.
      const first = await serverSetup(base, deps).catch(stopped);
      expect(first.outcome).toBe('done');
      expect(CREDENTIALS_COMMANDS.length).toBe(10);
      mark('server_setup');
      d.adoptDatabase();
      // Step 10 on the started platform; then steps 8–13 through the command (V19).
      image = process.env.SDLC_SANDBOX_IMAGE ?? d.buildSandboxImage();
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
      mark('image');
      const second = await serverSetup(
        {
          ...base,
          team: {
            tenant: { slug: 'fresh', name: 'Fresh' },
            admin: { email: 'admin@fresh.test', name: 'Admin' },
            projectFile: d.projectFile(),
            sandboxImage: image,
            aiRecord: {
              aiAllowed: 'yes',
              classes: ['public', 'internal'],
              prodLogs: 'no',
              disclosure: 'standard_note',
            },
          },
        },
        deps,
      ).catch(stopped);
      expect(second.outcome).toBe('done');
      mark('team');
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      github?.close();
      process.stdout.write(`e07:fresh_deploy_seconds:${JSON.stringify(timings)}\n`);
      if (process.env.SDLC_FRESH_DEPLOY_KEEP === '1') return;
      d.down();
      fs.rmSync(tmp, { recursive: true, force: true });
    }, 300_000);

    it('step 7: every long-running service of core, models, platform and sandbox is healthy', async () => {
      const lines = d.services();
      for (const service of [
        'openbao',
        'postgres',
        'temporal',
        'litellm-agent',
        'litellm',
        'sdlc-api',
        'sdlc-worker',
        'sdlc-runner',
        'seaweedfs',
      ]) {
        expect(
          lines.find((l) => l.startsWith(`${service} `)),
          service,
        ).toMatch(/ running (healthy)?$/);
      }
      expect((await fetch(`${d.apiUrl}/health/ready`)).status).toBe(200);
      // LiteLLM runs with the configuration the sidecar rendered from OpenBao: the API model's
      // gateway name carries its version (QUESTIONS #93).
      const models = d.run('docker', [
        'exec',
        `${d.options.project.project}-litellm-1`,
        'sh',
        '-c',
        'grep -c "model_name: claude-haiku-4-5-20251001" /run/litellm/config.yaml',
      ]);
      expect(models.stdout.trim()).toBe('1');
      expect(litellmUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    });

    it('steps 8–13 through the command, then what stays with people, then the first intent at G1', async () => {
      // Steps 8–13 (V19): the tenant, the team, the agent, the configuration with the image by
      // digest, the AI record on behalf of Person A; the agent is registered, never approved.
      expect(d.sdlc('admin', ['admin', 'agent', 'show', '--key', 'coder'])).toMatchObject({
        status: 'proposed',
      });
      const config = d.sdlc('admin', ['admin', 'config', 'show', '--project', 'pilot']);
      expect(JSON.stringify(config)).toContain(image);
      expect(
        d.sdlc('operator', ['ops', 'ai-record', 'show', '--tenant', 'fresh', '--project', 'pilot']),
      ).toMatchObject({
        version: 1,
        ai_allowed: 'yes',
      });
      // What stays with people: the team's tokens and the agent's two approvals.
      d.peopleSteps();
      expect(d.sdlc('admin', ['admin', 'agent', 'show', '--key', 'coder'])).toMatchObject({
        status: 'active',
      });

      // Step 14: the first intent; the worker's workflow moves it into G1.
      const code = d.createIntent('First intent');
      expect(code).toMatch(/^INT-\d{4}-0001$/);
      expect(await d.waitForGate(code, 'G1')).toMatchObject({
        status: 'in_gate',
        current_gate: 'G1',
      });
      mark('first_intent');

      // The audit chain of the new tenant is intact (FR-41).
      expect(d.sdlc('admin', ['audit', 'verify'])).toMatchObject({ ok: true, broken: null });
    });
  },
  SETUP_TIMEOUT_MS,
);
