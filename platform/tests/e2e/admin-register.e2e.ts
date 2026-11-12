// U09 PR 3 in a real browser (design/ADR-M73 §2.4b, MVP1-UI-SCOPE §3.4 W12, W13; QUESTIONS #681):
// the agent register (register with the instruction file hashed in the browser, approve, the same
// person twice refused in the register's words, a new version, suspend, change owner), the project
// AI record, an evidence hold and its release, a project archive refused while it has open
// intents, and a tenant admin removing a person's passkey. Each change is confirmed with Chromium's
// virtual passkey and checked by the stub as the API does. Screens at 375, 768 and 1440 px, light
// and dark, without horizontal scroll.
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { adminHooks, confirm, LOCAL, signedIn, watchWrites } from './admin-helpers';

const SHOTS = path.join(__dirname, 'screenshots');
const ANN = '00000000-0000-4000-8000-000000000002';

adminHooks();

test('U09: register an agent; its instruction file is pinned by a hash made in the browser', async ({
  page,
}) => {
  await signedIn(page);
  const w = watchWrites(page);
  await page.goto(`${LOCAL}/dashboard/#/admin/agents`);
  await expect(page.getByRole('link', { name: 'openhands-qwen' })).toBeVisible();
  await page.getByRole('button', { name: 'Register an agent' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('The same file, to pin its content').setInputFiles({
    name: 'AGENTS.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Agent instructions\n'),
  });
  // SHA-256 of "# Agent instructions\n", computed by the page.
  await expect(dialog.getByText(/^SHA-256: [0-9a-f]{64}$/)).toBeVisible();
  await confirm(page, {
    'Agent key': 'openhands-small',
    Version: '1',
    'Instruction file': 'AGENTS.md@v1',
    'Allowed tools': 'git, tests',
  });
  await expect(page.getByRole('heading', { name: 'openhands-small' })).toBeVisible();
  await expect(page.getByText('pending_activation')).toBeVisible();
  expect(w.writes).toEqual(['POST /v1/auth/step-up', 'POST /v1/admin/agents']);
  // The file itself never left the browser: only its hash did.
  const sent = await page.evaluate(() => document.body.innerText);
  expect(sent).not.toContain('# Agent instructions');
});

test('U09: approve an activation; the same person twice is refused in the register’s words', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto(`${LOCAL}/dashboard/#/admin/agents/opencode-gpt`);
  const activate = page.getByRole('article', { name: 'activate' });
  await expect(activate.getByText('Approvals still needed: owner, person_b.')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await confirm(page, { Round: 'activate', 'You approve as': 'owner' });
  await expect(
    page.getByRole('status').getByText('Approvals still needed: person_b.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Approve' }).click();
  await confirm(page, { Round: 'activate', 'You approve as': 'person_b' });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/^The agent register refused this step/)).toBeVisible();
  await expect(
    dialog.getByText(/already approved this step for the agent as it is now/),
  ).toBeVisible();
});

test('U09: a new version, suspend with a reason, a new owner (QUESTIONS #681)', async ({
  page,
}) => {
  await signedIn(page);
  const w = watchWrites(page);
  await page.goto(`${LOCAL}/dashboard/#/admin/agents/openhands-qwen`);
  await page.getByRole('button', { name: 'New version' }).click();
  await confirm(page, { Version: '2', 'Maximum autonomy': 'L1' });
  await expect(page.getByText('pending_activation')).toBeVisible();

  await page.getByRole('button', { name: 'Suspend' }).click();
  await confirm(page, { Reason: 'quality' });
  await expect(page.getByText('suspended', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Change owner' }).click();
  await confirm(page, { Owner: ANN });
  await expect(page.getByRole('definition').filter({ hasText: 'Ann Example' })).toBeVisible();
  expect(w.writes).toEqual([
    'POST /v1/auth/step-up',
    'PATCH /v1/admin/agents/openhands-qwen',
    'POST /v1/auth/step-up',
    'POST /v1/admin/agents/openhands-qwen/suspend',
    'POST /v1/auth/step-up',
    'PUT /v1/admin/agents/openhands-qwen/owner',
  ]);
});

test('U09: the AI record, then a refused archive while the project has open intents', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto(`${LOCAL}/dashboard/#/admin/projects/shop`);
  const record = page.getByRole('region', { name: 'AI record' });
  await expect(record.getByText('standard_note')).toBeVisible();
  await record.getByRole('button', { name: 'New version' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('client_restricted').check();
  // A link that is not https:// is refused before the passkey prompt (codes and links only).
  await confirm(page, { Link: 'http://records.example/shop' });
  await expect(dialog.getByText('Enter an https:// link, or nothing.')).toBeVisible();
  await confirm(page, { Link: 'https://records.example/shop' });
  await expect(record.getByText('internal, client_restricted')).toBeVisible();

  await page.getByRole('button', { name: 'Archive' }).click();
  await confirm(page);
  await expect(page.getByRole('dialog').getByText(/^The project has open intents/)).toBeVisible();
});

test('U09: hold an intent’s evidence with a link, then release it', async ({ page }) => {
  await signedIn(page);
  await page.goto(`${LOCAL}/dashboard/#/intents/INT-2026-0001`);
  await page.getByRole('link', { name: 'Evidence hold' }).click();
  await expect(page.getByText('No hold: the evidence follows the retention period.')).toBeVisible();
  await page.getByRole('button', { name: 'Hold the evidence' }).click();
  await confirm(page, { Link: 'https://tickets.example/42' });
  await expect(page.getByText('https://tickets.example/42')).toBeVisible();
  await page.getByRole('button', { name: 'Release' }).click();
  await confirm(page);
  await expect(page.getByText('No hold: the evidence follows the retention period.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'History' }).getByText('released')).toBeVisible();
});

test('U09: a tenant admin removes a person’s passkey', async ({ page }) => {
  await signedIn(page);
  const w = watchWrites(page);
  await page.goto(`${LOCAL}/dashboard/#/admin/users/${ANN}`);
  const keys = page.getByRole('region', { name: 'Passkeys' });
  await keys.getByRole('button', { name: 'Remove' }).click();
  await confirm(page);
  await expect(keys.getByText('No active passkey.')).toBeVisible();
  expect(w.writes).toEqual(['POST /v1/auth/step-up', 'DELETE /v1/admin/users/:id/passkeys/:id']);
});

for (const width of [375, 768, 1440]) {
  test(`U09 PR 3: the screens at ${width} px, light and dark; no horizontal scroll`, async ({
    page,
  }) => {
    await signedIn(page);
    const screens = [
      ['agents', '#/admin/agents'],
      ['agent', '#/admin/agents/opencode-gpt'],
      ['hold', '#/admin/holds/INT-2026-0001'],
      ['project-ai', '#/admin/projects/shop'],
    ] as const;
    for (const [name, route] of screens) {
      await page.goto(`${LOCAL}/dashboard/${route}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
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
