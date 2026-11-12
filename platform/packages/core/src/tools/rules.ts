// Formats and lifecycle rules of the tool register (design/ADR-M69 §2.2, D-05 section 6.1). The
// status moves are those of the agent register (ADR-M31 §2.3); the database trigger of migration
// 0038 enforces them too. They are here so that refusals get a clear code first.
import { defaultProjectConfig } from '@sdlc/config';
import {
  BACKING_SERVICE_PATTERN,
  DATA_CLASSES,
  IMAGE_DIGEST_PATTERN,
  isToolPermission,
  TOOL_KEY_PATTERN,
  TOOL_TRANSPORTS,
  type DataClass,
  type ToolPermission,
  type ToolStatus,
  type ToolTransport,
} from '@sdlc/contracts';

import { AGENT_VERSION_PATTERN, MODEL_REF_PATTERN } from '../agents/rules.js';
import { ToolRegisterError } from './errors.js';

/** The image name without digest; the digest is its own field (R038). */
export const IMAGE_REF_PATTERN = /^[a-z0-9][a-z0-9._/:-]{0,254}$/;

export const TOOL_STATUS_MOVES: Readonly<Record<ToolStatus, readonly ToolStatus[]>> = {
  proposed: ['active', 'retired'],
  active: ['suspended', 'quarantined', 'retired'],
  suspended: ['active', 'quarantined', 'retired'],
  quarantined: ['suspended', 'retired'],
  retired: [],
};

/** Statuses in which the configuration may change, with a new version. */
export const TOOL_CHANGEABLE_STATUSES: readonly ToolStatus[] = ['proposed', 'suspended'];

/** Why a tool is suspended, quarantined or retired. The agent register's codes. */
export { AGENT_STATUS_REASONS as TOOL_STATUS_REASONS } from '../agents/rules.js';

function invalid(field: string): never {
  throw new ToolRegisterError('invalid_input', `tool field ${field} is not valid`, field);
}

export function checkToolKey(value: string): void {
  if (!TOOL_KEY_PATTERN.test(value)) invalid('tool_key');
}

export function checkToolVersion(value: string): void {
  if (!AGENT_VERSION_PATTERN.test(value)) invalid('version');
}

export function checkTransport(value: string): ToolTransport {
  if (!(TOOL_TRANSPORTS as readonly string[]).includes(value)) invalid('transport');
  return value as ToolTransport;
}

export function checkImageRef(value: string): string {
  if (!IMAGE_REF_PATTERN.test(value)) invalid('image_ref');
  return value;
}

export function checkImageDigest(value: string): string {
  if (!IMAGE_DIGEST_PATTERN.test(value)) invalid('image_digest');
  return value;
}

/** Codes of the catalogue in `@sdlc/contracts`, at least one; sorted and unique. */
export function checkPermissions(values: readonly string[]): ToolPermission[] {
  if (values.length === 0 || values.length > 10 || !values.every(isToolPermission)) {
    invalid('permissions');
  }
  // X06 (ADR-M108 §2.8): a tool reads one index with one login, never both.
  if (values.includes('read_code') && values.includes('read_documents')) invalid('permissions');
  return [...new Set(values)].sort();
}

/** Data classes the tool may see; never `prohibited` (D-07 §4). Sorted and unique. */
export function checkDataClasses(values: readonly string[]): DataClass[] {
  if (
    values.some(
      (value) => value === 'prohibited' || !(DATA_CLASSES as readonly string[]).includes(value),
    )
  ) {
    invalid('allowed_data_classes');
  }
  return [...new Set(values as readonly DataClass[])].sort();
}

/** `alias:port` entries, at most 10; sorted and unique. */
export function checkBackingServices(values: readonly string[]): string[] {
  if (values.length > 10 || values.some((value) => !BACKING_SERVICE_PATTERN.test(value))) {
    invalid('backing_services');
  }
  return [...new Set(values)].sort();
}

/** A pinned gateway model name, as for agents (ADR-M31 §2.4): a digit, never `latest`. */
export function checkToolModelRef(value: string): string {
  if (!MODEL_REF_PATTERN.test(value) || !/[0-9]/.test(value) || /latest/i.test(value)) {
    invalid('model_ref');
  }
  return value;
}

/**
 * The fields of a tool as a whole (ADR-M69 §2.2, §2.5): an `http` tool has an image; a `stdio`
 * tool has no image, no digest and no backing service.
 */
export function checkShape(tool: {
  readonly transport: ToolTransport;
  readonly imageRef: string | null;
  readonly imageDigest: string | null;
  readonly backingServices: readonly string[];
}): void {
  if (tool.transport === 'http' && tool.imageRef === null) invalid('image_ref');
  if (tool.transport === 'stdio') {
    if (tool.imageRef !== null) invalid('image_ref');
    if (tool.imageDigest !== null) invalid('image_digest');
    if (tool.backingServices.length > 0) invalid('backing_services');
  }
}

/**
 * The recertification age of a tool in a tenant-wide list: the configuration default (a tool
 * belongs to the tenant, not to a project). G4 uses the project's own value.
 */
export function defaultToolRecertificationMonths(): number {
  return defaultProjectConfig().tools.recertification_months;
}
