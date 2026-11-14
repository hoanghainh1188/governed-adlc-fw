// Tracing of the platform processes (D-08 A08 AC2, design/ADR-M35 §2.3–§2.6), and condition 2 of
// the plan approval: http spans record no header and no query string.
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';

import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  activeTraceIds,
  activityTracingInterceptor,
  defaultActivityContext,
  parseOtelEndpoint,
  platformTracer,
  startTracing,
  stripQuery,
  type Tracing,
} from '../../packages/telemetry/src/index.js';
import {
  createJsonLogger,
  currentLogContext,
  withLogContext,
} from '../../packages/core/src/observability/index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const INTENT = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';

describe('parseOtelEndpoint', () => {
  it.each([undefined, '', '   '])('is off for %j', (value) => {
    expect(parseOtelEndpoint(value)).toBeUndefined();
  });

  it.each([
    ['http://otel-collector:4318', 'http://otel-collector:4318'],
    ['http://otel-collector:4318/', 'http://otel-collector:4318'],
    ['https://collector.internal:4318/otlp', 'https://collector.internal:4318/otlp'],
  ])('accepts %s', (value, expected) => {
    expect(parseOtelEndpoint(value)).toBe(expected);
  });

  it.each([
    'otel-collector:4318',
    'ftp://collector',
    'http://user:secret@collector:4318',
    'http://collector:4318?token=x',
    'http://collector:4318#x',
    'not a url',
  ])('refuses %s', (value) => {
    expect(parseOtelEndpoint(value)).toBeNull();
  });
});

describe('startTracing without an endpoint', () => {
  it('starts nothing', () => {
    expect(startTracing({ serviceName: 'sdlc-test', endpoint: undefined })).toBeUndefined();
    platformTracer().startActiveSpan('x', (span) => {
      expect(span.isRecording()).toBe(false);
      expect(activeTraceIds()).toBeUndefined();
      span.end();
    });
  });
});

describe('stripQuery', () => {
  it.each([
    [
      'https://api.github.com/repos/a/b/issues?since=1&token=x',
      'https://api.github.com/repos/a/b/issues',
    ],
    ['/v1/intents?code=INT-1#frag', '/v1/intents'],
    ['/v1/intents', '/v1/intents'],
  ])('%s → %s', (value, expected) => {
    expect(stripQuery(value)).toBe(expected);
  });
});

