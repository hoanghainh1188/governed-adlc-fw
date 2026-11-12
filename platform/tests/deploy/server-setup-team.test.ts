// D-08 V19 AC1–AC5: steps 8–13 of `pnpm server:setup` (`team-steps.ts`) against a simulated `adlc`
// (a fake `exec`) and a scripted terminal. What it checks:
// - the order: the tenant and its first admin, the project file with the GitHub IDs checked first,
//   the AI record on behalf of Person A; the commands that stay with people at the end;
// - the token is shown once between two clears, then given to `adlc login --token-stdin`; no token
//   and no database URL in an argument or an environment value;
// - it never approves the agent, never issues a team member's token, never creates an intent;
// - a second run changes nothing; a stop at the confirmation changes nothing; refusals;
// - the settings of steps 8–13.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  AI_ALLOWED_VALUES,
  DATA_CLASSES,
  DISCLOSURE_FORMATS,
  PROD_LOGS_ALLOWED_VALUES,
} from '@sdlc/contracts';
import type { MessageKey, MessageParams } from '@sdlc/messages';

import type { Exec, ExecOptions } from '../../deploy/steps/dist/exec.js';
import { SecretBag } from '../../deploy/steps/dist/secrets.js';
import { parseSettings, SettingsError } from '../../deploy/server-setup/src/settings.js';
import {
  AI_ALLOWED,
  AI_RECORD_CLASSES,
  DISCLOSURES,
  PROD_LOGS,
  type TeamSettings,
} from '../../deploy/server-setup/src/team-settings.js';
import { TeamRefused, teamSteps, type TeamStep } from '../../deploy/server-setup/src/team-steps.js';
import { PromptAborted, type Terminal } from '../../deploy/server-setup/src/terminal.js';

const APP_DB = ['pw', 'app', '0123456789'].join('-');
const IMAGE = `ghcr.io/acme/sandbox-node24@sha256:${'a'.repeat(64)}`;
const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Call {
  readonly args: readonly string[];
  readonly opts: ExecOptions;
}

/** A tiny platform behind `adlc`: tenants, tokens, the login, the project and the AI record. */
class FakeAdlc {
  readonly calls: Call[] = [];
  readonly tokens: string[] = [];
  tenant = false;
  login: string | undefined;
  applied = false;
  /** The project file `apply` read last, while it still existed. */
  lastFile: Record<string, unknown> | undefined;
  lastFilePath = '';
  record: { version: number; ai_allowed: string; classes: string[] } | undefined;
  private serial = 0;

  readonly exec: Exec = (cmd, args, opts = {}) => {
    expect(cmd).toBe('node');
    expect(args[0]).toMatch(/platform\/apps\/cli\/dist\/main\.js$/);
    const call = { args: args.slice(1), opts };
    this.calls.push(call);
    return Promise.resolve(this.answer(call));
  };

  private token(): string {
    this.serial += 1;
    const t = `sdlc_pat_${String(this.serial).padStart(30, '0')}`;
    this.tokens.push(t);
    return t;
  }

