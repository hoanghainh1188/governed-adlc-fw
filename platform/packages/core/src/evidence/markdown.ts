// The readable Evidence Pack (task E02, D-02 FR-42, D-08 E02 AC4, design/ADR-M48 §2.4): one
// Markdown file, every label from the message catalog (English by default, NFR-08).
//
// The values are the manifest's codes, IDs, hashes, counts, times and references, plus the
// approvers' display names next to their role (QUESTIONS #216), read at build time. Every value
// is escaped: control, bidirectional and zero-width characters are removed and Markdown syntax is
// escaped, so a name can never add a link, an image, HTML or a table cell. Diffs, specs, plans and
// review texts are never in the pack; the diff stays on the pull request and in the evidence store.
import { t, type MessageKey } from '@sdlc/messages';

import { disclosureFacts, disclosureText } from './disclosure.js';
import { PACK_RUN_EVENTS, planFilePath, type PackBuildInfo, type PackSource } from './manifest.js';

const MAX_TEXT = 120;
/** Codes, hashes and links (an `https://` reference is at most 512 characters). */
const MAX_CODE = 600;

/** Cuts a value to `max` characters and marks the cut. */
function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
// C0/C1 controls, bidirectional controls and isolates, zero-width characters, BOM.
const INVISIBLE = new RegExp(
  // eslint-disable-next-line no-control-regex -- control characters are what it removes
  '[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]',
  'g',
);
const MARKDOWN = /[\\`*_{}[\]()<>#+\-.!|~&"']/g;

/** Plain text that is safe anywhere in a Markdown table or paragraph. */
export function mdText(value: string): string {
  const clean = cut(value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim(), MAX_TEXT);
  return clean.replace(MARKDOWN, (c) => `\\${c}`);
}

/** A code, ID or hash as a code span; anything with a backtick falls back to escaped text. */
export function mdCode(value: string): string {
  const clean = cut(value.replace(INVISIBLE, ''), MAX_CODE);
  return clean.includes('`') || clean.includes('|') ? mdText(clean) : `\`${clean}\``;
}

function cell(value: string | number | boolean | null | undefined, none: string): string {
  if (value === null || value === undefined || value === '') return none;
  return typeof value === 'string' ? mdCode(value) : mdCode(String(value));
}

function table(headers: readonly string[], rows: readonly (readonly string[])[], none: string) {
  if (rows.length === 0) return [none, ''];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
  ];
}

/** A run event value (codes, counts, hashes; D-05 §6.4) as text. */
function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

export interface MarkdownInput {
  readonly source: PackSource;
  readonly build: PackBuildInfo;
  /** Display names by user ID (approvers), read at build time. */
  readonly names: ReadonlyMap<string, string>;
  readonly locale: string;
}

