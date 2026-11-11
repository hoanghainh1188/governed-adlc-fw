// Steps 8–13 of `pnpm server:setup` (D-08 V19, QUESTIONS #671; deploy README "Fresh deployment",
// steps 8–13). After step 7, with `tenant`, `admin`, `project_file` and `sandbox_image` in the
// settings:
// - step 8: the tenant and its first admin (`adlc ops bootstrap`, the database URL on stdin). The
//   token is shown once, with the screen and scroll-back cleared after the copy, then given to
//   `adlc login --token-stdin`;
// - steps 9–12: the project, its team, the agent and the configuration with the sandbox image by
//   digest, from the V17 project file (`adlc admin project apply`), after the operator checks the
//   GitHub IDs;
// - step 13: the project AI record from the settings, on behalf of Person A (`adlc ops ai-record
//   set`).
// It never approves the agent, never issues a team member's token and never creates an intent: it
// ends with the commands that stay with each person. No token or URL in a file, an argument, an
// environment variable or a log (R035, R143). Each step checks the state and skips what is done.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { t, type MessageKey } from '@sdlc/messages';
import { parse, stringify } from 'yaml';

import { databaseUrl } from '../../steps/dist/env-file.js';
import type { Exec, ExecResult } from '../../steps/dist/exec.js';
import { DeployStepError } from '../../steps/dist/fresh-deployment.js';
import type { SecretBag } from '../../steps/dist/secrets.js';

import type { TeamSettings } from './team-settings.js';
import type { Terminal } from './terminal.js';

export type TeamStep = '8' | '9' | '13';

/** A refusal of steps 8–13 before a change; `code` is a catalog suffix, never a value. */
export class TeamRefused extends Error {
  constructor(
    readonly code: 'project_file' | 'sandbox_image_conflict' | 'no_person_a',
    readonly params: Readonly<Record<string, string>> = {},
  ) {
    super(`server:setup refused: ${code}`);
  }
}

export interface TeamStepContext {
  readonly team: TeamSettings;
  readonly repoRoot: string;
  readonly exec: Exec;
  readonly terminal: Terminal;
  readonly bag: SecretBag;
  /** The env file's text: the `platform_app` URL comes from it. */
  readonly envText: string;
  /** The api on the server (`http://127.0.0.1:<SDLC_API_HOST_PORT>`). */
  readonly apiUrl: string;
  /** More environment for `adlc` (tests only: HOME, the GitHub API of a fake). */
  readonly cliEnv?: Readonly<Record<string, string>>;
  readonly isDone: (marker: string) => boolean;
  readonly markDone: (marker: string) => void;
  readonly begin: (step: TeamStep) => void;
  readonly checkStop: () => void;
}