  private answer({ args, opts }: Call): { status: number; stdout: string; stderr: string } {
    const ok = (body: unknown) => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
    const fail = (status: number) => ({ status, stdout: '', stderr: 'refused' });
    const has = (flag: string) => args.includes(flag);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    const [group, command, sub] = args;
    if (group === 'ops') {
      expect(has('--db-url-stdin')).toBe(true);
      expect(opts.input).toBe(`postgres://platform_app:${APP_DB}@127.0.0.1:5432/platform\n`);
      if (command === 'bootstrap') {
        if (this.tenant) return fail(1);
        this.tenant = true;
        return ok({ token: this.token() });
      }
      if (command === 'token' && sub === 'issue') return ok({ token: this.token() });
      if (command === 'ai-record' && sub === 'show') {
        if (!this.record) return fail(1);
        return ok({
          version: this.record.version,
          ai_allowed: this.record.ai_allowed,
          allowed_data_classes: this.record.classes,
          prod_logs_allowed: 'no',
          disclosure_format: 'standard_note',
        });
      }
      if (command === 'ai-record' && sub === 'set') {
        if (Number(value('--expected-version')) !== (this.record?.version ?? 0)) return fail(1);
        this.record = {
          version: (this.record?.version ?? 0) + 1,
          ai_allowed: value('--ai-allowed')!,
          classes: value('--classes')!.split(','),
        };
        return ok({ version: this.record.version });
      }
    }
    if (group === 'whoami') return this.login ? ok({}) : fail(4);
    if (group === 'login') {
      const given = (opts.input ?? '').trim();
      if (!has('--token-stdin') || !this.tokens.includes(given)) return fail(4);
      this.login = given;
      return ok({});
    }
    if (group === 'admin' && command === 'project' && sub === 'apply') {
      if (!this.login) return fail(4);
      this.lastFilePath = value('--file')!;
      this.lastFile = fs.existsSync(this.lastFilePath)
        ? (parseYaml(fs.readFileSync(this.lastFilePath, 'utf8')) as Record<string, unknown>)
        : undefined;
      const changes = this.applied ? [] : [{ kind: 'project_create' }, { kind: 'user_create' }];
      if (has('--yes')) this.applied = true;
      return ok({
        github: [
          { email: 'a@acme.test', login: 'acme-a', id: '7001' },
          { email: 'b@acme.test', login: 'acme-b', id: '7002' },
        ],
        changes,
        remaining: [
          {
            who: 'operator',
            key: 'cli.admin.apply.todo.token_issue',
            params: { email: 'a@acme.test' },
          },
          {
            who: 'a@acme.test',
            key: 'cli.admin.apply.todo.approve_owner',
            params: { key: 'coder' },
          },
          {
            who: 'b@acme.test',
            key: 'cli.admin.apply.todo.approve_person_b',
            params: { key: 'coder' },
          },
          {
            who: 'a@acme.test',
            key: 'cli.admin.apply.todo.ai_record',
            params: { project: 'pilot' },
          },
        ],
      });
    }
    return fail(2);
  }
}

type Event =
  | { kind: 'say' | 'pause'; key: MessageKey; params?: MessageParams }
  | { kind: 'secret'; text: string }
  | { kind: 'clear' }
  | { kind: 'print'; text: string };

class ScriptedTerminal implements Terminal {
  readonly events: Event[] = [];
  abortAt?: MessageKey;
  say(key: MessageKey, params?: MessageParams) {
    this.events.push({ kind: 'say', key, ...(params ? { params } : {}) });
  }
  warn(key: MessageKey, params?: MessageParams) {
    this.say(key, params);
  }
  print(text: string) {
    this.events.push({ kind: 'print', text });
  }
  hidden(): Promise<string> {
    return Promise.reject(new Error('no hidden prompt in steps 8–13'));
  }
  pause(key: MessageKey, params?: MessageParams): Promise<void> {
    this.events.push({ kind: 'pause', key, ...(params ? { params } : {}) });
    return key === this.abortAt ? Promise.reject(new PromptAborted()) : Promise.resolve();
  }
  showSecret(text: string) {
    this.events.push({ kind: 'secret', text });
  }
  clear() {
    this.events.push({ kind: 'clear' });
  }
  keys(): string[] {
    return this.events.flatMap((e) => ('key' in e ? [e.key] : []));
  }
}

const PROJECT_FILE = `format: 1
project:
  slug: pilot
  name: Pilot
  repository: acme/pilot
team:
  - email: a@acme.test
    name: Person A
    github_login: acme-a
    roles: [person_a]
  - email: b@acme.test
    name: Person B
    github_login: acme-b
    roles: [person_b]
agent:
  key: coder
  version: 1.0.0
  owner: a@acme.test
  model: claude-haiku-4-5-20251001
  instructions: AGENTS.md@v1
  instructions_file: AGENTS.md
  tools: [file_editor, terminal]
  max_autonomy: L2
  environments: [sandbox]
config:
  run:
    agent_key: coder
`;