export function renderPackMarkdown(input: MarkdownInput): string {
  const { source, build, names, locale } = input;
  const l = (key: MessageKey, params: Record<string, string | number> = {}) =>
    t(key, params, locale);
  const none = l('evidence.md.none');
  const c = (value: string | number | boolean | null | undefined) => cell(value, none);
  const { intent, project } = source;
  const facts = disclosureFacts(source);
  const person = (id: string | null) =>
    id === null ? none : `${names.has(id) ? mdText(names.get(id)!) : none} (${mdCode(id)})`;

  const lines: string[] = [
    `# ${l('evidence.md.title', { intent: mdText(intent.code), version: build.version })}`,
    '',
    l('evidence.md.intro'),
    '',
    ...table(
      [l('evidence.md.col.item'), l('evidence.md.col.value')],
      [
        [l('evidence.md.pack_id'), c(build.packId)],
        [l('evidence.md.built_at'), c(build.builtAt.toISOString())],
        [
          l('evidence.md.built_by'),
          build.builtBy === null ? l('evidence.md.platform') : c(build.builtBy),
        ],
        [l('evidence.md.content_sha256'), c(build.contentSha256)],
        [l('evidence.md.release_sha256'), c(build.releaseSha256)],
      ],
      none,
    ),
    `## ${l('evidence.md.section.intent')}`,
    '',
    ...table(
      [l('evidence.md.col.item'), l('evidence.md.col.value')],
      [
        [l('evidence.md.intent'), c(intent.code)],
        [l('evidence.md.project'), c(project.slug)],
        [l('evidence.md.repository'), c(`${project.git_provider}:${project.repo_full_name}`)],
        [l('evidence.md.risk_tier'), c(intent.risk_tier)],
        [l('evidence.md.data_class'), c(intent.data_class)],
        [l('evidence.md.max_autonomy'), c(intent.max_autonomy)],
        [l('evidence.md.status'), c(intent.status)],
        [l('evidence.md.current_gate'), c(intent.current_gate)],
        [l('evidence.md.issue'), c(intent.issue_number)],
        [l('evidence.md.pull_request'), c(intent.pr_number)],
      ],
      none,
    ),
    `## ${l('evidence.md.section.disclosure')}`,
    '',
    ...disclosureText(facts, locale, mdText, mdCode).flatMap((p) => [p, '']),
    ...(facts.client_text_required ? [l('evidence.md.client_text_required'), ''] : []),
    `## ${l('evidence.md.section.spec')}`,
    '',
    ...table(
      [
        l('evidence.md.col.version'),
        l('evidence.md.col.path'),
        l('evidence.md.col.commit'),
        l('evidence.md.col.sha256'),
      ],
      source.specs.map((s) => [c(s.version), c(s.path), c(s.commit_sha), c(s.content_sha256)]),
      none,
    ),
    `## ${l('evidence.md.section.plan')}`,
    '',
    ...table(
      [
        l('evidence.md.col.version'),
        l('evidence.md.col.path'),
        l('evidence.md.col.commit'),
        l('evidence.md.col.sha256'),
        l('evidence.md.col.patterns'),
        l('evidence.md.col.change_flags'),
      ],
      source.plans.map((p) => [
        c(p.version),
        c(
          p.plan_source === 'uploaded'
            ? 'uploaded'
            : p.commit_sha === null
              ? null
              : planFilePath(intent.code),
        ),
        c(p.commit_sha),
        c(p.plan_sha256),
        c(p.planned_files.length),
        c(p.change_flags.join(',')),
      ]),
      none,
    ),
    `## ${l('evidence.md.section.runs')}`,
    '',
    ...table(
      [
        l('evidence.md.col.run'),
        l('evidence.md.col.status'),
        l('evidence.md.col.agent'),
        l('evidence.md.col.model'),
        l('evidence.md.col.base'),
        l('evidence.md.col.head'),
        l('evidence.md.col.ci'),
      ],
      source.runs.map((run) => {
        const events = source.runEvents.get(run.id) ?? [];
        const ci = [...events].reverse().find((e) => e.event_type === 'ci_checked');
        const agent = source.agents.get(run.agent_id);
        return [
          c(`${run.attempt}:${run.id}`),
          c(run.stop_reason ? `${run.status}/${run.stop_reason}` : run.status),
          c(`${agent?.agent_key ?? run.agent_id}@${run.agent_version}`),
          c(agent && agent.version === run.agent_version ? agent.model_ref : null),
          c(run.base_sha),
          c(run.head_sha),
          c(typeof ci?.payload.state === 'string' ? ci.payload.state : null),
        ];
      }),
      none,
    ),
    `## ${l('evidence.md.section.items')}`,
    '',
    l('evidence.md.items_intro'),
    '',
    ...table(
      [
        l('evidence.md.col.kind'),
        l('evidence.md.col.run'),
        l('evidence.md.col.sha256'),
        l('evidence.md.col.size'),
        l('evidence.md.col.check'),
      ],
      source.items.map(({ item, check }) => [
        c(item.kind),
        c(item.run_id),
        c(item.sha256),
        c(item.size_bytes),
        c(check),
      ]),
      none,
    ),
    `## ${l('evidence.md.section.checks')}`,
    '',
    ...table(
      [l('evidence.md.col.run'), l('evidence.md.col.event'), l('evidence.md.col.values')],
      source.runs.flatMap((run) => {
        const latest = new Map<string, Record<string, unknown>>();
        for (const e of source.runEvents.get(run.id) ?? []) {
          if ((PACK_RUN_EVENTS as readonly string[]).includes(e.event_type)) {
            latest.set(e.event_type, e.payload);
          }
        }
        return [...latest].map(([type, payload]) => [
          c(run.id),
          c(type),
          Object.entries(payload)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${mdText(k)}=${c(scalar(v))}`)
            .join(', '),
        ]);
      }),
      none,
    ),
    `## ${l('evidence.md.section.decisions')}`,
    '',
    ...table(
      [
        l('evidence.md.col.time'),
        l('evidence.md.col.gate'),
        l('evidence.md.col.decision'),
        l('evidence.md.col.mode'),
        l('evidence.md.col.role'),
        l('evidence.md.col.person'),
        l('evidence.md.col.reason'),
        l('evidence.md.col.input'),
        l('evidence.md.col.waited'),
      ],
      source.decisions.map((d) => [
        c(d.created_at.toISOString()),
        c(d.gate),
        c(d.decision),
        c(d.oversight_mode),
        c(d.approver_role),
        d.actor_type === 'system' ? l('evidence.md.platform') : person(d.decided_by),
        c(d.reason_ref ? `${d.reason_code ?? ''} ${d.reason_ref}`.trim() : d.reason_code),
        c(d.input_sha256),
        c(d.waited_seconds),
      ]),
      none,
    ),
    `## ${l('evidence.md.section.escalations')}`,
    '',
    ...table(
      [
        l('evidence.md.col.code'),
        l('evidence.md.col.trigger'),
        l('evidence.md.col.route'),
        l('evidence.md.col.severity'),
        l('evidence.md.col.level'),
        l('evidence.md.col.status'),
        l('evidence.md.col.decision'),
        l('evidence.md.col.time'),
      ],
      source.escalations.map((e) => [
        c(e.code),
        c(e.trigger),
        c(e.route),
        c(e.severity),
        c(e.response_level),
        c(e.status),
        c(typeof e.decision?.decision === 'string' ? e.decision.decision : null),
        c(e.created_at.toISOString()),
      ]),
      none,
    ),
    `## ${l('evidence.md.section.cost')}`,
    '',
    ...table(
      [l('evidence.md.col.item'), l('evidence.md.col.value')],
      [
        [l('evidence.md.cost.calls'), c(source.cost.calls)],
        [l('evidence.md.cost.input_tokens'), c(source.cost.inputTokens)],
        [l('evidence.md.cost.output_tokens'), c(source.cost.outputTokens)],
        [l('evidence.md.cost.cached_input_tokens'), c(source.cost.cachedInputTokens)],
        [l('evidence.md.cost.cost_usd'), c(source.cost.costUsd)],
        [l('evidence.md.cost.wasted_tokens'), c(source.cost.wastedTokens)],
        [l('evidence.md.cost.wasted_cost_usd'), c(source.cost.wastedCostUsd)],
      ],
      none,
    ),
    '---',
    '',
    l('evidence.md.footer'),
    '',
  ];
  return lines.join('\n');
}