interface ProjectFile {
  project: { slug: string };
  team: { email: string; roles: string[] }[];
  agent?: { instructions_file?: string; [key: string]: unknown };
  config?: { sandbox?: { image?: unknown; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
}

interface ApplyReport {
  readonly github: readonly { email: string; login: string; id: string }[];
  readonly changes: readonly unknown[];
  readonly remaining: readonly { who: string; key: MessageKey; params: Record<string, string> }[];
}

const AI_RECORD_TODO: MessageKey = 'cli.admin.apply.todo.ai_record';

export async function teamSteps(c: TeamStepContext): Promise<void> {
  const { team, terminal: term, bag } = c;
  const cli = path.join(c.repoRoot, 'platform/apps/cli/dist/main.js');
  const appUrl = bag.keep(databaseUrl(c.envText, 'platform_app'));
  const adlc = (args: readonly string[], input = ''): Promise<ExecResult> =>
    c.exec('node', [cli, ...args], { input, env: { ...c.cliEnv } });
  /** An operator command with the database URL on stdin, never in SDLC_DB_URL. */
  const ops = (args: readonly string[]) =>
    adlc(['ops', ...args, '--db-url-stdin', '--json'], `${appUrl}\n`);
  const fail = (label: string, r: ExecResult): never => {
    throw new DeployStepError(label, bag.redact(`${r.stderr}${r.stdout}`).trim());
  };

  const file = readProjectFile(team.projectFile);
  const personA = file.team.find((p) => p.roles.includes('person_a'))?.email;
  if (!personA) throw new TeamRefused('no_person_a', { path: team.projectFile });
  const project = file.project.slug;
  // Checked before any change: a project file that names another image is refused.
  const applyDoc = withImage(file, team);

  // Step 8: the tenant, its first admin, and the admin's login on this server.
  c.begin('8');
  const loggedIn = c.isDone('8') && (await adlc(['whoami', '--json'])).status === 0;
  if (!loggedIn) {
    const tenant = ['--tenant', team.tenant.slug];
    let issued = await ops([
      'bootstrap',
      ...tenant,
      '--tenant-name',
      team.tenant.name,
      '--email',
      team.admin.email,
      '--name',
      team.admin.name,
    ]);
    // Exit 1: the tenant exists (an earlier run, or the admin logged out): a new token for the
    // same admin instead.
    if (issued.status === 1) {
      issued = await ops([
        'token',
        'issue',
        ...tenant,
        '--email',
        team.admin.email,
        '--name',
        'server-setup',
      ]);
    }
    if (issued.status !== 0) fail('adlc ops bootstrap', issued);
    const token = bag.keep(String((JSON.parse(issued.stdout) as { token: unknown }).token));
    term.clear();
    term.say('server_setup.token.show', { email: team.admin.email });
    term.showSecret(token);
    await term.pause('server_setup.token.copied');
    term.clear();
    const login = await adlc(
      ['login', '--api-url', c.apiUrl, '--token-stdin', '--json'],
      `${token}\n`,
    );
    bag.drop(token);
    if (login.status !== 0) fail('adlc login', login);
    c.markDone('8');
  }
  term.say('server_setup.tenant.ready', { tenant: team.tenant.slug, email: team.admin.email });

  // Steps 9–12: the project file, with the sandbox image by digest in its configuration.
  c.begin('9');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-server-setup-'));
  let report: ApplyReport;
  try {
    const derived = path.join(folder, 'project.yaml');
    fs.writeFileSync(derived, stringify(applyDoc), { mode: 0o600 });
    const apply = async (...extra: string[]) => {
      const r = await adlc(['admin', 'project', 'apply', '--file', derived, '--json', ...extra]);
      if (r.status !== 0) fail('adlc admin project apply', r);
      return JSON.parse(r.stdout) as ApplyReport;
    };
    report = await apply('--dry-run');
    if (report.changes.length === 0) {
      term.say('server_setup.apply.nothing', { project });
    } else {
      // People are matched by the numeric GitHub ID only (R037): the operator checks each one.
      for (const person of report.github) term.say('server_setup.apply.github', person);
      term.say('server_setup.apply.changes', { project, count: report.changes.length });
      await term.pause('server_setup.apply.confirm');
      c.checkStop();
      report = await apply('--yes');
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  c.markDone('9');

  // Step 13: the project AI record, from the settings, on behalf of Person A (QUESTIONS #671).
  c.begin('13');
  let recordWritten = false;
  if (team.aiRecord) {
    const r = team.aiRecord;
    const shown = await ops([
      'ai-record',
      'show',
      '--tenant',
      team.tenant.slug,
      '--project',
      project,
    ]);
    const current =
      shown.status === 0
        ? (JSON.parse(shown.stdout) as {
            version: number;
            ai_allowed: string;
            allowed_data_classes: string[];
            prod_logs_allowed: string;
            disclosure_format: string;
          })
        : undefined;
    const same =
      current !== undefined &&
      current.ai_allowed === r.aiAllowed &&
      current.prod_logs_allowed === r.prodLogs &&
      current.disclosure_format === r.disclosure &&
      [...current.allowed_data_classes].sort().join(',') === [...r.classes].sort().join(',');
    if (!same) {
      const set = await ops([
        'ai-record',
        'set',
        '--tenant',
        team.tenant.slug,
        '--project',
        project,
        '--on-behalf-of',
        personA,
        '--expected-version',
        String(current?.version ?? 0),
        '--ai-allowed',
        r.aiAllowed,
        '--classes',
        r.classes.length > 0 ? r.classes.join(',') : 'none',
        '--prod-logs',
        r.prodLogs,
        '--disclosure',
        r.disclosure,
      ]);
      if (set.status !== 0) fail('adlc ops ai-record set', set);
    }
    recordWritten = true;
    term.say('server_setup.ai_record.done', { project, email: personA });
  } else {
    term.say('server_setup.ai_record.by_hand', { project });
  }
  c.markDone('13');

  // What stays with people: tokens, the agent's approvals, the AI record without settings, step 14.
  const todos = report.remaining.filter((todo) => !(recordWritten && todo.key === AI_RECORD_TODO));
  term.say('server_setup.team.left');
  for (const who of [...new Set(todos.map((todo) => todo.who))]) {
    term.print(
      who === 'operator'
        ? t('cli.admin.apply.todo.who_operator')
        : t('cli.admin.apply.todo.who', { email: who }),
    );
    for (const todo of todos.filter((item) => item.who === who))
      term.print(t(todo.key, todo.params));
  }
  term.say('server_setup.team.first_intent', { project, email: personA });
}

/** The project file, read to find Person A and to add the image; `adlc` checks it in full. */
function readProjectFile(file: string): ProjectFile {
  let doc: unknown;
  try {
    doc = parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new TeamRefused('project_file', { path: file });
  }
  const f = doc as Partial<ProjectFile> | null;
  if (
    !f ||
    typeof f.project?.slug !== 'string' ||
    !Array.isArray(f.team) ||
    !f.team.every((p) => typeof p?.email === 'string' && Array.isArray(p.roles))
  ) {
    throw new TeamRefused('project_file', { path: file });
  }
  return { ...(f as ProjectFile), dir: path.dirname(file) };
}

/**
 * The file `adlc admin project apply` reads: the project file with `sandbox.image` set (step 10)
 * and the agent's instructions file as an absolute path, since the copy is in another folder. A
 * project file that names another image is refused, never changed.
 */
function withImage(file: ProjectFile, team: TeamSettings): Record<string, unknown> {
  const { dir, ...rest } = file as ProjectFile & { dir: string };
  const image = rest.config?.sandbox?.image;
  if (image !== undefined && image !== team.sandboxImage) {
    throw new TeamRefused('sandbox_image_conflict', { path: team.projectFile });
  }
  const agent =
    rest.agent && typeof rest.agent.instructions_file === 'string'
      ? { ...rest.agent, instructions_file: path.resolve(dir, rest.agent.instructions_file) }
      : rest.agent;
  return {
    ...rest,
    ...(agent ? { agent } : {}),
    config: {
      ...rest.config,
      sandbox: { ...rest.config?.sandbox, image: team.sandboxImage },
    },
  };
}
