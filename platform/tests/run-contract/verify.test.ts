// D-08 C02 AC2 (without a database): the runner refuses a malformed or badly signed contract
// before it touches the database, so a forged tenant ID never reaches it (ADR-M22 section 2.4).
// The other reject reasons need the stored contract: tests/integration/db/runs.test.ts.
import { describe, expect, it } from 'vitest';

import type { PlatformDatabase } from '../../packages/core/src/db/platform-database.js';
import {
  RUN_CONTRACT_REJECT_MESSAGES,
  runContractBytes,
  verifyRunContract,
} from '../../packages/core/src/run-contract/index.js';
import { contract, FakeTransit, SAMPLE_CONTRACT } from './helpers';

/** Any access to this database fails the test. */
const untouchable = new Proxy({} as PlatformDatabase, {
  get: (_target, prop) => {
    throw new Error(`database touched: ${String(prop)}`);
  },
});

describe('verifyRunContract before the database (AC2)', () => {
  it('refuses a malformed envelope', async () => {
    const transit = new FakeTransit();
    for (const envelope of [
      null,
      'contract',
      { contract: { ...SAMPLE_CONTRACT, extra: 1 }, signature: 'vault:v1:QUJD' },
      { contract: SAMPLE_CONTRACT, signature: 'not a signature' },
    ]) {
      expect(await verifyRunContract(untouchable, envelope, { verifier: transit })).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('refuses a changed field, a signature of another key and a garbage signature', async () => {
    const transit = new FakeTransit();
    const other = new FakeTransit();
    const { signature } = await transit.sign(runContractBytes(SAMPLE_CONTRACT));
    const { signature: foreign } = await other.sign(runContractBytes(SAMPLE_CONTRACT));
    for (const envelope of [
      { contract: contract({ max_budget_usd: '200' }), signature },
      { contract: contract({ tenant_id: '99999999-9999-4999-8999-999999999999' }), signature },
      { contract: SAMPLE_CONTRACT, signature: foreign },
      { contract: SAMPLE_CONTRACT, signature: 'vault:v1:QUJD' },
      { contract: SAMPLE_CONTRACT, signature: signature.replace('vault:v1:', 'vault:v7:') },
    ]) {
      expect(await verifyRunContract(untouchable, envelope, { verifier: transit })).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
    }
  });

  it('has a catalog message for every reject reason', () => {
    expect(Object.keys(RUN_CONTRACT_REJECT_MESSAGES)).toHaveLength(10);
  });
});
