// A screen of a separate chunk (U09, QUESTIONS #686): loaded once with `import()` from the
// dashboard's own origin (CSP `script-src 'self'`), then rendered. A failed load says so.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { t } from '../i18n.js';

/** Loads a chunk (`import()`). */
export interface Loader<M> {
  (): Promise<M>;
}

export function useModule<M>(load: Loader<M>): M | 'loading' | 'failed' {
  const [state, setState] = useState<M | 'loading' | 'failed'>('loading');
  useEffect(() => {
    let live = true;
    load().then(
      (module) => live && setState(() => module),
      () => live && setState('failed'),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

export function Lazy<M>({
  load,
  children,
}: {
  readonly load: Loader<M>;
  readonly children: (module: M) => ComponentChildren;
}) {
  const module = useModule(load);
  if (module === 'loading') {
    return (
      <p class="notice" role="status" aria-live="polite">
        {t('dashboard.state.loading')}
      </p>
    );
  }
  if (module === 'failed') {
    return (
      <p class="notice notice-error" role="alert">
        {t('dashboard.error.network')}
      </p>
    );
  }
  return <>{children(module)}</>;
}
