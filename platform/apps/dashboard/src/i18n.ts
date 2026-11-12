// Every label and message of the dashboard comes from the message catalog (`@sdlc/messages`,
// `dashboard.*` keys, NFR-08), with the catalog's `{name}` placeholders. Server text is never a
// template: it is passed as a parameter or shown as text.
import catalog from 'virtual:dashboard-catalog';

export type Params = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{([a-z_][a-z0-9_]*)\}/g;

export function render(template: string, params: Params = {}): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/** Messages of a chunk loaded later (U09: the administration screens, QUESTIONS #686). */
const later = new Map<string, string>();

export function addMessages(messages: Readonly<Record<string, string>>): void {
  for (const [key, text] of Object.entries(messages)) later.set(key, text);
}

/** A catalog message; a missing key shows itself, so a test can find it. */
export function t(key: string, params: Params = {}): string {
  return render(catalog[key] ?? later.get(key) ?? key, params);
}

/** The browser's locale for numbers and dates; the texts stay English until a catalog exists. */
export const LOCALE = 'en';
