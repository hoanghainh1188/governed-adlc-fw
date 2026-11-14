// X08b PR 3 (design/ADR-M109 §2.5, D-08 X08b AC5, QUESTIONS #728) in a real browser: the
// read-only lessons list of a project. The filters live in the URL, the request carries them to
// `GET /v1/lessons`, each row links to its intent and its GitHub comment, and the screen offers
// no way to record or change a lesson. The stub API stands in for the real list; the database
// test (`lesson-api.test.ts`) checks the API.
import { expect, test, type Page } from '@playwright/test';

const TOKEN = process.env.SDLC_DASHBOARD_E2E_TOKEN!;

async function signIn(page: Page): Promise<void> {
  await page.goto('/dashboard/');
  await page.getByLabel('Personal API token').fill(TOKEN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
}

test('X08b: the lessons of a project, read only, with their filters in the URL', async ({
  page,
}) => {
  const requests: URL[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/v1/lessons') requests.push(url);
    // The screen never writes: no POST to a lesson path.
    if (req.method() !== 'GET') expect(url.pathname).not.toMatch(/lesson/);
  });
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Lessons' }).click();
  await page.getByLabel('Project').selectOption('shop');
  await expect(page).toHaveURL(/#\/lessons\?project=shop$/);
  await expect(page.getByRole('heading', { name: 'Lessons', level: 1 })).toBeVisible();

  const table = page.getByRole('table', { name: 'Lessons' });
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('link', { name: 'INT-2026-0002' }).first()).toHaveAttribute(
    'href',
    '#/intents/INT-2026-0002',
  );
  const comment = table.getByRole('link', { name: 'Open the comment' }).first();
  await expect(comment).toHaveAttribute('href', /#issuecomment-1001$/);
  await expect(comment).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(table.getByText('Applied')).toBeVisible();
  await expect(table.getByRole('link', { name: 'Open the change' })).toHaveAttribute(
    'href',
    'https://github.com/harryforge/shop-demo/pull/31',
  );
  await expect(table.getByText('Record only')).toBeVisible();
  await expect(page.getByRole('button', { name: /record|apply|drop/i })).toHaveCount(0);

  // Open only: in the URL and in the request.
  await page.getByLabel('State').selectOption('open');
  await expect(page).toHaveURL(/#\/lessons\?project=shop&open=true$/);
  await expect(table.getByRole('row')).toHaveCount(2);
  expect(requests.at(-1)?.searchParams.get('open')).toBe('true');
  expect(requests.at(-1)?.searchParams.get('project')).toBe('shop');
});

test('X08b: the lessons list on a phone, 375 px wide', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signIn(page);
  await page.evaluate(() => {
    window.location.hash = '#/lessons?project=shop';
  });
  await expect(page.getByRole('table', { name: 'Lessons' })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});
