// B06: settings of the worker process (design/ADR-M27 §2.5). No secret from the environment.
import { describe, expect, it } from 'vitest';

import { loadSettings, SettingsError } from '../../apps/worker/src/settings.js';

describe('worker settings', () => {
  it('has defaults for the Compose deployment', () => {
    expect(loadSettings({})).toEqual({
      database: {
        kind: 'openbao',
        host: 'postgres',
        port: 5432,
        name: 'platform',
        secretPath: 'worker/database',
      },
      githubApiUrl: 'https://api.github.com',
      tickMs: 1000,
      maxConcurrentPolls: 4,
      maxReplyAttempts: 5,
      maxEventAttempts: 3,
      heartbeatFile: '/tmp/sdlc-worker.heartbeat',
      escalationTickMs: 15_000,
      escalationBatch: 100,
      temporal: { address: 'temporal:7233', namespace: 'default' },
      reconcileMs: 600_000,
      reconcileBatch: 500,
      workflowBundle: null,
      runs: null,
      costSync: {
        intervalMs: 300_000,
        lookbackMs: 7_200_000,
        catchUpMs: 86_400_000,
        settleMs: 1_800_000,
      },
      evaluation: { tickMs: 15_000, maxInFlight: 2, tasksDir: '/app/eval-tasks' },
      evidence: {
        url: 'http://seaweedfs:8333',
        bucket: 'evidence',
        secretPath: 'worker/evidence',
        maxItemBytes: 256 * 1024 * 1024,
      },
      retention: {
        url: 'http://seaweedfs:8333',
        bucket: 'evidence',
        secretPath: 'worker/purge',
        mode: 'report',
        intervalMs: 3_600_000,
        batch: 200,
        guardPercent: 20,
        guardFloor: 20,
        archiveGraceDays: 7,
        clientDeletionGraceDays: 14,
        orphanGraceHours: 24,
      },
      anchor: {
        url: 'http://seaweedfs:8333',
        bucket: 'audit-anchors',
        secretPath: 'worker/anchor',
        intervalMs: 3_600_000,
      },
      // O04 (ADR-M103): the session tables, in the retention loop; on by default.
      housekeeping: { mode: 'remove', sessionDays: 30, challengeHours: 24, intervalMs: 3_600_000 },
      // E08: off unless up.sh (profile observability) or .env sets it.
      langfuse: null,
      // X04 PR 3a: off unless up.sh (profile knowledge) or .env sets it.
      knowledge: null,
    });
  });

  it('O04: housekeeping of the session tables: modes, keep times with their floors, off', () => {
    expect(
      loadSettings({
        SDLC_WORKER_HOUSEKEEPING_MODE: 'report',
        SDLC_WORKER_SESSION_KEEP_DAYS: '7',
        SDLC_WORKER_CHALLENGE_KEEP_HOURS: '1',
        SDLC_WORKER_RETENTION_INTERVAL_MINUTES: '15',
      }).housekeeping,
    ).toEqual({ mode: 'report', sessionDays: 7, challengeHours: 1, intervalMs: 900_000 });
    expect(loadSettings({ SDLC_WORKER_HOUSEKEEPING_MODE: 'off' }).housekeeping).toBeNull();
    // Runs without the evidence identities too: retention off leaves it on.
    expect(loadSettings({ SDLC_WORKER_RETENTION_URL: 'off' }).housekeeping?.mode).toBe('remove');
    for (const bad of [
      { SDLC_WORKER_SESSION_KEEP_DAYS: '6' },
      { SDLC_WORKER_CHALLENGE_KEEP_HOURS: '0' },
      { SDLC_WORKER_HOUSEKEEPING_MODE: 'purge' },
    ]) {
      expect(() => loadSettings(bad), JSON.stringify(bad)).toThrow(SettingsError);
    }
  });

  it('E08: the Langfuse purge (origins, the worker KV path, limits; off by default)', () => {
    expect(
      loadSettings({
        SDLC_WORKER_LANGFUSE_URL: 'http://langfuse-web:3000',
        SDLC_WORKER_LANGFUSE_RAW_MAX_AGE_HOURS: '1',
      }).langfuse,
    ).toEqual({
      url: 'http://langfuse-web:3000',
      secretPath: 'worker/langfuse',
      projectId: 'sdlc-platform',
      clickhouseUrl: 'http://clickhouse:8123',
      batch: 50,
      rawUrl: 'http://seaweedfs:8333',
      rawBucket: 'langfuse',
      rawMaxAgeHours: 1,
      rawBatch: 2000,
    });
    expect(
      loadSettings({
        SDLC_WORKER_LANGFUSE_URL: 'https://lf.example:8443',
        SDLC_WORKER_LANGFUSE_SECRET_PATH: 'worker/langfuse-2',
        SDLC_WORKER_LANGFUSE_PROJECT_ID: 'other-project',
        SDLC_WORKER_LANGFUSE_CLICKHOUSE_URL: 'http://ch:8123',
        SDLC_WORKER_LANGFUSE_BATCH: '10',
        SDLC_WORKER_LANGFUSE_RAW_URL: 'http://store:9000',
        SDLC_WORKER_LANGFUSE_RAW_BUCKET: 'lf-test',
        SDLC_WORKER_LANGFUSE_RAW_BATCH: '5',
      }).langfuse,
    ).toMatchObject({
      url: 'https://lf.example:8443',
      secretPath: 'worker/langfuse-2',
      projectId: 'other-project',
      clickhouseUrl: 'http://ch:8123',
      batch: 10,
      rawUrl: 'http://store:9000',
      rawBucket: 'lf-test',
      rawMaxAgeHours: 24,
      rawBatch: 5,
    });
    expect(loadSettings({ SDLC_WORKER_LANGFUSE_URL: 'off' }).langfuse).toBeNull();
    for (const [name, value] of [
      ['SDLC_WORKER_LANGFUSE_URL', 'http://langfuse-web:3000/path'],
      ['SDLC_WORKER_LANGFUSE_URL', 'http://user:pw@langfuse-web:3000'],
      ['SDLC_WORKER_LANGFUSE_CLICKHOUSE_URL', 'http://ch:8123/?user=x'],
      ['SDLC_WORKER_LANGFUSE_SECRET_PATH', 'api/langfuse'],
      ['SDLC_WORKER_LANGFUSE_RAW_MAX_AGE_HOURS', '0'],
      ['SDLC_WORKER_LANGFUSE_RAW_MAX_AGE_HOURS', '721'],
      ['SDLC_WORKER_LANGFUSE_RAW_BATCH', '0'],
      ['SDLC_WORKER_LANGFUSE_BATCH', '1001'],
      ['SDLC_WORKER_LANGFUSE_RAW_BUCKET', 'Bad_Bucket'],
      ['SDLC_WORKER_LANGFUSE_PROJECT_ID', 'a b'],
    ] as const) {
      expect(
        () => loadSettings({ SDLC_WORKER_LANGFUSE_URL: 'http://langfuse-web:3000', [name]: value }),
        `${name}=${value}`,
      ).toThrow(SettingsError);
    }
  });

  it('E05 PR 2: the audit anchor (an origin, the worker KV path, the loop interval; off)', () => {
    expect(
      loadSettings({
        SDLC_WORKER_ANCHOR_URL: 'http://store:9000',
        SDLC_WORKER_ANCHOR_BUCKET: 'anchors-test',
        SDLC_WORKER_ANCHOR_SECRET_PATH: 'worker/anchor-2',
        SDLC_WORKER_RETENTION_URL: 'off',
        SDLC_WORKER_RETENTION_INTERVAL_MINUTES: '15',
      }).anchor,
    ).toEqual({
      url: 'http://store:9000',
      bucket: 'anchors-test',
      secretPath: 'worker/anchor-2',
      intervalMs: 900_000,
    });
    expect(loadSettings({ SDLC_WORKER_ANCHOR_URL: 'off' }).anchor).toBeNull();
    for (const [name, value] of [
      ['SDLC_WORKER_ANCHOR_URL', 'http://store:9000/path'],
      ['SDLC_WORKER_ANCHOR_URL', 'http://user:pw@store:9000'],
      ['SDLC_WORKER_ANCHOR_BUCKET', 'Bad_Bucket'],
      ['SDLC_WORKER_ANCHOR_SECRET_PATH', 'api/anchor'],
    ] as const) {
      expect(() => loadSettings({ [name]: value })).toThrow(SettingsError);
    }
  });

  it('C12: the spend sync window holds two passes at least and the catch-up covers the look-back', () => {
    expect(
      loadSettings({
        SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS: '600',
        SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES: '20',
        SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES: '20',
        SDLC_WORKER_COST_SYNC_SETTLE_MINUTES: '5',
      }).costSync,
    ).toEqual({
      intervalMs: 600_000,
      lookbackMs: 1_200_000,
      catchUpMs: 1_200_000,
      settleMs: 300_000,
    });
    // L04: the evaluation loop (ADR-M81 §2.8).
    expect(
      loadSettings({
        SDLC_WORKER_EVAL_TICK_SECONDS: '30',
        SDLC_WORKER_EVAL_MAX_IN_FLIGHT: '4',
      }).evaluation,
    ).toEqual({ tickMs: 30_000, maxInFlight: 4, tasksDir: '/app/eval-tasks' });
    expect(() => loadSettings({ SDLC_WORKER_EVAL_MAX_IN_FLIGHT: '0' })).toThrow(
      expect.objectContaining({ setting: 'SDLC_WORKER_EVAL_MAX_IN_FLIGHT' }),
    );
    expect(() =>
      loadSettings({
        SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS: '600',
        SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES: '19',
      }),
    ).toThrow(expect.objectContaining({ setting: 'SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES' }));
    expect(() =>
      loadSettings({
        SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES: '120',
        SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES: '119',
      }),
    ).toThrow(expect.objectContaining({ setting: 'SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES' }));
  });

  it('E03: the evidence store for G8 (an origin, the worker KV path, a size cap; off)', () => {
    expect(loadSettings({ SDLC_WORKER_EVIDENCE_URL: 'off' }).evidence).toBeNull();
    expect(
      loadSettings({
        SDLC_WORKER_EVIDENCE_URL: 'http://seaweedfs:8333/',
        SDLC_WORKER_EVIDENCE_MAX_ITEM_MB: '8',
      }).evidence,
    ).toMatchObject({ url: 'http://seaweedfs:8333', maxItemBytes: 8 * 1024 * 1024 });
    for (const env of [
      { SDLC_WORKER_EVIDENCE_URL: 'http://seaweedfs:8333/evidence' },
      { SDLC_WORKER_EVIDENCE_URL: 'http://user:pw@seaweedfs:8333' },
      { SDLC_WORKER_EVIDENCE_URL: 'ftp://seaweedfs' },
      // The worker AppRole reads kv/data/worker/* only.
      { SDLC_WORKER_EVIDENCE_SECRET_PATH: 'api/evidence' },
      { SDLC_WORKER_EVIDENCE_MAX_ITEM_MB: '0' },
      { SDLC_WORKER_EVIDENCE_BUCKET: 'Evidence' },
    ]) {
      expect(() => loadSettings(env), JSON.stringify(env)).toThrow(
        expect.objectContaining({ key: 'worker.settings.invalid' }),
      );
    }
  });

  it('C06 session 2: agent runs need both files of the cost-controller AppRole', () => {
    const files = {
      SDLC_WORKER_COST_ROLE_ID_FILE: '/run/sdlc/cost-approle/role_id',
      SDLC_WORKER_COST_SECRET_ID_FILE: '/run/sdlc/cost-approle/secret_id',
    };
    expect(loadSettings(files).runs).toEqual({
      costRoleIdFile: '/run/sdlc/cost-approle/role_id',
      costSecretIdFile: '/run/sdlc/cost-approle/secret_id',
      costMasterKeyPath: 'cost-controller/litellm-master-key',
      litellmUrl: 'http://litellm:4000',
      egressAllowlist: ['litellm:4000', 'npm-proxy:4873'],
    });
    expect(() =>
      loadSettings({ SDLC_WORKER_COST_ROLE_ID_FILE: files.SDLC_WORKER_COST_ROLE_ID_FILE }),
    ).toThrow(expect.objectContaining({ key: 'worker.settings.cost_role_incomplete' }));
    // The AppRole reads its own paths only; the egress list names services with ports.
    for (const bad of [
      { SDLC_WORKER_COST_MASTER_KEY_PATH: 'worker/litellm-master-key' },
      { SDLC_WORKER_RUN_EGRESS: 'litellm' },
      { SDLC_WORKER_RUN_EGRESS: 'api.github.com:443,x' },
      { SDLC_WORKER_LITELLM_URL: 'http://user:pw@litellm:4000' },
    ]) {
      expect(() => loadSettings({ ...files, ...bad })).toThrow(
        expect.objectContaining({ key: 'worker.settings.invalid' }),
      );
    }
  });

  it('B07: the intent workflow can be turned off in development mode only', () => {
    const dev = { SDLC_WORKER_DEV_MODE: '1', SDLC_WORKER_DEV_DB_URL: 'postgres://x/y' };
    expect(loadSettings({ ...dev, SDLC_WORKER_TEMPORAL_ADDRESS: 'off' }).temporal).toBeNull();
    expect(() => loadSettings({ SDLC_WORKER_TEMPORAL_ADDRESS: 'off' })).toThrow(
      expect.objectContaining({ key: 'worker.settings.temporal_off_in_production' }),
    );
    expect(
      loadSettings({ SDLC_WORKER_WORKFLOW_BUNDLE: '/app/dist/workflow-bundle.js' }).workflowBundle,
    ).toBe('/app/dist/workflow-bundle.js');
  });

  it.each([
    ['SDLC_WORKER_DB_SECRET_PATH', 'api/database'],
    ['SDLC_WORKER_GITHUB_API_URL', 'http://api.github.com'],
    ['SDLC_WORKER_TICK_MS', '10'],
    ['SDLC_WORKER_MAX_CONCURRENT_POLLS', '0'],
    ['SDLC_WORKER_DB_PORT', 'x'],
    ['SDLC_WORKER_MAX_EVENT_ATTEMPTS', '0'],
    ['SDLC_WORKER_ESCALATION_TICK_MS', '10'],
    ['SDLC_WORKER_ESCALATION_BATCH', '0'],
    ['SDLC_WORKER_TEMPORAL_ADDRESS', 'temporal'],
    ['SDLC_WORKER_TEMPORAL_NAMESPACE', 'a/b'],
    ['SDLC_WORKER_RECONCILE_MS', '100'],
    ['SDLC_WORKER_RECONCILE_BATCH', '0'],
    ['SDLC_WORKER_WORKFLOW_BUNDLE', 'relative.js'],
    ['SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS', '29'],
    ['SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS', '3601'],
    ['SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES', '9'],
    ['SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES', '1441'],
    ['SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES', '10081'],
    ['SDLC_WORKER_COST_SYNC_SETTLE_MINUTES', '4'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => loadSettings({ [name]: value })).toThrow(
      expect.objectContaining({ key: 'worker.settings.invalid', setting: name }),
    );
  });

  it('dev mode needs a URL and is refused in production', () => {
    expect(() => loadSettings({ SDLC_WORKER_DEV_MODE: '1' })).toThrow(SettingsError);
    expect(
      loadSettings({ SDLC_WORKER_DEV_MODE: '1', SDLC_WORKER_DEV_DB_URL: 'postgres://x/y' })
        .database,
    ).toEqual({ kind: 'dev_url', url: 'postgres://x/y' });
    expect(() =>
      loadSettings({
        SDLC_WORKER_DEV_MODE: '1',
        SDLC_WORKER_DEV_DB_URL: 'postgres://x/y',
        NODE_ENV: 'production',
      }),
    ).toThrow(expect.objectContaining({ key: 'worker.settings.dev_mode_in_production' }));
  });
});
