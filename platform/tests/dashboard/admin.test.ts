// U09 PR 2 (design/ADR-M73 §2.4b, MVP1-UI-SCOPE §3.4, QUESTIONS #683–#686): the dashboard's model
// of the administration screens, without a browser: the line difference of a configuration, the
// shape checks before a passkey prompt (the same patterns and roles as core), the refusals in the
// API's own catalog words, and the routes.
import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_ADAPTERS as CONTRACT_ADAPTERS,
  AGENT_KEY_PATTERN,
  AI_ALLOWED_VALUES,
  DATA_CLASSES as CONTRACT_DATA_CLASSES,
  DISCLOSURE_FORMATS as CONTRACT_DISCLOSURE,
  PROD_LOGS_ALLOWED_VALUES,
  PROJECT_ROLES as CONTRACT_ROLES,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_ERROR_CODES,
  adminErrorKey,
  AGENT_ADAPTERS,
  AGENT_KEY,
  AGENT_STATUS_REASONS,
  agentChanges,
  AI_ALLOWED,
  checkAgent,
  checkAiRecord,
  checkApproval,
  checkHoldLink,
  codeList,
  DATA_CLASSES,
  DISCLOSURE_FORMATS,
  PROD_LOGS_ALLOWED,
  checkIdentity,
  checkProject,
  checkRole,
  checkUser,
  diffCounts,
  EXTERNAL_ID,
  EXTERNAL_LOGIN,
  lineDiff,
  PROJECT_ROLES,
  PROJECT_SLUG,
  projectChanges,
  REPO_FULL_NAME,
} from '../../apps/dashboard/src/model/admin.js';
import {
  adminAgentHref,
  adminHoldHref,
  adminProjectHref,
  adminUserHref,
  parseRoute,
} from '../../apps/dashboard/src/model/route.js';
import { AGENT_STATUS_REASONS as CORE_REASONS } from '../../packages/core/src/agents/rules.js';
import {
  EXTERNAL_ID_PATTERN,
  EXTERNAL_LOGIN_PATTERN,
  PROJECT_SLUG_PATTERN,
  REPO_FULL_NAME_PATTERN,
} from '../../packages/core/src/admin/validation.js';
import { repoRoot } from '../workspace/helpers';

const en = JSON.parse(
  fs.readFileSync(path.join(repoRoot(), 'platform/packages/messages/src/locales/en.json'), 'utf8'),
) as Record<string, string>;
const ID = '0b5c1e9e-1a7e-4c4f-9a65-5d1f1c2b3a4d';

describe('U09: the line difference of a configuration (QUESTIONS #683)', () => {
  it('keeps every unchanged line once and marks removed and added lines', () => {
    const before = 'a: 1\nb: 2\nc: 3\n';
    const after = 'a: 1\nb: 20\nc: 3\nd: 4\n';
    expect(lineDiff(before, after)).toEqual([
      { kind: 'same', text: 'a: 1' },
      { kind: 'removed', text: 'b: 2' },
      { kind: 'added', text: 'b: 20' },
      { kind: 'same', text: 'c: 3' },
      { kind: 'added', text: 'd: 4' },
    ]);
    expect(diffCounts(lineDiff(before, after)!)).toEqual({ removed: 1, added: 2 });
  });

  it('an empty stored version: every line is added; the same text: nothing changes', () => {
    expect(lineDiff('', 'x: 1\ny: 2')).toEqual([
      { kind: 'added', text: 'x: 1' },
      { kind: 'added', text: 'y: 2' },
    ]);
    const same = lineDiff('x: 1\r\ny: 2\n', 'x: 1\ny: 2');
    expect(same!.every((line) => line.kind === 'same')).toBe(true);
  });

  it('a moved block shows as removed and added, never lost', () => {
    const diff = lineDiff('a\nb\nc\nd', 'c\nd\na\nb')!;
    const kept = diff.filter((d) => d.kind !== 'removed').map((d) => d.text);
    const old = diff.filter((d) => d.kind !== 'added').map((d) => d.text);
    expect(kept).toEqual(['c', 'd', 'a', 'b']);
    expect(old).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not compare files that are too large', () => {
    const big = Array.from({ length: 4001 }, (_, i) => `k${i}: ${i}`).join('\n');
    expect(lineDiff('', big)).toBeNull();
    const half = (seed: string) => Array.from({ length: 2000 }, (_, i) => `${seed}${i}`).join('\n');
    expect(lineDiff(half('a'), half('b'))).toBeNull();
  });
});

