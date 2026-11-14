// X08a PR 2 (design/ADR-M109 §2.1, D-08 X08a AC3) in a real browser: the board's search box and
// filters build the route, the filters live in the URL (a shared link shows the same search), the
// request carries them to `GET /v1/intents`, a too short text is refused before any request, and
// "Clear the search" goes back to the board. The stub API stands in for the real search; the
// database test (`intent-search.test.ts`) checks the API's own matching.
import { expect, test, type Page } from '@playwright/test';

const TOKEN = process.env.SDLC_DASHBOARD_E2E_TOKEN!;

async function signIn(page: Page): Promise<void> {
  await page.goto('/dashboard/');
  await page.getByLabel('Personal API token').fill(TOKEN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
}

/** Moves within the page (a reload would sign out: the token lives in memory only). */
async function openHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

function intentRequests(page: Page): URL[] {
  const urls: URL[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/v1/intents') urls.push(url);
  });
  return urls;
}

test('X08a: a search puts its filters in the URL and the request; the list shows the matches', async ({
  page,
}) => {
  const requests = intentRequests(page);
  await signIn(page);
  const search = page.getByRole('search', { name: 'Search intents' });
  await search.getByRole('searchbox').fill('  orders ');
  await search.getByLabel('Gate').selectOption('G2');
  const sent = page.waitForRequest((r) => new URL(r.url()).searchParams.get('q') === 'orders');
  await search.getByRole('button', { name: 'Search' }).click();

  await expect(page).toHaveURL(/#\/intents\?(.*&)?q=orders/);
  await expect(page).toHaveURL(/gate=G2/);
  const last = new URL((await sent).url());
  expect(last.pathname).toBe('/v1/intents');
  expect(last.searchParams.get('gate')).toBe('G2');
  await expect(page.getByText('Matching intents: 1')).toBeVisible();
  const table = page.getByRole('table', { name: 'Intents that match the search' });
  await expect(table.getByRole('link', { name: 'INT-2026-0002' })).toBeVisible();
  await expect(table.getByText('Filter orders by status')).toBeVisible();

  // "Clear the search": the board again, no filter in the request.
  await page.getByRole('link', { name: 'Clear the search' }).click();
  await expect(page).toHaveURL(/#\/intents$/);
  await expect(page.getByRole('table', { name: 'Intents that match the search' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'INT-2026-0006' })).toBeVisible();
  expect(requests.length).toBeGreaterThan(0);
});

test('X08a: a shared link shows the same search with the form filled in', async ({ page }) => {
  await signIn(page);
  await openHash(page, '#/intents?q=warning&risk_tier=medium');
  const search = page.getByRole('search', { name: 'Search intents' });
  await expect(search.getByRole('searchbox')).toHaveValue('warning');
  await expect(search.getByLabel('Risk')).toHaveValue('medium');
  await expect(page.getByText('Matching intents: 1')).toBeVisible();
  await expect(page.getByRole('link', { name: 'INT-2026-0005' })).toBeVisible();
  // A value the API would refuse is left out of the request, never sent.
  await openHash(page, '#/intents?q=warning&gate=G9');
  await expect(page.getByLabel('Gate')).toHaveValue('');
});

test('X08a: a one-character search is refused in the page, before any request', async ({
  page,
}) => {
  await signIn(page);
  const requests = intentRequests(page);
  const search = page.getByRole('search', { name: 'Search intents' });
  await search.getByRole('searchbox').fill('x');
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(search.getByRole('alert')).toHaveText(
    'Type 2 to 200 characters, or leave the box empty.',
  );
  await expect(page).toHaveURL(/#\/intents$|\/dashboard\/$/);
  expect(requests.filter((u) => u.searchParams.has('q'))).toEqual([]);
});

test('X08a: the search fits a 375 px screen without a horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  await openHash(page, '#/intents?q=orders');
  await expect(page.getByText(/Matching intents/)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
