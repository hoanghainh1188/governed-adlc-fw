// Helpers of the U09 admin tests (not a test file): the GitHub sign-in with Chromium's virtual
// passkey, the stub's reset before each test, the writes a page sends, and a dialog's confirm.
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const PORT = Number(process.env.SDLC_DASHBOARD_E2E_PORT);
export const LOCAL = `http://localhost:${PORT}`;

/** Chromium only (the virtual authenticator), the stub's tenant reset, the passkey removed after. */
export function adminHooks(): void {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'the virtual authenticator is Chromium’s',
  );
  test.beforeEach(async ({ request }) => {
    const reset = await request.post(`${LOCAL}/v1/__stub/admin-reset`);
    expect(reset.status()).toBe(204);
  });
  test.afterEach(async ({ page }) => {
    if (!added) return;
    added = false;
    await page.goto(`${LOCAL}/dashboard/#/passkeys`);
    await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
    await page.getByRole('button', { name: 'Remove this passkey' }).click();
    await expect(page.getByRole('status')).toHaveText('Passkey removed.');
  });
}

async function virtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

let added = false;

export async function signedIn(page: Page): Promise<void> {
  await virtualAuthenticator(page);
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Tenant').fill('demo');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  await page.goto(`${LOCAL}/dashboard/#/passkeys`);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('status')).toHaveText('Passkey added.');
  added = true;
}

export function watchWrites(page: Page): { writes: string[]; scripts: string[] } {
  const w = { writes: [] as string[], scripts: [] as string[] };
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (req.method() !== 'GET' && url.pathname.startsWith('/v1/')) {
      w.writes.push(`${req.method()} ${url.pathname.replace(/[0-9a-f-]{36}/g, ':id')}`);
    }
    if (url.pathname.endsWith('.js')) w.scripts.push(path.basename(url.pathname));
  });
  return w;
}

/** Fills a dialog's fields by label and confirms with the passkey. */
export async function confirm(page: Page, fields: Record<string, string> = {}): Promise<void> {
  const dialog = page.getByRole('dialog');
  for (const [label, value] of Object.entries(fields)) {
    const field = dialog.getByLabel(label, { exact: true });
    if ((await field.evaluate((el) => el.tagName)) === 'SELECT') await field.selectOption(value);
    else await field.fill(value);
  }
  await dialog.getByRole('button', { name: 'Confirm with passkey' }).click();
}
