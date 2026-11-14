// The search box and filters of the intents board (task X08a PR 2, design/ADR-M109 §2.1). The
// form only builds the route: the filters live in the URL, so a search can be shared and the
// browser's back button works. Every label comes from the catalog.
import { useState } from 'preact/hooks';

import { t } from '../i18n.js';
import {
  GATES,
  isDay,
  RISKS,
  SEARCH_MAX,
  SEARCH_MIN,
  searchText,
  type IntentSearch,
} from '../model/search.js';

const RISK_KEYS: Readonly<Record<(typeof RISKS)[number], string>> = {
  low: 'dashboard.search.risk_low',
  medium: 'dashboard.search.risk_medium',
  high: 'dashboard.search.risk_high',
  critical: 'dashboard.search.risk_critical',
};

const DATES = [
  ['created_from', 'dashboard.search.created_from'],
  ['created_to', 'dashboard.search.created_to'],
  ['closed_from', 'dashboard.search.closed_from'],
  ['closed_to', 'dashboard.search.closed_to'],
] as const;

export function IntentSearchForm({
  value,
  onSearch,
  clearHref,
}: {
  readonly value: IntentSearch;
  readonly onSearch: (search: IntentSearch) => void;
  /** The board without the search; only while a search is set. */
  readonly clearHref?: string | undefined;
}) {
  const [problem, setProblem] = useState(false);
  const submit = (event: Event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const text = (name: string) => {
      const raw = data.get(name);
      return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
    };
    const rawQ = text('q');
    const q = searchText(rawQ);
    if (rawQ !== undefined && q === undefined) {
      setProblem(true);
      return;
    }
    setProblem(false);
    const out: Record<string, string> = {};
    if (q !== undefined) out.q = q;
    for (const key of ['gate', 'risk_tier', 'sealed'] as const) {
      const v = text(key);
      if (v !== undefined) out[key] = v;
    }
    for (const [key] of DATES) {
      const day = text(key);
      if (day !== undefined && isDay(day)) out[key] = day;
    }
    onSearch(out);
  };
  return (
    <form
      role="search"
      class="intent-search"
      onSubmit={submit}
      aria-label={t('dashboard.search.label')}
    >
      <label class="intent-search-text">
        <span class="select-label">{t('dashboard.search.label')}</span>
        <input
          type="search"
          name="q"
          defaultValue={value.q ?? ''}
          maxLength={SEARCH_MAX}
          placeholder={t('dashboard.search.placeholder')}
          aria-describedby="intent-search-hint"
          aria-invalid={problem ? 'true' : undefined}
        />
      </label>
      <label class="select">
        <span class="select-label">{t('dashboard.search.gate')}</span>
        <select name="gate">
          <option value="">{t('dashboard.search.any')}</option>
          {GATES.map((gate) => (
            <option key={gate} value={gate} selected={value.gate === gate}>
              {gate}
            </option>
          ))}
        </select>
      </label>
      <label class="select">
        <span class="select-label">{t('dashboard.search.risk')}</span>
        <select name="risk_tier">
          <option value="">{t('dashboard.search.any')}</option>
          {RISKS.map((risk) => (
            <option key={risk} value={risk} selected={value.risk_tier === risk}>
              {t(RISK_KEYS[risk])}
            </option>
          ))}
        </select>
      </label>
      <label class="select">
        <span class="select-label">{t('dashboard.search.sealed')}</span>
        <select name="sealed">
          <option value="">{t('dashboard.search.any')}</option>
          <option value="true" selected={value.sealed === 'true'}>
            {t('dashboard.search.sealed_yes')}
          </option>
          <option value="false" selected={value.sealed === 'false'}>
            {t('dashboard.search.sealed_no')}
          </option>
        </select>
      </label>
      {DATES.map(([key, label]) => (
        <label key={key} class="select">
          <span class="select-label">{t(label)}</span>
          <input type="date" name={key} defaultValue={value[key] ?? ''} />
        </label>
      ))}
      <button type="submit" class="button button-primary">
        {t('dashboard.search.submit')}
      </button>
      {clearHref !== undefined && (
        <a class="button button-quiet" href={clearHref}>
          {t('dashboard.search.clear')}
        </a>
      )}
      <p
        id="intent-search-hint"
        class={problem ? 'field-hint is-error' : 'field-hint'}
        role={problem ? 'alert' : undefined}
      >
        {problem
          ? t('dashboard.search.too_short', { min: SEARCH_MIN, max: SEARCH_MAX })
          : t('dashboard.search.hint')}
      </p>
    </form>
  );
}