describe('U09: the shape checks match core (R037, R088)', () => {
  it('uses the same patterns and project roles as the platform', () => {
    expect(PROJECT_SLUG.source).toBe(PROJECT_SLUG_PATTERN.source);
    expect(REPO_FULL_NAME.source).toBe(REPO_FULL_NAME_PATTERN.source);
    expect(EXTERNAL_ID.source).toBe(EXTERNAL_ID_PATTERN.source);
    expect(EXTERNAL_LOGIN.source).toBe(EXTERNAL_LOGIN_PATTERN.source);
    expect([...PROJECT_ROLES]).toEqual([...CONTRACT_ROLES]);
  });

  it('a project: slug, name, owner/repository; an optional folder and branch', () => {
    const form = { slug: 'shop', name: ' Shop ', repo: 'acme/shop', folder: '', branch: '' };
    expect(checkProject(form)).toEqual({
      body: { slug: 'shop', name: 'Shop', repo_full_name: 'acme/shop' },
    });
    expect(checkProject({ ...form, folder: 'packages/api', branch: 'trunk' })).toEqual({
      body: {
        slug: 'shop',
        name: 'Shop',
        repo_full_name: 'acme/shop',
        repo_path: 'packages/api',
        default_branch: 'trunk',
      },
    });
    expect(checkProject({ ...form, slug: 'Shop' })).toEqual({
      error: 'dashboard.admin.error.slug',
    });
    expect(checkProject({ ...form, name: ' ' })).toEqual({ error: 'dashboard.admin.error.name' });
    expect(checkProject({ ...form, repo: 'shop' })).toEqual({
      error: 'dashboard.admin.error.repo',
    });
  });

  it('a project change sends only the changed fields; an empty folder clears it', () => {
    const before = {
      name: 'Shop',
      repo_full_name: 'acme/shop',
      repo_path: 'apps/web',
      default_branch: 'main',
    };
    const same = { name: 'Shop', repo: 'acme/shop', folder: 'apps/web', branch: 'main' };
    expect(projectChanges(before, same)).toBeNull();
    expect(projectChanges(before, { ...same, name: 'Shop 2', folder: '' })).toEqual({
      body: { name: 'Shop 2', repo_path: '' },
    });
    expect(projectChanges(before, { ...same, branch: '' })).toEqual({
      error: 'dashboard.admin.error.branch',
    });
  });

  it('a person, a GitHub account by its numeric ID only, a role', () => {
    expect(checkUser({ email: ' a@x.example ', name: 'A' })).toEqual({
      body: { email: 'a@x.example', display_name: 'A' },
    });
    expect(checkUser({ email: 'not-an-address', name: 'A' })).toEqual({
      error: 'dashboard.admin.error.email',
    });
    expect(checkIdentity({ id: '583231', login: 'octocat' })).toEqual({
      body: { external_id: '583231', external_login: 'octocat' },
    });
    // The login is never the account ID (R037).
    expect(checkIdentity({ id: 'octocat', login: 'octocat' })).toEqual({
      error: 'dashboard.admin.error.account_id',
    });
    expect(checkRole({ user: ID, role: 'person_b' })).toEqual({
      body: { user_id: ID, role: 'person_b' },
    });
    expect(checkRole({ user: ID, role: 'owner' })).toEqual({ error: 'dashboard.admin.error.role' });
    expect(checkRole({ user: 'ann', role: 'viewer' })).toEqual({
      error: 'dashboard.admin.error.user',
    });
  });
});

