// U09 PR 2 in a real browser (design/ADR-M73 §2.4b, MVP1-UI-SCOPE §3.4, QUESTIONS #681–#686): a
// tenant admin with a GitHub session creates and changes a project, gives and revokes a role,
// uploads a configuration after seeing its difference to the stored version, adds a person, links
// a GitHub account by its numeric ID, disables and enables the person, signs them out everywhere,
// and makes and removes a tenant admin. Each change is confirmed with Chromium's virtual passkey;
// the stub checks the step-up with the api's own WebAuthn code and the request SHA-256 of the body,
// the change and the path. A self-grant and Person A = Person B are refused in the API's words
// (M21). A person signed in with a token reads and changes nothing. The admin screens load as a
// chunk of their own. Screens at 375, 768 and 1440 px, light and dark, without horizontal scroll.
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { adminHooks, confirm, LOCAL, signedIn, watchWrites } from './admin-helpers';

const SHOTS = path.join(__dirname, 'screenshots');
const ANN = '00000000-0000-4000-8000-000000000002';

adminHooks();

test('U09: a project: create, change, give a role and revoke it, each with a passkey', async ({
  page,
}) => {
  await signedIn(page);
  const w = watchWrites(page);
  await page.goto(`${LOCAL}/dashboard/#/admin`);
  await expect(page.getByRole('heading', { name: 'Projects and people' })).toBeVisible();
  // The admin screens are a chunk of their own (QUESTIONS #686).
  expect(w.scripts.some((s) => s.startsWith('admin-screens-'))).toBe(true);

  await page.getByRole('button', { name: 'New project' }).click();
  await confirm(page, {
    'Project slug': 'web',
    Name: 'Web shop',
    Repository: 'acme/web',
    Folder: 'apps/web',
  });
  await expect(page.getByRole('heading', { name: 'web', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Change details' }).click();
  await confirm(page, { Name: 'Web shop 2' });
  await expect(page.getByText('Web shop 2')).toBeVisible();

  await page.getByRole('button', { name: 'Give a role' }).click();
  await confirm(page, { Person: ANN, Role: 'person_a' });
  const row = page.getByRole('row', { name: /Ann Example/ });
  await expect(row.getByText('person_a')).toBeVisible();
  await row.getByRole('button', { name: 'Revoke' }).click();
  await confirm(page);
  await expect(page.getByRole('row', { name: /Ann Example/ })).toHaveCount(0);

  expect(w.writes).toEqual([
    'POST /v1/auth/step-up',
    'POST /v1/admin/projects',
    'POST /v1/auth/step-up',
    'PATCH /v1/admin/projects/web',
    'POST /v1/auth/step-up',
    'POST /v1/admin/projects/web/roles',
    'POST /v1/auth/step-up',
    'DELETE /v1/admin/projects/web/roles/:id',
  ]);
});

test('U09 (AC1, M21): a self-grant and Person A = Person B are refused in the API’s words', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto(`${LOCAL}/dashboard/#/admin/projects/shop`);
  await page.getByRole('button', { name: 'Give a role' }).click();
  await confirm(page, { Person: '00000000-0000-4000-8000-000000000001', Role: 'viewer' });
  await expect(
    page
      .getByRole('dialog')
      .getByText(/^Nobody grants a role to themselves or disables themselves/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Ann is Person A on `pilot`: Person B there conflicts.
  await page.goto(`${LOCAL}/dashboard/#/admin/projects/pilot`);
  await page.getByRole('button', { name: 'Give a role' }).click();
  await confirm(page, { Person: ANN, Role: 'person_b' });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/conflicts with this one on the project/)).toBeVisible();
  await expect(dialog.getByText(/The conflicting role: person_a\./)).toBeVisible();
});

test('U09: a configuration: the difference first, then a save; a refused file in the API’s words', async ({
  page,
}) => {
  await signedIn(page);
  const w = watchWrites(page);
  await page.goto(`${LOCAL}/dashboard/#/admin/projects/shop/config`);
  await expect(page.getByText('Version 1.')).toBeVisible();
  const file = page.getByLabel('Configuration file (YAML)');

  await file.setInputFiles({
    name: 'shop.yaml',
    mimeType: 'text/yaml',
    buffer: Buffer.from('oversight:\n  matrix: {}\naccess:\n  conflicting_roles: []\n'),
  });
  const diff = page.getByRole('region', { name: 'Line difference' });
  await expect(page.getByText('Lines removed: 0. Lines added: 2.')).toBeVisible();
  await expect(diff.getByText('conflicting_roles: []')).toBeVisible();
  // Nothing is sent before the save.
  expect(w.writes).toEqual([]);
  await page.getByRole('button', { name: 'Save this version' }).click();
  await confirm(page);
  await expect(page.getByText('Saved as version 2.')).toBeVisible();
  await expect(page.getByText(/access.conflicting_roles is empty/)).toBeVisible();
  expect(w.writes).toEqual(['POST /v1/auth/step-up', 'PUT /v1/admin/projects/shop/config']);

  await file.setInputFiles({
    name: 'bad.yaml',
    mimeType: 'text/yaml',
    buffer: Buffer.from('unknown_section: 1\n'),
  });
  await page.getByRole('button', { name: 'Save this version' }).click();
  await confirm(page);
  await expect(
    page.getByRole('dialog').getByText(/unknown_section is not a configuration key\./),
  ).toBeVisible();
});

test('U09: a person: add, link a GitHub account by its numeric ID, disable, enable, sign out', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto(`${LOCAL}/dashboard/#/admin`);
  await page.getByRole('button', { name: 'Add a person' }).click();
  await confirm(page, { Name: 'Cara Example', 'E-mail address': 'cara@example.invalid' });
  await expect(page.getByRole('heading', { name: 'Cara Example' })).toBeVisible();

  await page.getByRole('button', { name: 'Link a GitHub account' }).click();
  // A login in place of the numeric ID is refused before any passkey prompt (R037).
  await confirm(page, { 'GitHub account ID (a number)': 'cara', 'GitHub login': 'cara' });
  await expect(page.getByRole('dialog').getByText(/numeric GitHub account ID/)).toBeVisible();
  await confirm(page, { 'GitHub account ID (a number)': '424242' });
  await expect(page.getByRole('row', { name: /424242/ })).toBeVisible();

  await page.getByRole('button', { name: 'Disable' }).click();
  await confirm(page);
  await expect(page.getByText('disabled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enable' }).click();
  await confirm(page);
  await page.getByRole('button', { name: 'Sign out everywhere' }).last().click();
  await confirm(page);
  await expect(page.getByRole('status').getByText('Sessions ended: 2.')).toBeVisible();
});

test('U09: tenant admins: make Bob one, then remove him', async ({ page }) => {
  await signedIn(page);
  await page.goto(`${LOCAL}/dashboard/#/admin`);
  const section = page.getByRole('region', { name: 'Tenant admins' });
  await section.getByRole('button', { name: 'Make a tenant admin' }).click();
  await confirm(page, { Person: '00000000-0000-4000-8000-000000000003' });
  await expect(section.getByRole('link', { name: 'Bob Example' })).toBeVisible();
  await section
    .getByRole('listitem')
    .filter({ hasText: 'Bob Example' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await confirm(page);
  await expect(section.getByRole('link', { name: 'Bob Example' })).toHaveCount(0);
});

test('U09: signed in with a token: the screens read, nothing changes', async ({ page }) => {
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Personal API token').fill(process.env.SDLC_DASHBOARD_E2E_TOKEN!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  await page.goto(`${LOCAL}/dashboard/#/admin`);
  await expect(page.getByRole('link', { name: 'shop' })).toBeVisible();
  await expect(page.getByText(/To make changes, sign in with GitHub/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(0);
  await page.goto(`${LOCAL}/dashboard/#/admin/projects/shop/config`);
  await expect(page.getByText('Version 1.')).toBeVisible();
  await expect(page.getByLabel('Configuration file (YAML)')).toHaveCount(0);
});

for (const width of [375, 768, 1440]) {
  test(`U09: the admin screens at ${width} px, light and dark; no horizontal scroll`, async ({
    page,
  }) => {
    await signedIn(page);
    const screens = [
      ['overview', '#/admin'],
      ['project', '#/admin/projects/pilot'],
      ['config', '#/admin/projects/shop/config'],
      ['person', `#/admin/users/${ANN}`],
    ] as const;
    for (const [name, route] of screens) {
      await page.goto(`${LOCAL}/dashboard/${route}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (name === 'config') {
        await page.getByLabel('Configuration file (YAML)').setInputFiles({
          name: 'shop.yaml',
          mimeType: 'text/yaml',
          buffer: Buffer.from('oversight:\n  matrix:\n    G2: {}\nverification: {}\n'),
        });
        await expect(page.getByRole('region', { name: 'Line difference' })).toBeVisible();
      }
      for (const scheme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${name} ${scheme}`).toBeLessThanOrEqual(0);
        await page.screenshot({
          path: path.join(SHOTS, `${width}-${scheme}-u09-${name}.png`),
          fullPage: true,
        });
      }
    }
  });
}
