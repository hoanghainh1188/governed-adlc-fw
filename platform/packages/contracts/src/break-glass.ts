// Break-glass: audited emergency access for one intent in a production P0 incident (task H08,
// design/ADR-M111, handbook Ch.6 §6.9; QUESTIONS #741–#744).

/**
 * What a grant may change (ADR-M111 §2.2). A closed list: a project allows a subset
 * (`break_glass.allowed_scopes`), and a scope only removes waiting that is not a safety control.
 */
export const BREAK_GLASS_SCOPES = ['runner_priority', 'budget', 'hotl_window_skip'] as const;
export type BreakGlassScope = (typeof BREAK_GLASS_SCOPES)[number];

/** Grant states (ADR-M111 §2.5); a database trigger allows only these moves. */
export const BREAK_GLASS_STATUSES = [
  'requested',
  'active',
  'refused',
  'revoked',
  'expired',
  'lapsed',
] as const;
export type BreakGlassStatus = (typeof BREAK_GLASS_STATUSES)[number];
