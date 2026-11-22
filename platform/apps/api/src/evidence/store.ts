// The api's evidence store (task E02, ADR-M48 §2.2). The SeaweedFS identity `api-evidence` comes
// from OpenBao (`kv/api/evidence`, written by `openbao:bootstrap api-evidence-credentials`): it may
// read `evidence/proposals/*` and `evidence/diffs/*` (to re-check their hashes) and read and write
// `evidence/packs/*`. A missing credential is a warning at start, not a failure: the pack endpoints
// then answer `evidence_unavailable`.
import { S3EvidenceStore } from '@sdlc/adapter-evidence-s3';
import type { SecretReader } from '@sdlc/contracts';
import type { PlatformLogger } from '@sdlc/core';
import { t } from '@sdlc/messages';
import { SecretsError } from '@sdlc/secrets';

import {
  EVIDENCE_ACCESS_KEY_FIELD,
  EVIDENCE_PACK_KEY_PREFIX,
  EVIDENCE_SECRET_KEY_FIELD,
  type ApiSettings,
} from '../settings.js';

export interface ApiEvidence {
  readonly store: S3EvidenceStore;
  /** U10 (ADR-M113): writes uploaded plans under `evidence/plans/<tenant>/...`. */
  readonly planStore?: S3EvidenceStore;
  readonly maxItemBytes: number;
}

export async function openEvidenceStore(
  settings: ApiSettings['evidence'],
  secrets: SecretReader | undefined,
  log: PlatformLogger,
): Promise<ApiEvidence | undefined> {
  if (!settings) {
    log.log('warn', 'api.evidence_off', { message: t('api.start.evidence_off') });
    return undefined;
  }
  if (!secrets) {
    log.log('warn', 'api.evidence_missing', { message: t('api.start.evidence_missing') });
    return undefined;
  }
  let entry;
  try {
    entry = await secrets.read(settings.secretPath);
  } catch (error) {
    if (!(error instanceof SecretsError) || error.key !== 'secrets.not_found') throw error;
    log.log('warn', 'api.evidence_missing', { message: t('api.start.evidence_missing') });
    return undefined;
  }
  const accessKeyId = entry.data[EVIDENCE_ACCESS_KEY_FIELD];
  const secretAccessKey = entry.data[EVIDENCE_SECRET_KEY_FIELD];
  if (!accessKeyId || !secretAccessKey) {
    log.log('warn', 'api.evidence_missing', { message: t('api.start.evidence_missing') });
    return undefined;
  }
  return {
    store: new S3EvidenceStore({
      endpoint: settings.url,
      bucket: settings.bucket,
      keyPrefix: EVIDENCE_PACK_KEY_PREFIX,
      accessKeyId,
      secretAccessKey,
    }),
    planStore: new S3EvidenceStore({
      endpoint: settings.url,
      bucket: settings.bucket,
      keyPrefix: 'plans/',
      accessKeyId,
      secretAccessKey,
    }),
    maxItemBytes: settings.maxItemBytes,
  };
}
