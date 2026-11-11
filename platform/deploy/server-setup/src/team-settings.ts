// The settings of steps 8–13 of `pnpm server:setup` (D-08 V19, QUESTIONS #671): the tenant and its
// first admin (step 8), the project file of `adlc admin project apply` (V17: steps 9, 11, 12), the
// sandbox image by digest (step 10) and, optionally, the project AI record (step 13). None is a
// secret. All four of `tenant`, `admin`, `project_file` and `sandbox_image`, or none of them. Pure.
import { absolutePath, list, mapping, SettingsError, text, type Mapping } from './settings.js';

/** The codes of `adlc ops ai-record set` (`@sdlc/contracts`; a test keeps them equal). */
export const AI_ALLOWED = ['no', 'yes', 'yes_with_conditions'] as const;
export const PROD_LOGS = ['no', 'yes_masked'] as const;
export const DISCLOSURES = ['client_format', 'standard_note'] as const;
export const AI_RECORD_CLASSES = [
  'public',
  'internal',
  'client_confidential',
  'client_restricted',
  'prohibited',
] as const;

/** The client's consent (handbook Ch.2 §2.5), written on behalf of Person A (QUESTIONS #671). */
export interface AiRecordSettings {
  readonly aiAllowed: (typeof AI_ALLOWED)[number];
  readonly classes: readonly (typeof AI_RECORD_CLASSES)[number][];
  readonly prodLogs: (typeof PROD_LOGS)[number];
  readonly disclosure: (typeof DISCLOSURES)[number];
}

export interface TeamSettings {
  readonly tenant: { readonly slug: string; readonly name: string };
  readonly admin: { readonly email: string; readonly name: string };
  /** The V17 project file (`project.example.yaml`): project, team, agent, configuration. */
  readonly projectFile: string;
  /** `sandbox.image` of the project configuration: an image by digest (README step 10). */
  readonly sandboxImage: string;
  readonly aiRecord?: AiRecordSettings;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IMAGE = /^[a-z0-9][a-z0-9._/:-]{0,250}@sha256:[0-9a-f]{64}$/;
const KEYS = ['tenant', 'admin', 'project_file', 'sandbox_image'] as const;

function oneOf<T extends string>(map: Mapping, key: string, field: string, codes: readonly T[]): T {
  const value = text(map, key, field);
  if (!codes.includes(value as T)) throw new SettingsError(field);
  return value as T;
}

function aiRecord(value: unknown): AiRecordSettings {
  const r = mapping(value, 'ai_record');
  const classes = list(r.classes, 'ai_record.classes').map((c, i) => {
    if (!AI_RECORD_CLASSES.includes(c as (typeof AI_RECORD_CLASSES)[number]))
      throw new SettingsError(`ai_record.classes[${i}]`);
    return c as (typeof AI_RECORD_CLASSES)[number];
  });
  if (new Set(classes).size !== classes.length) throw new SettingsError('ai_record.classes');
  return {
    aiAllowed: oneOf(r, 'ai_allowed', 'ai_record.ai_allowed', AI_ALLOWED),
    classes,
    prodLogs: oneOf(r, 'prod_logs', 'ai_record.prod_logs', PROD_LOGS),
    disclosure: oneOf(r, 'disclosure', 'ai_record.disclosure', DISCLOSURES),
  };
}

/** The steps 8–13 part of the settings, or undefined without any of its keys. */
export function teamSettings(root: Mapping, home: string): TeamSettings | undefined {
  const given = KEYS.filter((k) => root[k] !== undefined);
  if (given.length === 0) {
    if (root.ai_record !== undefined) throw new SettingsError('ai_record');
    return undefined;
  }
  const missing = KEYS.find((k) => root[k] === undefined);
  if (missing) throw new SettingsError(missing);
  const tenant = mapping(root.tenant, 'tenant');
  const admin = mapping(root.admin, 'admin');
  const record = root.ai_record === undefined ? undefined : aiRecord(root.ai_record);
  return {
    tenant: {
      slug: text(tenant, 'slug', 'tenant.slug', SLUG),
      name: text(tenant, 'name', 'tenant.name'),
    },
    admin: {
      email: text(admin, 'email', 'admin.email', EMAIL),
      name: text(admin, 'name', 'admin.name'),
    },
    projectFile: absolutePath(root, 'project_file', 'project_file', home),
    sandboxImage: text(root, 'sandbox_image', 'sandbox_image', IMAGE),
    ...(record ? { aiRecord: record } : {}),
  };
}