describe('U09: refusals in the API’s own words (AC1)', () => {
  it('every admin refusal code has its api.error sentence in the catalog', () => {
    for (const code of ADMIN_ERROR_CODES) {
      const key = adminErrorKey(code);
      expect(key, code).toBe(`api.error.${code}`);
      expect(en[key!], code).toBeTruthy();
    }
    expect(adminErrorKey('self_action')).toBe('api.error.self_action');
    expect(adminErrorKey('conflicting_role')).toBe('api.error.conflicting_role');
    expect(adminErrorKey('step_up_refused')).toBeNull();
  });

  it('the admin messages load with the admin chunk (QUESTIONS #686)', () => {
    const admin = Object.keys(en).filter((k) => k.startsWith('dashboard.admin.'));
    expect(admin.length).toBeGreaterThan(100);
    expect(en['dashboard.nav.admin']).toBeTruthy();
  });
});

describe('U09: routes', () => {
  it('parses the overview, a project, its configuration and a person', () => {
    expect(parseRoute('#/admin').name).toBe('admin');
    expect(parseRoute('#/admin/projects/shop')).toMatchObject({
      name: 'admin-project',
      slug: 'shop',
    });
    expect(parseRoute('#/admin/projects/shop/config')).toMatchObject({
      name: 'admin-config',
      slug: 'shop',
    });
    expect(parseRoute(`#/admin/users/${ID}`)).toMatchObject({ name: 'admin-user', id: ID });
    // Anything else falls back to the overview.
    expect(parseRoute('#/admin/projects/Bad Slug').name).toBe('admin');
    expect(parseRoute('#/admin/users/ann').name).toBe('admin');
    expect(adminProjectHref('shop', true)).toBe('#/admin/projects/shop/config');
    expect(adminProjectHref('../x')).toBe('#/admin');
    expect(adminUserHref(ID)).toBe(`#/admin/users/${ID}`);
    expect(adminUserHref('x')).toBe('#/admin');
  });
});

