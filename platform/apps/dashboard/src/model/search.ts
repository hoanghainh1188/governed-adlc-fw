// The intent search of the board (task X08a PR 2, design/ADR-M109 §2.1): the filters live in the
// URL (`#/intents?q=…&gate=G3`), so a search can be shared. Each value is checked like the API
// checks it; a value that does not pass is left out, never sent.

/** The filters of `GET /v1/intents` the board offers, as the URL and the API name them. */
export interface IntentSearch {
  readonly q?: string;
  readonly gate?: string;
  readonly risk_tier?: string;
  readonly created_from?: string;
  readonly created_to?: string;
  readonly closed_from?: string;
  readonly closed_to?: string;
  readonly sealed?: 'true' | 'false';
}

export const SEARCH_KEYS = [
  'q',
  'gate',
  'risk_tier',
  'created_from',
  'created_to',
  'closed_from',
  'closed_to',
  'sealed',
] as const;
export type SearchKey = (typeof SEARCH_KEYS)[number];

export const GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as const;
export const RISKS = ['low', 'medium', 'high', 'critical'] as const;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 200;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real `YYYY-MM-DD` day (UTC). */
export function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const at = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

/** A search text the API accepts, trimmed; undefined otherwise. */
export function searchText(value: string | null | undefined): string | undefined {
  const text = value?.trim() ?? '';
  return text.length >= SEARCH_MIN && text.length <= SEARCH_MAX ? text : undefined;
}

/** The valid filters of a URL query; anything else is left out. */
export function searchOf(query: URLSearchParams): IntentSearch {
  const out: Record<string, string> = {};
  const q = searchText(query.get('q'));
  if (q !== undefined) out.q = q;
  const gate = query.get('gate');
  if (gate && (GATES as readonly string[]).includes(gate)) out.gate = gate;
  const risk = query.get('risk_tier');
  if (risk && (RISKS as readonly string[]).includes(risk)) out.risk_tier = risk;
  for (const key of ['created_from', 'created_to', 'closed_from', 'closed_to'] as const) {
    const day = query.get(key);
    if (day && isDay(day)) out[key] = day;
  }
  const sealed = query.get('sealed');
  if (sealed === 'true' || sealed === 'false') out.sealed = sealed;
  return out;
}

/** True when at least one filter is set: the board then shows the matching intents as a list. */
export function isSearching(search: IntentSearch): boolean {
  return SEARCH_KEYS.some((key) => search[key] !== undefined);
}
