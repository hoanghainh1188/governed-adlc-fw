// Intents and gates (U01 AC4): open intents in one row per gate, the longest wait first. Filters
// (project, open or finished) are kept in the URL. X08a PR 2 (ADR-M109 §2.1): a search box and
// the filters of `GET /v1/intents`, also in the URL; with any of them set, the board shows the
// matching intents as one list, newest first, as the API returns them.
import { useState } from 'preact/hooks';
import type { IntentView, Me } from '@sdlc/api-schemas';

import { readIntents, readOpenEscalations } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { Bar, codeClass, Duration, Empty, Label, Show, Txt } from '../components/common.js';
import { CreateIntentModal } from '../components/CreateIntentModal.js';
import { IntentSearchForm } from '../components/IntentSearchForm.js';
import { SearchResults } from '../components/SearchResults.js';
import { holdOf } from '../model/hold.js';
import { t } from '../i18n.js';
import {
  buildBoard,
  FINISHED_STATUSES,
  intentLinks,
  longestWait,
  type BoardCard,
  type LaneId,
} from '../model/intents.js';
import { isSearching, searchOf, type IntentSearch } from '../model/search.js';
import { href, intentHref } from '../router.js';
import { session } from '../session.js';
import { ProjectFilter, projectsOf } from './filters.js';

const LANE_KEYS: Readonly<Record<LaneId, string>> = {
  draft: 'dashboard.gate.draft',
  G1: 'dashboard.gate.g1',
  G2: 'dashboard.gate.g2',
  G3: 'dashboard.gate.g3',
  G4: 'dashboard.gate.g4',
  G5: 'dashboard.gate.g5',
  G6: 'dashboard.gate.g6',
  G7: 'dashboard.gate.g7',
  G8: 'dashboard.gate.g8',
};

export function IntentsBoard({ me, query }: { readonly me: Me; readonly query: URLSearchParams }) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const projects = projectsOf(me);
  const project = projects.includes(query.get('project') ?? '') ? query.get('project')! : undefined;
  const finished = query.get('show') === 'finished';
  const search = searchOf(query);
  const searching = isSearching(search);
  const searchKey = JSON.stringify(search);
  const go = (next: {
    project?: string | undefined;
    search?: IntentSearch;
    finished?: boolean;
  }) => {
    window.location.hash = href('intents', {
      project: 'project' in next ? next.project : project,
      show: (next.finished ?? finished) ? 'finished' : undefined,
      ...(next.search ?? search),
    });
  };
  const { result, reload } = useApi(
    async (signal) => {
      const [intents, escalations] = await Promise.all([
        readIntents(project, { signal }, search),
        readOpenEscalations(undefined, { signal }),
      ]);
      return { intents, escalations };
    },
    [project, searchKey],
  );

  return (
    <section aria-labelledby="board-title" class="screen">
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.board.eyebrow')}</p>
          <h1 id="board-title">{t('dashboard.board.title')}</h1>
        </div>
        <div class="toolbar">
          <ProjectFilter
            projects={projects}
            value={project}
            onChange={(slug) => go({ project: slug })}
          />
          <div class="segmented" role="group" aria-label={t('dashboard.board.show_label')}>
            <a href={href('intents', { project })} aria-current={finished ? undefined : 'true'}>
              {t('dashboard.board.show_open')}
            </a>
            <a
              href={href('intents', { project, show: 'finished' })}
              aria-current={finished ? 'true' : undefined}
            >
              {t('dashboard.board.show_finished')}
            </a>
          </div>
          <button type="button" class="button button-quiet" onClick={reload}>
            {t('dashboard.refresh')}
          </button>
          {session.actions() && (
            <button
              type="button"
              class="button button-primary"
              onClick={() => setShowCreateModal(true)}
            >
              {t('dashboard.intent.new')}
            </button>
          )}
        </div>
      </div>
      <IntentSearchForm
        key={searchKey}
        value={search}
        onSearch={(next) => go({ search: next })}
        clearHref={
          searching
            ? href('intents', { project, show: finished ? 'finished' : undefined })
            : undefined
        }
      />

      <Show loaded={result}>
        {({ intents, escalations }, at) =>
          searching ? (
            <SearchResults items={intents.items} truncated={intents.truncated} />
          ) : finished ? (
            <FinishedList
              items={intents.items.filter((i) => FINISHED_STATUSES.includes(i.status))}
            />
          ) : (
            <Board
              cards={buildBoard(intents.items, escalations.items, at)}
              truncated={intents.truncated}
              escalationsTruncated={escalations.truncated}
              at={at}
            />
          )
        }
      </Show>
      {showCreateModal && (
        <CreateIntentModal
          projects={projects}
          defaultProject={project}
          onClose={() => setShowCreateModal(false)}
          onSuccess={(newIntent) => {
            setShowCreateModal(false);
            window.location.hash = intentHref(newIntent.code);
          }}
        />
      )}
    </section>
  );
}