describe('with tracing on', () => {
  const exporter = new InMemorySpanExporter();
  let tracing: Tracing;

  beforeAll(() => {
    const started = startTracing({ serviceName: 'sdlc-test', endpoint: undefined, exporter });
    if (!started) throw new Error('tracing did not start');
    tracing = started;
  });

  afterAll(async () => {
    await tracing.shutdown();
  });

  beforeEach(() => exporter.reset());

  function allValues(spans: readonly ReadableSpan[]): string {
    return JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes })));
  }

  it('records http spans without headers or query strings', async () => {
    // Loaded after the instrumentation is registered, like the apps do (telemetry.ts first).
    const http = createRequire(path.join(process.cwd(), 'package.json'))(
      'node:http',
    ) as typeof import('node:http');
    const server = http.createServer((_req, res) => {
      res.setHeader('set-cookie', 'session=response-secret');
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // X08a (ADR-M109 §2.1): the intent search text `q` is in the query string too.
      for (const path of [
        '/v1/intents?token=query-secret&code=INT-1&q=search-canary-words',
        '/health/live?x=1',
      ]) {
        await new Promise<void>((resolve, reject) => {
          const request = http.request(
            {
              host: '127.0.0.1',
              port,
              path,
              headers: { authorization: 'Bearer header-secret', cookie: 'c=cookie-secret' },
            },
            (response) => {
              response.resume();
              response.on('end', resolve);
            },
          );
          request.on('error', reject);
          request.end();
        });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await tracing.forceFlush();
    const spans = exporter.getFinishedSpans();
    // Client and server span of the first request; the health check's server span is ignored.
    expect(spans.map((s) => s.kind).sort()).toEqual([1, 2, 2]);
    const text = allValues(spans);
    for (const secret of [
      'query-secret',
      'search-canary-words',
      'header-secret',
      'cookie-secret',
      'response-secret',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('?');
    for (const span of spans) {
      expect(Object.keys(span.attributes).filter((k) => /header|query/.test(k))).toEqual([]);
    }
  });

  it('removes header, query and SQL parameter attributes set by any code', async () => {
    platformTracer().startActiveSpan('manual', (span) => {
      span.setAttributes({
        'url.full': 'https://h/p?token=x',
        'http.target': '/p?token=x',
        'url.query': 'token=x',
        'http.request.header.authorization': ['Bearer x'],
        'http.response.header.set_cookie': ['c=x'],
        'db.postgresql.values': ['secret-param'],
        'db.query.parameter.0': 'secret-param',
        'db.query.text': 'SELECT * FROM intents WHERE tenant_id = $1',
      });
      span.end();
    });
    await tracing.forceFlush();
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).toEqual({
      'url.full': 'https://h/p',
      'http.target': '/p',
      'db.query.text': 'SELECT * FROM intents WHERE tenant_id = $1',
    });
  });

  it('keeps the error code and class, never the error text (status and events)', async () => {
    platformTracer().startActiveSpan('failing', (span) => {
      span.recordException(new Error('invalid input syntax for type uuid: "client-value"'));
      span.setStatus({ code: 2, message: 'invalid input syntax for type uuid: "client-value"' });
      span.addEvent('custom', { 'exception.message': 'client-value', note: 'client-value' });
      span.end();
    });
    await tracing.forceFlush();
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: 2 });
    expect(span?.events.map((e) => e.attributes)).toEqual([{ 'exception.type': 'Error' }, {}]);
    expect(JSON.stringify(span?.events)).not.toContain('client-value');
  });

  it('gives the log line the trace and span IDs of the active span', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createJsonLogger({
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      traceIds: activeTraceIds,
    });
    platformTracer().startActiveSpan('with-log', (span) => {
      logger.log('info', 'inside');
      expect(lines[0]).toMatchObject({
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
      });
      span.end();
    });
    logger.log('info', 'outside');
    expect(lines[1]).not.toHaveProperty('trace_id');
  });

  describe('activityTracingInterceptor', () => {
    const info = { activityType: 'stepIntent', attempt: 2, taskQueue: 'sdlc-intents' };

    it('runs the activity in a span and a log context with its IDs', async () => {
      const { inbound } = activityTracingInterceptor({ withLogContext })({ info });
      const seen: unknown[] = [];
      const result = await inbound.execute(
        { args: [{ tenantId: TENANT, intentId: INTENT }, RUN] },
        () => {
          seen.push(currentLogContext(), trace.getActiveSpan()?.isRecording());
          return Promise.resolve('done');
        },
      );
      expect(result).toBe('done');
      expect(seen).toEqual([{ tenantId: TENANT, intentId: INTENT, runId: RUN }, true]);
      await tracing.forceFlush();
      const [span] = exporter.getFinishedSpans();
      expect(span?.name).toBe('activity stepIntent');
      expect(span?.attributes).toEqual({
        'temporal.activity.type': 'stepIntent',
        'temporal.activity.attempt': 2,
        'temporal.task_queue': 'sdlc-intents',
        'sdlc.tenant_id': TENANT,
        'sdlc.intent_id': INTENT,
        'sdlc.run_id': RUN,
      });
    });

    it('records a failure by error class only and rethrows', async () => {
      const { inbound } = activityTracingInterceptor({ withLogContext })({ info });
      await expect(
        inbound.execute({ args: [] }, () => Promise.reject(new TypeError('text with a secret'))),
      ).rejects.toThrow(TypeError);
      await tracing.forceFlush();
      const [span] = exporter.getFinishedSpans();
      expect(span?.status.code).toBe(2);
      expect(span?.attributes['error.type']).toBe('TypeError');
      expect(allValues([span as ReadableSpan])).not.toContain('secret');
    });
  });
});

describe('defaultActivityContext', () => {
  it('reads the IDs of the first argument and a second run ID', () => {
    expect(
      defaultActivityContext('executeRun', [{ tenantId: TENANT, runId: RUN, modelRef: 'm' }]),
    ).toEqual({ tenantId: TENANT, runId: RUN });
    expect(
      defaultActivityContext('finishRun', [{ tenantId: TENANT, intentId: INTENT }, RUN]),
    ).toEqual({
      tenantId: TENANT,
      intentId: INTENT,
      runId: RUN,
    });
  });

  it('ignores values that are not UUIDs', () => {
    expect(
      defaultActivityContext('x', [
        { tenantId: 'acme', intentId: 'INT-2026-0001' },
        'wrapped-token',
      ]),
    ).toEqual({});
    expect(defaultActivityContext('x', [null, 3])).toEqual({});
  });
});
