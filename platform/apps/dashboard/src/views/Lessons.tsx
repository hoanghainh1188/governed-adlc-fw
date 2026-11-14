// The lessons of a project (task X08b PR 3, design/ADR-M109 §2.5, QUESTIONS #728): what people
// recorded at G8, with its codes, its intent, its age, the link to the comment that holds the
// words, and its outcome. Read only: a lesson is recorded with `/lesson` on GitHub or with
// `adlc lesson add`, and its outcome with `adlc lesson apply|drop`.
import type { LessonView, Me } from '@sdlc/api-schemas';

import { readLessons } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { codeClass, Empty, Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import {
  ageInDays,
  LESSON_CATEGORY_KEYS,
  LESSON_REASON_KEYS,
  LESSON_STATE_KEYS,
  LESSON_TARGET_KEYS,
  lessonFilterOf,
  outcomeOf,
} from '../model/lessons.js';
import { href, intentHref } from '../router.js';
import { ProjectFilter, projectsOf } from './filters.js';

const label = (keys: Readonly<Record<string, string>>, code: string) => {
  const key = keys[code];
  return key === undefined ? code : t(key);
};

export function Lessons({ me, query }: { readonly me: Me; readonly query: URLSearchParams }) {
  const projects = projectsOf(me);
  const { project, open } = lessonFilterOf(query, projects);
  const go = (next: { project?: string | undefined; open?: boolean }) => {
    const p = 'project' in next ? next.project : project;
    const o = next.open ?? open;
    window.location.hash = href('lessons', { project: p, open: o ? 'true' : undefined });
  };
  const { result, reload } = useApi(
    async (signal) => (project === undefined ? null : readLessons(project, open, { signal })),
    [project, open],
  );

  return (
    <section class="screen" aria-labelledby="lessons-title">
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.lessons.eyebrow')}</p>
          <h1 id="lessons-title">{t('dashboard.lessons.title')}</h1>
        </div>
        <div class="toolbar">
          <ProjectFilter
            projects={projects}
            value={project}
            onChange={(slug) => go({ project: slug })}
            allLabelKey="dashboard.filter.pick"
          />
          <label class="select">
            <span class="select-label">{t('dashboard.lessons.state_filter')}</span>
            <select onChange={(e) => go({ open: e.currentTarget.value === 'open' })}>
              <option value="" selected={!open}>
                {t('dashboard.lessons.all')}
              </option>
              <option value="open" selected={open}>
                {t('dashboard.lessons.only_open')}
              </option>
            </select>
          </label>
          <button type="button" class="button button-quiet" onClick={reload}>
            {t('dashboard.refresh')}
          </button>
        </div>
      </div>
      <p class="lede">{t('dashboard.lessons.lede')}</p>
      {project === undefined ? (
        <Empty messageKey="dashboard.lessons.no_project" />
      ) : (
        <Show loaded={result}>
          {(data) =>
            data === null || data.items.length === 0 ? (
              <Empty messageKey={open ? 'dashboard.lessons.none_open' : 'dashboard.lessons.none'} />
            ) : (
              <LessonTable rows={data.items} />
            )
          }
        </Show>
      )}
    </section>
  );
}

function LessonTable({ rows }: { readonly rows: readonly LessonView[] }) {
  const now = new Date();
  return (
    <div class="table-wrap">
      <table class="lesson-table">
        <caption class="visually-hidden">{t('dashboard.lessons.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.lessons.col.intent')}</th>
            <th scope="col">{t('dashboard.lessons.col.lesson')}</th>
            <th scope="col">{t('dashboard.lessons.col.age')}</th>
            <th scope="col">{t('dashboard.lessons.col.comment')}</th>
            <th scope="col">{t('dashboard.lessons.col.outcome')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.id}>
              <th scope="row">
                {l.intent === null ? (
                  <span class="muted">—</span>
                ) : (
                  <a class="mono" href={intentHref(l.intent)}>
                    <Txt value={l.intent} />
                  </a>
                )}
                <span class="sub mono">
                  <Txt value={l.id} />
                </span>
              </th>
              <td data-label={t('dashboard.lessons.col.lesson')}>
                {label(LESSON_CATEGORY_KEYS, l.category)}
                <span class="sub">
                  {t('dashboard.lessons.target', { target: label(LESSON_TARGET_KEYS, l.target) })}
                </span>
              </td>
              <td data-label={t('dashboard.lessons.col.age')}>
                {t('dashboard.lessons.days', { days: ageInDays(l.created_at, now) ?? '—' })}
                <span class="sub">
                  <When iso={l.created_at} />
                </span>
              </td>
              <td data-label={t('dashboard.lessons.col.comment')}>
                <a href={l.comment_url} target="_blank" rel="noopener noreferrer">
                  {t('dashboard.lessons.open_comment')}
                </a>
              </td>
              <td data-label={t('dashboard.lessons.col.outcome')}>
                <span class={`chip ${codeClass('lesson', l.state)}`}>
                  {label(LESSON_STATE_KEYS, l.state)}
                </span>
                <Outcome lesson={l} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Outcome({ lesson }: { readonly lesson: LessonView }) {
  const o = outcomeOf(lesson);
  if (o.kind === 'link') {
    return (
      <a class="sub" href={o.url} target="_blank" rel="noopener noreferrer">
        {t('dashboard.lessons.open_change')}
      </a>
    );
  }
  if (o.kind === 'reason') return <span class="sub">{label(LESSON_REASON_KEYS, o.reason)}</span>;
  if (o.kind === 'follow_up') return <span class="sub">{t('dashboard.lessons.follow_up')}</span>;
  return null;
}