function fixture(options: { projectFile?: string; aiRecord?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v19-'));
  temp.push(dir);
  const projectFile = path.join(dir, 'project.yaml');
  fs.writeFileSync(projectFile, options.projectFile ?? PROJECT_FILE);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agent\n');
  const team: TeamSettings = {
    tenant: { slug: 'acme', name: 'Acme' },
    admin: { email: 'admin@acme.test', name: 'Admin' },
    projectFile,
    sandboxImage: IMAGE,
    ...(options.aiRecord === false
      ? {}
      : {
          aiRecord: {
            aiAllowed: 'yes',
            classes: ['public', 'internal'],
            prodLogs: 'no',
            disclosure: 'standard_note',
          },
        }),
  };
  const adlc = new FakeAdlc();
  const done = new Set<string>();
  const steps: TeamStep[] = [];
  const bag = new SecretBag();
  const run = (term = new ScriptedTerminal()) => ({
    term,
    result: teamSteps({
      team,
      repoRoot: '/repo',
      exec: adlc.exec,
      terminal: term,
      bag,
      envText: `COMPOSE_PROJECT_NAME=x\nPLATFORM_APP_DB_PASSWORD=${APP_DB}\nPOSTGRES_HOST_PORT=5432\n`,
      apiUrl: 'http://127.0.0.1:8090',
      isDone: (m) => done.has(m),
      markDone: (m) => done.add(m),
      begin: (s) => steps.push(s),
      checkStop: () => undefined,
    }),
  });
  return { dir, team, adlc, done, steps, run, projectFile };
}

/** Every argument and environment value `adlc` got. */
const exposed = (a: FakeAdlc) =>
  a.calls.map((c) => [...c.args, ...Object.values(c.opts.env ?? {})].join('\u0000')).join('\n');

describe('V19 AC1, AC3: steps 8–13 in order', () => {
  it('the tenant, the project file after the GitHub IDs, the AI record, then what stays with people', async () => {
    const f = fixture();
    const { term, result } = f.run();
    await result;
    expect(f.steps).toEqual(['8', '9', '13']);
    expect([...f.done]).toEqual(['8', '9', '13']);
    const commands = f.adlc.calls.map((c) => c.args.slice(0, 3).join(' '));
    expect(commands).toEqual([
      'ops bootstrap --tenant',
      'login --api-url http://127.0.0.1:8090',
      'admin project apply',
      'admin project apply',
      'ops ai-record show',
      'ops ai-record set',
    ]);
    // The dry run, then the operator checks each GitHub ID, then the change.
    const applies = f.adlc.calls.filter((c) => c.args[0] === 'admin');
    expect(applies[0]!.args).toContain('--dry-run');
    expect(applies[1]!.args).toContain('--yes');
    const keys = term.keys();
    expect(keys.indexOf('server_setup.apply.github')).toBeLessThan(
      keys.indexOf('server_setup.apply.confirm'),
    );
    expect(
      term.events.filter((e) => e.kind === 'say' && e.key === 'server_setup.apply.github'),
    ).toHaveLength(2);
    // The AI record on behalf of Person A, from the settings.
    const set = f.adlc.calls.at(-1)!.args;
    expect(set).toEqual(
      expect.arrayContaining(['--on-behalf-of', 'a@acme.test', '--expected-version', '0']),
    );
    expect(set[set.indexOf('--classes') + 1]).toBe('public,internal');
    expect(f.adlc.record).toMatchObject({ version: 1, ai_allowed: 'yes' });
  });

  it('the project file of apply: the sandbox image by digest and the agent file by absolute path, removed afterwards', async () => {
    const f = fixture();
    await f.run().result;
    const derived = f.adlc.lastFile as {
      config: { sandbox: { image: string }; run: unknown };
      agent: { instructions_file: string };
    };
    expect(derived.config.sandbox.image).toBe(IMAGE);
    expect(derived.config.run).toEqual({ agent_key: 'coder' });
    expect(derived.agent.instructions_file).toBe(path.join(f.dir, 'AGENTS.md'));
    expect(fs.existsSync(f.adlc.lastFilePath)).toBe(false);
    expect(fs.readFileSync(f.projectFile, 'utf8')).toBe(PROJECT_FILE);
  });

  it('ends with the commands that stay with each person; the AI record is not among them', async () => {
    const f = fixture();
    const { term, result } = f.run();
    await result;
    const printed = term.events.flatMap((e) => (e.kind === 'print' ? [e.text] : [])).join('\n');
    expect(printed).toContain('adlc admin token issue --user a@acme.test');
    expect(printed).toContain('--as owner');
    expect(printed).toContain('--as person_b');
    expect(printed).not.toContain('adlc ai-record set');
    expect(term.keys().at(-1)).toBe('server_setup.team.first_intent');
  });
});

describe('V19 AC2: the token is shown once and never exposed', () => {
  it('shown between two clears, then given to adlc login on stdin', async () => {
    const f = fixture();
    const { term, result } = f.run();
    await result;
    const token = f.adlc.tokens[0]!;
    const at = term.events.findIndex((e) => e.kind === 'secret');
    expect(term.events.filter((e) => e.kind === 'secret')).toEqual([
      { kind: 'secret', text: token },
    ]);
    expect(term.events[at - 2]).toEqual({ kind: 'clear' });
    expect(term.events[at + 1]).toMatchObject({ kind: 'pause', key: 'server_setup.token.copied' });
    expect(term.events[at + 2]).toEqual({ kind: 'clear' });
    const login = f.adlc.calls.find((c) => c.args[0] === 'login')!;
    expect(login.opts.input).toBe(`${token}\n`);
    expect(f.adlc.login).toBe(token);
  });

  it('no token and no database URL in an argument or an environment value', async () => {
    const f = fixture();
    await f.run().result;
    const all = exposed(f.adlc);
    for (const secret of [...f.adlc.tokens, APP_DB, 'postgres://'])
      expect(all).not.toContain(secret);
  });

  it('never approves the agent, issues a team token or creates an intent', async () => {
    const f = fixture();
    await f.run().result;
    const all = f.adlc.calls.map((c) => c.args.join(' ')).join('\n');
    expect(all).not.toMatch(/agent approve|admin token issue|intent create|token create/);
  });
});

describe('V19 AC4: each step checks the state', () => {
  it('a second run changes nothing', async () => {
    const f = fixture();
    await f.run().result;
    const first = f.adlc.calls.length;
    const { term, result } = f.run();
    await result;
    const second = f.adlc.calls.slice(first).map((c) => c.args.slice(0, 3).join(' '));
    expect(second).toEqual(['whoami --json', 'admin project apply', 'ops ai-record show']);
    expect(term.events.some((e) => e.kind === 'secret')).toBe(false);
    expect(term.keys()).toContain('server_setup.apply.nothing');
    expect(term.keys()).not.toContain('server_setup.apply.confirm');
  });

  it('a tenant that exists, with the admin logged out: a new token for the admin', async () => {
    const f = fixture();
    await f.run().result;
    f.adlc.login = undefined;
    const first = f.adlc.calls.length;
    await f.run().result;
    const again = f.adlc.calls.slice(first).map((c) => c.args.slice(0, 3).join(' '));
    expect(again.slice(0, 4)).toEqual([
      'whoami --json',
      'ops bootstrap --tenant',
      'ops token issue',
      'login --api-url http://127.0.0.1:8090',
    ]);
    expect(f.adlc.login).toBe(f.adlc.tokens[1]);
  });

  it('a stop at the confirmation changes nothing in the project', async () => {
    const f = fixture();
    const term = new ScriptedTerminal();
    term.abortAt = 'server_setup.apply.confirm';
    await expect(f.run(term).result).rejects.toBeInstanceOf(PromptAborted);
    expect(f.adlc.applied).toBe(false);
    expect([...f.done]).toEqual(['8']);
  });

  it('without ai_record: Person A writes it, and the command says so', async () => {
    const f = fixture({ aiRecord: false });
    const { term, result } = f.run();
    await result;
    expect(f.adlc.calls.some((c) => c.args.includes('ai-record'))).toBe(false);
    expect(term.keys()).toContain('server_setup.ai_record.by_hand');
    const printed = term.events.flatMap((e) => (e.kind === 'print' ? [e.text] : [])).join('\n');
    expect(printed).toContain('adlc ai-record set --project pilot');
  });
});

describe('V19: refusals before a change', () => {
  it.each([
    [
      PROJECT_FILE.replace(
        'config:\n',
        `config:\n  sandbox:\n    image: other@sha256:${'b'.repeat(64)}\n`,
      ),
      'sandbox_image_conflict',
    ],
    [PROJECT_FILE.replace('roles: [person_a]', 'roles: [developer]'), 'no_person_a'],
    ['format: 1\nproject: [\n', 'project_file'],
  ])('refuses %#: %s', async (text, code) => {
    const f = fixture({ projectFile: text });
    const error = await f.run().result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamRefused);
    expect((error as TeamRefused).code).toBe(code);
    expect(f.adlc.tenant).toBe(false);
    expect(f.adlc.applied).toBe(false);
  });
});

