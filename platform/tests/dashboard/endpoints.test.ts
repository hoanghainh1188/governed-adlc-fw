// U01 AC1, AC6 (design/ADR-M54 §2.1): the dashboard needs no new endpoint. Every path it reads is
// an existing GET route of the API, found in the controllers' decorators. U06: every path it
// writes (src/api/writes.ts) is an existing route of the API with the same method.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const apiSrc = path.join(root, 'platform/apps/api/src');

function controllers(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return controllers(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

/** Routes of one method as patterns, `:param` → one segment. */
function routesOf(method: 'Get' | 'Post' | 'Put' | 'Patch' | 'Delete'): RegExp[] {
  return controllers(apiSrc).flatMap((file) => {
    // A file may hold several controllers (L05): each route takes the base of the one above it.
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/(?=@Controller\()/).flatMap((part) => {
      const base = /@Controller\('([^']*)'\)/.exec(part)?.[1] ?? '';
      return [...part.matchAll(new RegExp(`@${method}\\((?:'([^']*)')?\\)`, 'g'))].map((m) => {
        const full = `/${[base, m[1] ?? ''].filter((p) => p !== '').join('/')}`;
        return new RegExp(`^${full.replace(/:[a-z_]+/g, '[^/]+')}$`);
      });
    });
  });
}

const getRoutes = (): RegExp[] => routesOf('Get');

/** The paths the dashboard reads (`apiPath('…')` in src/api/reads.ts), with `${…}` as one segment. */
function dashboardPaths(): string[] {
  const reads = fs.readFileSync(
    path.join(root, 'platform/apps/dashboard/src/api/reads.ts'),
    'utf8',
  );
  return [...reads.matchAll(/apiPath\(\s*[`']([^`']+)[`']/g)].map((m) =>
    m[1]!.replace(/\$\{[^}]+\}/g, 'X'),
  );
}

describe('the dashboard reads existing GET endpoints only', () => {
  it('finds the API routes and the dashboard reads', () => {
    expect(getRoutes().length).toBeGreaterThan(20);
    expect(dashboardPaths()).toEqual(
      expect.arrayContaining([
        '/v1/me',
        '/v1/intents',
        '/v1/intents/X',
        '/v1/escalations',
        '/v1/cost/report',
        '/v1/metrics/gates',
        '/v1/admin/audit/verify',
        // U05: public reads of the sign-in.
        '/v1/auth/config',
        '/v1/auth/github/start',
        // U06: the session's CSRF token, the person's passkeys.
        '/v1/auth/session',
        '/v1/me/passkeys',
      ]),
    );
  });

  it('every path it reads is a GET route of the API', () => {
    const routes = getRoutes();
    for (const p of dashboardPaths()) {
      expect(
        routes.some((r) => r.test(p)),
        p,
      ).toBe(true);
    }
  });
});

describe('U06: the dashboard writes existing routes only, with their method', () => {
  it('every write of src/api/writes.ts is a route of the API with the same method', () => {
    const writes = ['writes.ts', 'admin-writes.ts']
      .map((f) => fs.readFileSync(path.join(root, 'platform/apps/dashboard/src/api', f), 'utf8'))
      .join('\n');
    const calls = [
      ...writes.matchAll(/send\(\s*apiPath\([`']([^`']+)[`']\),\s*'(POST|PUT|PATCH|DELETE)'/g),
    ].map((m) => ({ path: m[1]!.replace(/\$\{[^}]+\}/g, 'X'), method: m[2]! }));
    // U06: sign out (2), passkeys (3); L05: the step-up and the four plan actions (5);
    // U07: kill run (1), gate decision (1), escalation ack (1), escalation decision (1);
    // U08: create intent (1); U09 PR 2: administration (14).
    expect(calls.length).toBe(32);
    const decorator = { POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete' } as const;
    for (const call of calls) {
      const routes = routesOf(decorator[call.method as keyof typeof decorator]);
      expect(
        routes.some((r) => r.test(call.path)),
        `${call.method} ${call.path}`,
      ).toBe(true);
    }
  });
});
