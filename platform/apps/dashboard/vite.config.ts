// Build of the read-only dashboard (task U01, design/ADR-M54 §2.5). `sdlc-api` serves the output
// under /dashboard/ with a strict Content-Security-Policy, so the build must hold no inline script,
// no inline asset (data: URIs) and no third-party URL.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;
const CATALOG_ID = 'virtual:dashboard-catalog';
/** U09 (QUESTIONS #686): the `dashboard.admin.*` messages, in the administration chunk. */
const ADMIN_CATALOG_ID = 'virtual:dashboard-admin-catalog';
const ADMIN_PREFIX = 'dashboard.admin.';

/**
 * The `dashboard.*` and `intent.waiting*` (U02) messages of the catalog (`@sdlc/messages`, NFR-08), bundled at build time. The
 * whole catalog is ~100 kB; the dashboard needs only its own keys.
 */
export function dashboardCatalog(): Plugin {
  const file = path.resolve(root, '../../packages/messages/src/locales/en.json');
  return {
    name: 'sdlc-dashboard-catalog',
    resolveId: (id) => (id === CATALOG_ID || id === ADMIN_CATALOG_ID ? `\0${id}` : null),
    load(id) {
      if (id !== `\0${CATALOG_ID}` && id !== `\0${ADMIN_CATALOG_ID}`) return null;
      const admin = id === `\0${ADMIN_CATALOG_ID}`;
      this.addWatchFile(file);
      const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      const own = Object.fromEntries(
        Object.entries(all).filter(([key]) =>
          admin ? key.startsWith(ADMIN_PREFIX) : !key.startsWith(ADMIN_PREFIX) && wanted(key),
        ),
      );
      return `export default ${JSON.stringify(own)};`;
    },
  };
}

/** The keys of the first-load catalog. */
function wanted(key: string): boolean {
  return (
    key.startsWith('dashboard.') ||
    key.startsWith('intent.waiting') ||
    // U07: the refusal reasons of a gate decision, as in the comment replies.
    key.startsWith('gate.reason.') ||
    // L05: the refusals of evaluation plans, by the reason the API gives.
    key.startsWith('evaluation.error.') ||
    // L06: the recommendations of an evaluation report, by rule (ADR-M83 §2.3).
    key.startsWith('eval.recommendation.') ||
    // U08: the refusals of a spec link, a plan submission and the API's own sentences.
    key.startsWith('spec.error.') ||
    key.startsWith('plan.error.') ||
    key.startsWith('plan.refusal.') ||
    key.startsWith('api.error.')
  );
}

export default defineConfig({
  root,
  base: '/dashboard/',
  plugins: [dashboardCatalog()],
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  resolve: {
    // The shared schemas from source: one ES module graph, tree-shaken.
    alias: {
      '@sdlc/api-schemas': path.resolve(root, '../../packages/api-schemas/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    // CSP `font-src 'self'`, `img-src 'self'`: never a data: URI.
    assetsInlineLimit: 0,
    // No inline polyfill script.
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2022',
    reportCompressedSize: true,
  },
});