describe('V19: the settings of steps 8–13', () => {
  const BASE = `key_holders: [{name: A}, {name: B}, {name: C}]
github_app: {client_id: Iv23test, private_key_file: /keys/app.pem}
model_providers: [{provider: anthropic}]
`;
  const TEAM = `tenant: {slug: acme, name: Acme}
admin: {email: admin@acme.test, name: Admin}
project_file: ~/project.yaml
sandbox_image: ${IMAGE}
`;
  const parse = (text: string) => parseSettings(text, '/home/op', 3);
  const field = (text: string) => {
    try {
      parse(text);
      return 'ok';
    } catch (error) {
      return error instanceof SettingsError ? error.field : String(error);
    }
  };

  it('reads the four keys and the AI record; none of them: no steps 8–13', () => {
    expect(parse(BASE).team).toBeUndefined();
    const s = parse(
      `${BASE}${TEAM}ai_record: {ai_allowed: yes, classes: [public, internal], prod_logs: no, disclosure: standard_note}\n`,
    );
    expect(s.team).toEqual({
      tenant: { slug: 'acme', name: 'Acme' },
      admin: { email: 'admin@acme.test', name: 'Admin' },
      projectFile: '/home/op/project.yaml',
      sandboxImage: IMAGE,
      aiRecord: {
        aiAllowed: 'yes',
        classes: ['public', 'internal'],
        prodLogs: 'no',
        disclosure: 'standard_note',
      },
    });
  });

  it.each([
    [`${BASE}tenant: {slug: acme, name: Acme}\n`, 'admin'],
    [
      `${BASE}${TEAM.replace(/sandbox_image: .*/, 'sandbox_image: ghcr.io/acme/sandbox:latest')}`,
      'sandbox_image',
    ],
    [`${BASE}${TEAM.replace('slug: acme', 'slug: Acme Corp')}`, 'tenant.slug'],
    [
      `${BASE}${TEAM.replace('project_file: ~/project.yaml', 'project_file: project.yaml')}`,
      'project_file',
    ],
    [
      `${BASE}${TEAM}ai_record: {ai_allowed: maybe, classes: [], prod_logs: no, disclosure: standard_note}\n`,
      'ai_record.ai_allowed',
    ],
    [
      `${BASE}${TEAM}ai_record: {ai_allowed: yes, classes: [secret], prod_logs: no, disclosure: standard_note}\n`,
      'ai_record.classes[0]',
    ],
    [
      `${BASE}ai_record: {ai_allowed: yes, classes: [], prod_logs: no, disclosure: standard_note}\n`,
      'ai_record',
    ],
  ])('refuses %#: field %s', (text, expected) => {
    expect(field(text)).toBe(expected);
  });

  it('the AI record codes are the platform codes', () => {
    expect([...AI_ALLOWED]).toEqual([...AI_ALLOWED_VALUES]);
    expect([...PROD_LOGS]).toEqual([...PROD_LOGS_ALLOWED_VALUES]);
    expect([...DISCLOSURES]).toEqual([...DISCLOSURE_FORMATS]);
    expect([...AI_RECORD_CLASSES]).toEqual([...DATA_CLASSES]);
  });
});