function Board({
  cards: lanes,
  truncated,
  escalationsTruncated,
  at,
}: {
  readonly cards: ReturnType<typeof buildBoard>;
  readonly truncated: boolean;
  readonly escalationsTruncated: boolean;
  readonly at: Date;
}) {
  const total = lanes.reduce((n, lane) => n + lane.cards.length, 0);
  const scale = longestWait(lanes);
  return (
    <>
      <p class="asof">
        {t('dashboard.board.summary', { count: total })} · {t('dashboard.as_of')}{' '}
        <time dateTime={at.toISOString()}>{at.toLocaleTimeString()}</time>
      </p>
      {truncated && <p class="notice">{t('dashboard.board.truncated')}</p>}
      {escalationsTruncated && <p class="notice">{t('dashboard.board.escalations_truncated')}</p>}
      {total === 0 ? (
        <Empty messageKey="dashboard.board.empty" />
      ) : (
        <ol class="ledger">
          {lanes.map((lane) => (
            <li key={lane.id} class={`ledger-row ${lane.cards.length === 0 ? 'is-empty' : ''}`}>
              <div class="ledger-gate">
                <span class="ledger-code">{lane.id === 'draft' ? '—' : lane.id}</span>
                <span class="ledger-name">{t(LANE_KEYS[lane.id])}</span>
                <span class="ledger-count">{lane.cards.length}</span>
              </div>
              <ul class="cards">
                {lane.cards.map((card) => (
                  <li key={card.intent.id}>
                    <Card card={card} scale={scale} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Card({ card, scale }: { readonly card: BoardCard; readonly scale: number }) {
  const { intent } = card;
  const links = intentLinks(intent);
  const flag = card.overdue ? 'card-overdue' : card.frozen ? 'card-frozen' : '';
  const hold = holdOf(intent);
  return (
    <article class={`card ${flag}`} aria-labelledby={`card-${intent.id}`}>
      <header class="card-head">
        <a id={`card-${intent.id}`} class="card-code" href={intentHref(intent.code)}>
          <Txt value={intent.code} />
        </a>
        <span class={`chip ${codeClass('risk', intent.risk_tier)}`}>
          <Txt value={intent.risk_tier} />
        </span>
      </header>
      <p class="card-title">
        <Txt value={intent.title} />
      </p>
      {hold && (
        <p class="card-hold">
          <span class="chip chip-warn">{t('dashboard.board.held')}</span>{' '}
          <Label value={hold.reason} />
          {hold.cause && (
            <>
              {': '}
              <Label value={hold.cause} />
            </>
          )}
        </p>
      )}
      <div class="card-wait">
        <Duration seconds={card.waitedSeconds} />
        <Bar
          value={scale > 0 ? (card.waitedSeconds ?? 0) / scale : 0}
          tone={card.overdue ? 'alert' : 'accent'}
          label={t('dashboard.board.wait_bar')}
        />
      </div>
      <footer class="card-foot">
        {intent.status !== 'in_gate' && (
          <span class="chip chip-status">
            <Txt value={intent.status} />
          </span>
        )}
        {card.overdue && <span class="chip chip-alert">{t('dashboard.board.overdue')}</span>}
        {card.frozen && <span class="chip chip-warn">{t('dashboard.board.frozen')}</span>}
        <span class="card-project">
          <Txt value={intent.project.slug} />
        </span>
        {links.issue && (
          <a href={links.issue} target="_blank" rel="noopener noreferrer">
            {t('dashboard.link.issue', { number: intent.issue_number ?? '' })}
          </a>
        )}
        {links.pullRequest && (
          <a href={links.pullRequest} target="_blank" rel="noopener noreferrer">
            {t('dashboard.link.pull_request', { number: intent.pr_number ?? '' })}
          </a>
        )}
      </footer>
    </article>
  );
}

function FinishedList({ items }: { readonly items: readonly IntentView[] }) {
  if (items.length === 0) return <Empty messageKey="dashboard.board.finished_empty" />;
  return (
    <div class="table-wrap">
      <table>
        <caption class="visually-hidden">{t('dashboard.board.finished_caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.col.intent')}</th>
            <th scope="col">{t('dashboard.col.title')}</th>
            <th scope="col">{t('dashboard.col.status')}</th>
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
              <td>
                <Txt value={intent.project.slug} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