describe('U09 PR 3: the agent register, the AI record, evidence holds', () => {
  const HASH = 'a'.repeat(64);
  const form = {
    key: 'openhands-qwen',
    version: '1',
    owner: ID,
    model: '',
    instructionsRef: 'AGENTS.md@v1',
    instructionsSha256: HASH,
    tools: 'git, tests  git',
    autonomy: 'L1',
    environments: ['sandbox'],
    adapter: '',
  };

  it('uses the same codes as the platform', () => {
    expect(AGENT_KEY.source).toBe(AGENT_KEY_PATTERN.source);
    expect([...AGENT_ADAPTERS]).toEqual([...CONTRACT_ADAPTERS]);
    expect([...AGENT_STATUS_REASONS]).toEqual([...CORE_REASONS]);
    expect([...AI_ALLOWED]).toEqual([...AI_ALLOWED_VALUES]);
    expect([...PROD_LOGS_ALLOWED]).toEqual([...PROD_LOGS_ALLOWED_VALUES]);
    expect([...DISCLOSURE_FORMATS]).toEqual([...CONTRACT_DISCLOSURE]);
    expect([...DATA_CLASSES]).toEqual([...CONTRACT_DATA_CLASSES]);
  });

  it('a new agent: the fields of adlc admin agent register; the file is pinned by its hash', () => {
    expect(codeList('git, tests  git')).toEqual(['git', 'tests']);
    expect(checkAgent(form)).toEqual({
      body: {
        key: 'openhands-qwen',
        version: '1',
        owner_id: ID,
        instructions_ref: 'AGENTS.md@v1',
        instructions_sha256: HASH,
        allowed_tools: ['git', 'tests'],
        max_autonomy: 'L1',
        approved_environments: ['sandbox'],
      },
    });
    expect(checkAgent({ ...form, key: 'Bad' })).toEqual({
      error: 'dashboard.admin.error.agent_key',
    });
    expect(checkAgent({ ...form, instructionsSha256: '' })).toEqual({
      error: 'dashboard.admin.error.instructions_file',
    });
    expect(checkAgent({ ...form, autonomy: 'L3' })).toEqual({
      error: 'dashboard.admin.error.autonomy',
    });
    expect(checkAgent({ ...form, environments: [] })).toEqual({
      error: 'dashboard.admin.error.environments',
    });
  });

  it('a new version sends the version and what changed; a new file needs its hash', () => {
    const before = {
      model_ref: null,
      instructions_ref: 'AGENTS.md@v1',
      allowed_tools: ['git', 'tests'],
      max_autonomy: 'L1',
      approved_environments: ['sandbox'],
    };
    const same = { ...form, version: '2', instructionsSha256: '' };
    expect(agentChanges(before, same)).toBeNull();
    expect(agentChanges(before, { ...same, autonomy: 'L2', model: 'qwen' })).toEqual({
      body: { version: '2', model_ref: 'qwen', max_autonomy: 'L2' },
    });
    expect(agentChanges(before, { ...same, instructionsRef: 'AGENTS.md@v2' })).toEqual({
      error: 'dashboard.admin.error.instructions_file',
    });
    expect(
      agentChanges(before, { ...same, instructionsRef: 'AGENTS.md@v2', instructionsSha256: HASH }),
    ).toEqual({
      body: { version: '2', instructions_ref: 'AGENTS.md@v2', instructions_sha256: HASH },
    });
  });

  it('an approval names its round, its capacity and maybe an evaluation', () => {
    expect(checkApproval({ purpose: 'activate', capacity: 'person_b', evaluation: '' })).toEqual({
      body: { purpose: 'activate', as: 'person_b' },
    });
    expect(
      checkApproval({ purpose: 'activate', capacity: 'owner', evaluation: 'EVAL-2026-0001' }),
    ).toEqual({ body: { purpose: 'activate', as: 'owner', evaluation_code: 'EVAL-2026-0001' } });
    expect(checkApproval({ purpose: 'activate', capacity: 'admin', evaluation: '' })).toEqual({
      error: 'dashboard.admin.error.capacity',
    });
    expect(checkApproval({ purpose: 'run', capacity: 'owner', evaluation: '' })).toEqual({
      error: 'dashboard.admin.error.purpose',
    });
  });

  it('the AI record: codes, a date and one https link, never text', () => {
    const record = {
      aiAllowed: 'yes',
      classes: ['client_restricted', 'internal'],
      prodLogs: 'no',
      disclosure: 'standard_note',
      confirmedAt: '',
      recordRef: '',
    };
    expect(checkAiRecord(2, record)).toEqual({
      body: {
        expected_version: 2,
        ai_allowed: 'yes',
        allowed_data_classes: ['internal', 'client_restricted'],
        prod_logs_allowed: 'no',
        disclosure_format: 'standard_note',
        confirmed_at: null,
        record_ref: null,
      },
    });
    expect(checkAiRecord(0, { ...record, recordRef: 'http://x' })).toEqual({
      error: 'dashboard.admin.error.link',
    });
    expect(checkAiRecord(0, { ...record, confirmedAt: '12/11/2026' })).toEqual({
      error: 'dashboard.admin.error.date',
    });
    expect(checkHoldLink('')).toEqual({ body: {} });
    expect(checkHoldLink(' https://tickets.example/1 ')).toEqual({
      body: { reason_ref: 'https://tickets.example/1' },
    });
    expect(checkHoldLink('a lawsuit')).toEqual({ error: 'dashboard.admin.error.link' });
  });

  it('routes of the agent register and of the evidence holds', () => {
    expect(parseRoute('#/admin/agents').name).toBe('admin-agents');
    expect(parseRoute('#/admin/agents/openhands-qwen')).toMatchObject({
      name: 'admin-agent',
      key: 'openhands-qwen',
    });
    expect(parseRoute('#/admin/holds/INT-2026-0001')).toMatchObject({
      name: 'admin-hold',
      code: 'INT-2026-0001',
    });
    expect(parseRoute('#/admin/holds/x').name).toBe('admin');
    expect(adminAgentHref('Bad Key')).toBe('#/admin/agents');
    expect(adminHoldHref('INT-2026-0001')).toBe('#/admin/holds/INT-2026-0001');
  });
});
