// The intents that match the board's search (task X08a PR 2, design/ADR-M109 §2.1), newest first,
// open and finished alike, as `GET /v1/intents` returns them. Server text is shown as text.
import type { IntentView } from '@sdlc/api-schemas';

import { codeClass, Empty, Txt } from './common.js';
import { t } from '../i18n.js';
import { intentHref } from '../router.js';

export function SearchResults({
  items,
  truncated,
}: {
  readonly items: readonly IntentView[];
  readonly truncated: boolean;
}) {
  return (
    <>
      <p class="asof" role="status">
        {t('dashboard.search.count', { count: items.length })}
      </p>
      {truncated && <p class="notice">{t('dashboard.board.truncated')}</p>}
      {items.length === 0 ? (
        <Empty messageKey="dashboard.search.empty" />
      ) : (
        <div class="table-wrap">
          <table>
            <caption class="visually-hidden">{t('dashboard.search.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('dashboard.col.intent')}</th>
                <th scope="col">{t('dashboard.col.title')}</th>
                <th scope="col">{t('dashboard.col.status')}</th>
                <th scope="col">{t('dashboard.search.col_gate')}</th>
                <th scope="col">{t('dashboard.search.col_risk')}</th>
                <th scope="col">{t('dashboard.col.project')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((intent) => (
                <tr key={intent.id}>
                  <th scope="row">
                    <a class="mono" href={intentHref(intent.code)}>
                      <Txt value={intent.code} />
                    </a>
                  </th>
                  <td>
                    <Txt value={intent.title} />
                  </td>
                  <td>
                    <span class={`chip ${codeClass('status', intent.status)}`}>
                      <Txt value={intent.status} />
                    </span>
                  </td>
                  <td class="mono">
                    <Txt value={intent.current_gate ?? '—'} />
                  </td>
                  <td>
                    <span class={`chip ${codeClass('risk', intent.risk_tier)}`}>
                      <Txt value={intent.risk_tier} />
                    </span>
                  </td>
                  <td>
                    <Txt value={intent.project.slug} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
