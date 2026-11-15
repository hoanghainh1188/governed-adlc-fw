// B03 api settings (ADR-M26 section 2.6): defaults, OpenBao by default, dev mode never in production.
import { describe, expect, it } from 'vitest';

import { loadSettings, SettingsError } from '../../apps/api/src/settings.js';

describe('api settings', () => {
  it('defaults: OpenBao for the database password, 127.0.0.1:8080', () => {
    expect(loadSettings({})).toEqual({
      host: '127.0.0.1',
      port: 8080,
      database: {
        kind: 'openbao',
        host: 'postgres',
        port: 5432,
        name: 'platform',
        secretPath: 'api/database',
      },
      rateLimitPerMinute: 120,
      authFailuresPerMinute: 10,
      temporal: { address: 'temporal:7233', namespace: 'default' },
      githubApiUrl: 'https://api.github.com',
      dashboardDir: null,
      webSignIn: null,
      trustedProxy: null,
      // O08 (ADR-M112 §2.7): webhooks off by default.
      githubWebhooks: null,
      evidence: {
        url: 'http://seaweedfs:8333',
        bucket: 'evidence',
        secretPath: 'api/evidence',
        maxItemBytes: 256 * 1024 * 1024,
      },
    });
  });

  it('V09: SDLC_API_TRUSTED_PROXY is one IPv4 address or empty (ADR-M67 §2.5)', () => {
    expect(loadSettings({ SDLC_API_TRUSTED_PROXY: '172.30.1.6' }).trustedProxy).toBe('172.30.1.6');
    expect(loadSettings({ SDLC_API_TRUSTED_PROXY: '' }).trustedProxy).toBeNull();
    for (const value of [
      '172.30.1.0/29',
      '0.0.0.0/0',
      '172.30.1.6,172.30.1.5',
      'sdlc-access',
      '256.1.1.1',
      '01.2.3.4',
      '::1',
      'true',
    ]) {
      expect(() => loadSettings({ SDLC_API_TRUSTED_PROXY: value }), value).toThrowError(
        SettingsError,
      );
    }
  });

  it('E02: the evidence store is an origin, a bucket and a path under api/; off turns it off', () => {
    expect(loadSettings({ SDLC_API_EVIDENCE_URL: 'off' }).evidence).toBeNull();
    expect(
      loadSettings({
        SDLC_API_EVIDENCE_URL: 'https://s3.internal:8443',
        SDLC_API_EVIDENCE_BUCKET: 'packs-1',
        SDLC_API_EVIDENCE_SECRET_PATH: 'api/evidence2',
        SDLC_API_EVIDENCE_MAX_ITEM_MB: '8',
      }).evidence,
    ).toEqual({
      url: 'https://s3.internal:8443',
      bucket: 'packs-1',
      secretPath: 'api/evidence2',
      maxItemBytes: 8 * 1024 * 1024,
    });
    for (const [name, value] of [
      ['SDLC_API_EVIDENCE_URL', 'http://user:pass@seaweedfs:8333'],
      ['SDLC_API_EVIDENCE_URL', 'http://seaweedfs:8333/evidence'],
      ['SDLC_API_EVIDENCE_URL', 'file:///tmp'],
      ['SDLC_API_EVIDENCE_BUCKET', 'Evidence_1'],
      // The AppRole "api" reads kv/data/api/* only: another path is a mistake.
      ['SDLC_API_EVIDENCE_SECRET_PATH', 'runner/evidence'],
      ['SDLC_API_EVIDENCE_MAX_ITEM_MB', '0'],
    ] as const) {
      expect(() => loadSettings({ [name]: value }), `${name}=${value}`).toThrowError(
        expect.objectContaining({ key: 'api.settings.invalid', setting: name }),
      );
    }
  });

  it('B08: the GitHub API URL of the spec endpoints is https only', () => {
    expect(
      loadSettings({ SDLC_API_GITHUB_API_URL: 'https://ghe.example.test/api/v3' }).githubApiUrl,
    ).toBe('https://ghe.example.test/api/v3');
  });

  it('B07: the intent workflow signals can be turned off in development mode only', () => {
    const dev = { SDLC_API_DEV_MODE: '1', SDLC_API_DEV_DB_URL: 'postgres://x/platform' };
    expect(loadSettings({ ...dev, SDLC_API_TEMPORAL_ADDRESS: 'off' }).temporal).toBeNull();
    expect(() => loadSettings({ SDLC_API_TEMPORAL_ADDRESS: 'off' })).toThrowError(
      expect.objectContaining({ key: 'api.settings.temporal_off_in_production' }),
    );
    expect(
      loadSettings({
        SDLC_API_TEMPORAL_ADDRESS: 'tmp.internal:7300',
        SDLC_API_TEMPORAL_NAMESPACE: 'sdlc',
      }).temporal,
    ).toEqual({ address: 'tmp.internal:7300', namespace: 'sdlc' });
  });

  it('dev mode takes a URL, and is refused in production', () => {
    expect(
      loadSettings({ SDLC_API_DEV_MODE: '1', SDLC_API_DEV_DB_URL: 'postgres://x/platform' })
        .database,
    ).toEqual({ kind: 'dev_url', url: 'postgres://x/platform' });
    expect(() => loadSettings({ SDLC_API_DEV_MODE: '1' })).toThrow(SettingsError);
    expect(() =>
      loadSettings({
        SDLC_API_DEV_MODE: '1',
        SDLC_API_DEV_DB_URL: 'postgres://x/platform',
        NODE_ENV: 'production',
      }),
    ).toThrowError(expect.objectContaining({ key: 'api.settings.dev_mode_in_production' }));
  });

  it.each([
    ['SDLC_API_PORT', '0'],
    ['SDLC_API_PORT', 'abc'],
    ['SDLC_API_DB_SECRET_PATH', 'worker/database'],
    ['SDLC_API_DB_NAME', 'Platform;drop'],
    ['SDLC_API_DEV_MODE', 'yes'],
    ['SDLC_API_TEMPORAL_ADDRESS', 'http://temporal:7233'],
    ['SDLC_API_TEMPORAL_NAMESPACE', 'a b'],
    ['SDLC_API_GITHUB_API_URL', 'http://api.github.com'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => loadSettings({ [name]: value })).toThrowError(
      expect.objectContaining({ key: 'api.settings.invalid', setting: name }),
    );
  });

  it('U01: the dashboard folder is off by default, else an absolute path', () => {
    expect(loadSettings({ SDLC_API_DASHBOARD_DIR: '/app/dashboard' }).dashboardDir).toBe(
      '/app/dashboard',
    );
    expect(() => loadSettings({ SDLC_API_DASHBOARD_DIR: 'dist' })).toThrow(SettingsError);
  });

  it('U05: GitHub sign-in is off by default; on, it needs a public origin', () => {
    expect(loadSettings({ SDLC_API_WEB_SIGNIN: 'off' }).webSignIn).toBeNull();
    expect(
      loadSettings({
        SDLC_API_WEB_SIGNIN: 'github',
        SDLC_API_PUBLIC_ORIGIN: 'http://localhost:8090',
      }).webSignIn,
    ).toEqual({
      publicOrigin: 'http://localhost:8090',
      callbackUrl: 'http://localhost:8090/v1/auth/github/callback',
      githubWebUrl: 'https://github.com',
      githubApiUrl: 'https://api.github.com',
      oauthSecretPath: 'api/github-oauth',
      idleMs: 30 * 60_000,
      maxAgeMs: 8 * 3_600_000,
      actions: false,
    });
    expect(
      loadSettings({
        SDLC_API_WEB_SIGNIN: 'github',
        SDLC_API_PUBLIC_ORIGIN: 'https://sdlc.example.com',
        SDLC_API_SESSION_IDLE_MINUTES: '15',
        SDLC_API_SESSION_MAX_HOURS: '4',
      }).webSignIn,
    ).toMatchObject({
      publicOrigin: 'https://sdlc.example.com',
      idleMs: 900_000,
      maxAgeMs: 14_400_000,
    });
    expect(() => loadSettings({ SDLC_API_WEB_SIGNIN: 'github' })).toThrowError(
      expect.objectContaining({ key: 'api.settings.public_origin_missing' }),
    );
    for (const origin of [
      'http://127.0.0.1:8090',
      'http://sdlc.example.com',
      'http://192.168.1.10:8090',
    ]) {
      expect(
        () => loadSettings({ SDLC_API_WEB_SIGNIN: 'github', SDLC_API_PUBLIC_ORIGIN: origin }),
        origin,
      ).toThrowError(expect.objectContaining({ key: 'api.settings.public_origin_insecure' }));
    }
  });

  it('U06: dashboard actions are off by default; on, they need the GitHub sign-in and its origin', () => {
    expect(loadSettings({}).webSignIn).toBeNull();
    const on = {
      SDLC_API_WEB_SIGNIN: 'github',
      SDLC_API_PUBLIC_ORIGIN: 'https://sdlc.example.com',
      SDLC_API_DASHBOARD_ACTIONS: 'on',
    };
    expect(loadSettings(on).webSignIn?.actions).toBe(true);
    expect(loadSettings({ ...on, SDLC_API_DASHBOARD_ACTIONS: 'off' }).webSignIn?.actions).toBe(
      false,
    );
    expect(() => loadSettings({ SDLC_API_DASHBOARD_ACTIONS: 'on' })).toThrowError(
      expect.objectContaining({ key: 'api.settings.actions_need_signin' }),
    );
    expect(() =>
      loadSettings({ SDLC_API_WEB_SIGNIN: 'off', SDLC_API_DASHBOARD_ACTIONS: 'on' }),
    ).toThrowError(expect.objectContaining({ key: 'api.settings.actions_need_signin' }));
    // Plain http:// on a host other than localhost, or no origin: refused with actions on too.
    for (const origin of ['http://sdlc.example.com', 'http://127.0.0.1:8090']) {
      expect(() => loadSettings({ ...on, SDLC_API_PUBLIC_ORIGIN: origin }), origin).toThrowError(
        expect.objectContaining({ key: 'api.settings.public_origin_insecure' }),
      );
    }
    expect(() => loadSettings({ ...on, SDLC_API_PUBLIC_ORIGIN: '' })).toThrowError(
      expect.objectContaining({ key: 'api.settings.public_origin_missing' }),
    );
    expect(
      loadSettings({ ...on, SDLC_API_PUBLIC_ORIGIN: 'http://localhost:8090' }).webSignIn?.actions,
    ).toBe(true);
    expect(() => loadSettings({ SDLC_API_DASHBOARD_ACTIONS: 'yes' })).toThrow(SettingsError);
  });

  it.each([
    ['SDLC_API_WEB_SIGNIN', 'oidc'],
    ['SDLC_API_PUBLIC_ORIGIN', 'https://sdlc.example.com/dashboard'],
    ['SDLC_API_GITHUB_WEB_URL', 'http://github.com'],
    ['SDLC_API_GITHUB_OAUTH_SECRET_PATH', 'worker/github-oauth'],
    ['SDLC_API_SESSION_IDLE_MINUTES', '1'],
    ['SDLC_API_SESSION_MAX_HOURS', '48'],
  ])('U05: refuses %s=%s', (name, value) => {
    expect(() => loadSettings({ [name]: value })).toThrowError(
      expect.objectContaining({ key: 'api.settings.invalid', setting: name }),
    );
  });
});
