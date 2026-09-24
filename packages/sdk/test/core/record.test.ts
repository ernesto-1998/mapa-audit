import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  eventOutcomes,
  eventSeverities,
  eventTypes,
  type AuditEvent,
  type Environment
} from '@tnet06/mapa-audit-types';
import {
  createAudit,
  type AuditConfig
} from '../../src/core/audit-instance.js';
import {
  getGlobalAudit,
  initGlobalAudit,
  resetGlobalAudit,
  shutdownGlobalAudit
} from '../../src/core/global-audit.js';
import { record, type RecordInput } from '../../src/core/record.js';
import { contextStore, type RequestContext } from '../../src/core/storage.js';
import type { Transport } from '../../src/core/transport.js';
import { FileTransport } from '../../src/transports/file.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const missingGlobalAuditWarning =
  '[mapa-audit] record() called before initGlobalAudit() - events are being discarded. Call initGlobalAudit() at startup, or use createAudit() for an explicit instance.';
const syncTransportWarning =
  '[mapa-audit] transport send failed: transport failed';
const asyncTransportWarning =
  '[mapa-audit] transport send failed: transport rejected';
const failedBuildWarningPrefix = '[mapa-audit] failed to build audit event:';
const serviceNameError = '[mapa-audit] serviceName must be a non-empty string';
const documentedDefaultMaxPayloadSize = 1_000_000;
const tempDirs: string[] = [];

function createCapturingTransport(): {
  transport: Transport;
  events: AuditEvent[];
} {
  const events: AuditEvent[] = [];

  return {
    events,
    transport: {
      send(event) {
        events.push(event);
      }
    }
  };
}

function createUnsafeAuditConfig(config: Record<string, unknown>): AuditConfig {
  return config as unknown as AuditConfig;
}

function createUnsafeRecordInput(input: unknown): RecordInput {
  return input as RecordInput;
}

function expectInvalidInstanceRecord(
  input: unknown,
  warningDetail: string
): void {
  const emitWarning = vi
    .spyOn(process, 'emitWarning')
    .mockImplementation(() => undefined);
  const { events, transport } = createCapturingTransport();
  const audit = createAudit({
    serviceName: 'recipes-api',
    environment: 'development',
    transports: [transport]
  });

  expect(() => {
    audit.record(createUnsafeRecordInput(input));
  }).not.toThrow();

  expect(events).toHaveLength(0);
  expect(emitWarning).toHaveBeenCalledTimes(1);
  expect(emitWarning).toHaveBeenCalledWith(
    `${failedBuildWarningPrefix} ${warningDetail}`
  );
}

describe('record', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    resetGlobalAudit();
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  it('generates a client-side UUID for each event', () => {
    const { events, transport } = createCapturingTransport();

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    record({
      eventType: 'business',
      eventName: 'recipe.updated'
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toMatch(uuidPattern);
  });

  it('merges request context, service metadata, and record input', () => {
    const { events, transport } = createCapturingTransport();
    const context: RequestContext = {
      correlationId: 'correlation-1',
      causationId: 'causation-1',
      request: {
        httpMethod: 'PATCH',
        endpoint: '/recipes/recipe-1',
        routePattern: '/recipes/:id',
        ipAddress: '127.0.0.1',
        userAgent: 'vitest'
      },
      actor: {
        type: 'user',
        userId: 'user-1',
        userRole: 'admin',
        tenantId: 'tenant-1'
      }
    };

    initGlobalAudit({
      serviceName: 'recipes-api',
      serviceVersion: '1.2.3',
      instanceId: 'recipes-api-01',
      environment: 'staging',
      transports: [transport]
    });

    contextStore.run(context, () => {
      record({
        eventType: 'business',
        eventName: 'recipe.updated',
        severity: 'warn',
        outcome: 'success',
        entity: {
          type: 'recipe',
          id: 'recipe-1'
        },
        payload: {
          changedFields: ['title']
        }
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      correlationId: 'correlation-1',
      causationId: 'causation-1',
      eventType: 'business',
      eventName: 'recipe.updated',
      severity: 'warn',
      outcome: 'success',
      service: {
        name: 'recipes-api',
        version: '1.2.3',
        environment: 'staging',
        instanceId: 'recipes-api-01'
      },
      request: context.request,
      actor: context.actor,
      entity: {
        type: 'recipe',
        id: 'recipe-1'
      },
      payload: {
        changedFields: ['title']
      }
    });
    expect(events[0]?.occurredAt).toEqual(expect.any(String));
  });

  it('works outside any request context', () => {
    const { events, transport } = createCapturingTransport();

    initGlobalAudit({
      serviceName: 'jobs-api',
      environment: 'production',
      transports: [transport]
    });

    expect(() => {
      record({
        eventType: 'system',
        eventName: 'job.completed'
      });
    }).not.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'system',
      eventName: 'job.completed',
      severity: 'info',
      service: {
        name: 'jobs-api',
        environment: 'production'
      },
      payload: {}
    });
    expect(events[0]?.correlationId).toBeUndefined();
  });

  it.each([
    ['missing', { eventName: 'invalid.event' }],
    ['null', { eventType: null, eventName: 'invalid.event' }],
    [
      'unknown string',
      { eventType: 'not-a-real-type', eventName: 'invalid.event' }
    ],
    ['number', { eventType: 42, eventName: 'invalid.event' }]
  ])(
    'does not throw, warn once, or dispatch for invalid eventType: %s',
    (_caseName, input) => {
      expectInvalidInstanceRecord(input, 'invalid eventType');
    }
  );

  it.each([
    ['missing', { eventType: 'business' }],
    ['null', { eventType: 'business', eventName: null }],
    ['number', { eventType: 'business', eventName: 42 }],
    ['empty string', { eventType: 'business', eventName: '' }],
    ['whitespace', { eventType: 'business', eventName: '   ' }]
  ])(
    'does not throw, warn once, or dispatch for invalid eventName: %s',
    (_caseName, input) => {
      expectInvalidInstanceRecord(
        input,
        'eventName must be a non-empty string'
      );
    }
  );

  it.each([
    [
      'null',
      { eventType: 'business', eventName: 'invalid.severity', severity: null }
    ],
    [
      'unknown string',
      {
        eventType: 'business',
        eventName: 'invalid.severity',
        severity: 'fatal'
      }
    ],
    [
      'number',
      { eventType: 'business', eventName: 'invalid.severity', severity: 42 }
    ]
  ])(
    'does not throw, warn once, or dispatch for invalid severity: %s',
    (_caseName, input) => {
      expectInvalidInstanceRecord(input, 'invalid severity');
    }
  );

  it.each([
    [
      'null',
      { eventType: 'business', eventName: 'invalid.outcome', outcome: null }
    ],
    [
      'unknown string',
      { eventType: 'business', eventName: 'invalid.outcome', outcome: 'maybe' }
    ],
    [
      'number',
      { eventType: 'business', eventName: 'invalid.outcome', outcome: 42 }
    ]
  ])(
    'does not throw, warn once, or dispatch for invalid outcome: %s',
    (_caseName, input) => {
      expectInvalidInstanceRecord(input, 'invalid outcome');
    }
  );

  it('keeps undefined severity and outcome as optional values without warnings', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    audit.record(
      createUnsafeRecordInput({
        eventType: 'business',
        eventName: 'optional.values',
        severity: undefined,
        outcome: undefined
      })
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe('info');
    expect(Object.hasOwn(events[0] ?? {}, 'outcome')).toBe(false);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('accepts all canonical event types without warnings', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    for (const eventType of eventTypes) {
      audit.record({
        eventType,
        eventName: `event-type.${eventType}`
      });
    }

    expect(events.map((event) => event.eventType)).toEqual([...eventTypes]);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('accepts all canonical event severities without warnings', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    for (const severity of eventSeverities) {
      audit.record({
        eventType: 'business',
        eventName: `severity.${severity}`,
        severity
      });
    }

    expect(events.map((event) => event.severity)).toEqual([...eventSeverities]);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('accepts all canonical outcomes without warnings', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    for (const outcome of eventOutcomes) {
      audit.record({
        eventType: 'business',
        eventName: `outcome.${outcome}`,
        outcome
      });
    }

    expect(events.map((event) => event.outcome)).toEqual([...eventOutcomes]);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('does not throw, warn once, or dispatch globally for invalid record input', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    expect(() => {
      record(
        createUnsafeRecordInput({
          eventType: 'not-a-real-type',
          eventName: 'invalid.global'
        })
      );
    }).not.toThrow();

    expect(events).toHaveLength(0);
    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(
      `${failedBuildWarningPrefix} invalid eventType`
    );
  });

  it('does not throw, warn once, dispatch, or leak input details for null record input', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    expect(() => {
      audit.record(createUnsafeRecordInput(null));
    }).not.toThrow();

    expect(events).toHaveLength(0);
    expect(emitWarning).toHaveBeenCalledTimes(1);

    const warning = emitWarning.mock.calls[0]?.[0];

    expect(warning).toBe(
      `${failedBuildWarningPrefix} record input must be an object`
    );
    expect(String(warning)).not.toContain('payload');
    expect(String(warning)).not.toContain('{');
  });

  it('masks configured top-level payload fields without changing other fields', () => {
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: ['creditCard']
    });

    audit.record({
      eventType: 'business',
      eventName: 'payment.created',
      payload: {
        creditCard: '4111111111111111',
        amount: 42
      }
    });

    expect(events[0]?.payload).toEqual({
      creditCard: '***',
      amount: 42
    });
  });

  it('masks second-level payload paths with dot notation', () => {
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: ['user.ssn']
    });

    audit.record({
      eventType: 'business',
      eventName: 'user.updated',
      payload: {
        user: {
          ssn: '123-45-6789',
          name: 'Ada'
        }
      }
    });

    expect(events[0]?.payload).toEqual({
      user: {
        ssn: '***',
        name: 'Ada'
      }
    });
  });

  it('masks third-level payload paths with dot notation', () => {
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: ['payment.card.cvv']
    });

    audit.record({
      eventType: 'business',
      eventName: 'payment.created',
      payload: {
        payment: {
          card: {
            cvv: '123',
            last4: '1111'
          },
          amount: 42
        }
      }
    });

    expect(events[0]?.payload).toEqual({
      payment: {
        card: {
          cvv: '***',
          last4: '1111'
        },
        amount: 42
      }
    });
  });

  it('ignores missing masked paths without changing other payload fields', () => {
    const { events, transport } = createCapturingTransport();
    const payload = {
      accountId: 'account-1'
    };
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: ['user.ssn']
    });

    audit.record({
      eventType: 'business',
      eventName: 'account.updated',
      payload
    });

    expect(events[0]?.payload).toEqual(payload);
  });

  it('ignores masked paths that traverse non-objects', () => {
    const { events, transport } = createCapturingTransport();
    const payload = {
      a: 'string'
    };
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: ['a.b']
    });

    audit.record({
      eventType: 'business',
      eventName: 'payload.non-object',
      payload
    });

    expect(events[0]?.payload).toEqual(payload);
  });

  it('ignores masked paths that traverse null or arrays', () => {
    const { events, transport } = createCapturingTransport();
    const payload = {
      user: null,
      payments: [{ card: { cvv: '123' } }]
    };
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: ['user.ssn', 'payments.0.card.cvv']
    });

    audit.record({
      eventType: 'business',
      eventName: 'payload.array',
      payload
    });

    expect(events[0]?.payload).toEqual(payload);
  });

  it('leaves payload unchanged when maskedFields is not configured', () => {
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    audit.record({
      eventType: 'business',
      eventName: 'payment.created',
      payload: {
        creditCard: '4111111111111111',
        amount: 42
      }
    });

    expect(events[0]?.payload).toEqual({
      creditCard: '4111111111111111',
      amount: 42
    });
  });

  it('does not mutate the original payload object when masking fields', () => {
    const { events, transport } = createCapturingTransport();
    const originalPayload = {
      user: {
        ssn: '123-45-6789',
        name: 'Ada'
      }
    };
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: ['user.ssn']
    });

    audit.record({
      eventType: 'security',
      eventName: 'login.attempted',
      payload: originalPayload
    });

    expect(originalPayload).toEqual({
      user: {
        ssn: '123-45-6789',
        name: 'Ada'
      }
    });
    expect(events[0]?.payload).toEqual({
      user: {
        ssn: '***',
        name: 'Ada'
      }
    });
  });

  it('handles overlapping masked paths without throwing', () => {
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: ['user', 'user.ssn']
    });

    expect(() => {
      audit.record({
        eventType: 'business',
        eventName: 'user.updated',
        payload: {
          user: {
            ssn: '123-45-6789',
            name: 'Ada'
          }
        }
      });
    }).not.toThrow();

    expect(events[0]?.payload).toEqual({
      user: '***'
    });
  });

  it('keeps the original payload reference when maskedFields is empty', () => {
    const { events, transport } = createCapturingTransport();
    const payload = {
      creditCard: '4111111111111111'
    };
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: []
    });

    audit.record({
      eventType: 'business',
      eventName: 'payment.created',
      payload
    });

    expect(events[0]?.payload).toBe(payload);
  });

  it('replaces payload with a truncation marker when it exceeds maxPayloadSize', () => {
    const { events, transport } = createCapturingTransport();
    const payload = {
      message: 'this payload is too large'
    };
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maxPayloadSize: 10
    });

    audit.record({
      eventType: 'business',
      eventName: 'payload.large',
      payload
    });

    expect(events[0]?.payload).toEqual({
      truncated: true,
      originalSizeBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      maxSizeBytes: 10
    });
  });

  it('keeps payload intact when it does not exceed maxPayloadSize', () => {
    const { events, transport } = createCapturingTransport();
    const payload = {
      ok: true
    };
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maxPayloadSize: 1_000
    });

    audit.record({
      eventType: 'business',
      eventName: 'payload.small',
      payload
    });

    expect(events[0]?.payload).toEqual(payload);
  });

  it('keeps a payload exactly at the 1 MB default limit', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const payload = createPayloadWithSerializedSize(
      documentedDefaultMaxPayloadSize
    );
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    expect(serializedPayloadSize(payload)).toBe(
      documentedDefaultMaxPayloadSize
    );

    audit.record({
      eventType: 'business',
      eventName: 'payload.default-limit.included',
      payload
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toBe(payload);
    expect(events[0]?.payload).not.toMatchObject({
      truncated: true
    });
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('truncates a payload one byte above the 1 MB default limit', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const payload = createPayloadWithSerializedSize(
      documentedDefaultMaxPayloadSize + 1
    );
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    expect(serializedPayloadSize(payload)).toBe(
      documentedDefaultMaxPayloadSize + 1
    );

    audit.record({
      eventType: 'business',
      eventName: 'payload.default-limit.exceeded',
      payload
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      truncated: true,
      originalSizeBytes: documentedDefaultMaxPayloadSize + 1,
      maxSizeBytes: documentedDefaultMaxPayloadSize
    });
    expect(events[0]?.payload).not.toBe(payload);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('does not throw or dispatch from an audit instance when payload has a circular reference', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const payload: Record<string, unknown> = {
      name: 'circular-payload'
    };
    payload.self = payload;
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    expect(() => {
      audit.record({
        eventType: 'business',
        eventName: 'payload.circular',
        payload
      });
    }).not.toThrow();

    expect(events).toHaveLength(0);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining(failedBuildWarningPrefix)
    );
  });

  it('does not throw or dispatch globally when payload has a circular reference', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const payload: Record<string, unknown> = {
      name: 'circular-payload'
    };
    payload.self = payload;

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    expect(() => {
      record({
        eventType: 'business',
        eventName: 'payload.circular',
        payload
      });
    }).not.toThrow();

    expect(events).toHaveLength(0);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining(failedBuildWarningPrefix)
    );
  });

  it('does not throw or dispatch from an audit instance when masked payload cannot be cloned', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: ['creditCard']
    });

    expect(() => {
      audit.record({
        eventType: 'business',
        eventName: 'payload.uncloneable',
        payload: {
          creditCard: '4111111111111111',
          callback() {
            return undefined;
          }
        }
      });
    }).not.toThrow();

    expect(events).toHaveLength(0);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining(failedBuildWarningPrefix)
    );
  });

  it('does not throw or dispatch globally when masked payload cannot be cloned', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport],
      maskedFields: ['creditCard']
    });

    expect(() => {
      record({
        eventType: 'business',
        eventName: 'payload.uncloneable',
        payload: {
          creditCard: '4111111111111111',
          callback() {
            return undefined;
          }
        }
      });
    }).not.toThrow();

    expect(events).toHaveLength(0);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining(failedBuildWarningPrefix)
    );
  });

  it('uses the default console transport when no transports are configured', () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development'
    });

    expect(() => {
      record({
        eventType: 'business',
        eventName: 'recipe.updated'
      });
    }).not.toThrow();
    expect(stdoutWrite).toHaveBeenCalledTimes(1);
  });

  it('creates independent audit instances that do not share service or transports', () => {
    const first = createCapturingTransport();
    const second = createCapturingTransport();
    const recipesAudit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [first.transport]
    });
    const billingAudit = createAudit({
      serviceName: 'billing-api',
      environment: 'production',
      transports: [second.transport]
    });

    recipesAudit.record({
      eventType: 'business',
      eventName: 'recipe.updated'
    });
    billingAudit.record({
      eventType: 'system',
      eventName: 'invoice.synced'
    });

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      eventName: 'recipe.updated',
      service: {
        name: 'recipes-api',
        environment: 'development'
      }
    });
    expect(second.events[0]).toMatchObject({
      eventName: 'invoice.synced',
      service: {
        name: 'billing-api',
        environment: 'production'
      }
    });
  });

  it('sends the same event to every configured transport', () => {
    const first = createCapturingTransport();
    const second = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [first.transport, second.transport]
    });

    audit.record({
      eventType: 'business',
      eventName: 'recipe.updated'
    });

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toBe(first.events[0]);
  });

  it('isolates synchronous transport failures from other transports', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const working = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [
        {
          send() {
            throw new Error('transport failed');
          }
        },
        working.transport
      ]
    });

    expect(() => {
      audit.record({
        eventType: 'business',
        eventName: 'recipe.updated'
      });
    }).not.toThrow();

    expect(working.events).toHaveLength(1);
    expect(emitWarning).toHaveBeenCalledWith(syncTransportWarning);
  });

  it('isolates asynchronous transport rejections from other transports', async () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const working = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [
        {
          async send() {
            await Promise.reject(new Error('transport rejected'));
          }
        },
        working.transport
      ]
    });

    expect(() => {
      audit.record({
        eventType: 'business',
        eventName: 'recipe.updated'
      });
    }).not.toThrow();

    await Promise.resolve();
    expect(working.events).toHaveLength(1);
    await vi.waitFor(() => {
      expect(emitWarning).toHaveBeenCalledWith(asyncTransportWarning);
    });
  });

  it('does not throw when configured with an empty transports array', () => {
    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: []
    });

    expect(() => {
      record({
        eventType: 'business',
        eventName: 'recipe.updated'
      });
    }).not.toThrow();
  });

  it('warns only once when global record is called before initialization', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    expect(() => {
      record({
        eventType: 'business',
        eventName: 'recipe.updated'
      });
      record({
        eventType: 'business',
        eventName: 'recipe.deleted'
      });
    }).not.toThrow();

    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(missingGlobalAuditWarning);
  });

  it('resetGlobalAudit resets the missing global warning state', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    record({
      eventType: 'business',
      eventName: 'recipe.updated'
    });
    resetGlobalAudit();
    record({
      eventType: 'business',
      eventName: 'recipe.deleted'
    });

    expect(emitWarning).toHaveBeenCalledTimes(2);
    expect(emitWarning).toHaveBeenNthCalledWith(1, missingGlobalAuditWarning);
    expect(emitWarning).toHaveBeenNthCalledWith(2, missingGlobalAuditWarning);
  });

  it('does not warn for explicit audit instances without a global instance', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    audit.record({
      eventType: 'business',
      eventName: 'recipe.updated'
    });

    expect(events).toHaveLength(1);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('does not propagate synchronous transport failures', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [
        {
          send() {
            throw new Error('transport failed');
          }
        }
      ]
    });

    expect(() => {
      record({
        eventType: 'business',
        eventName: 'recipe.updated'
      });
    }).not.toThrow();
    expect(emitWarning).toHaveBeenCalledWith(syncTransportWarning);
  });

  it('does not propagate asynchronous transport rejections', async () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [
        {
          async send() {
            await Promise.reject(new Error('transport rejected'));
          }
        }
      ]
    });

    expect(() => {
      record({
        eventType: 'business',
        eventName: 'recipe.updated'
      });
    }).not.toThrow();

    await Promise.resolve();
    await vi.waitFor(() => {
      expect(emitWarning).toHaveBeenCalledWith(asyncTransportWarning);
    });
  });

  it('resetGlobalAudit clears the global singleton state between tests', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const { events, transport } = createCapturingTransport();

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    record({
      eventType: 'business',
      eventName: 'recipe.updated'
    });
    resetGlobalAudit();
    record({
      eventType: 'business',
      eventName: 'recipe.deleted'
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.eventName).toBe('recipe.updated');
    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(missingGlobalAuditWarning);
  });

  it('drains pending FileTransport writes on instance shutdown', async () => {
    const filePath = await createTempFilePath('events.jsonl');
    const audit = createAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [new FileTransport({ path: filePath })]
    });

    audit.record({
      eventType: 'business',
      eventName: 'recipe.created',
      payload: { index: 1 }
    });
    audit.record({
      eventType: 'business',
      eventName: 'recipe.updated',
      payload: { index: 2 }
    });

    await audit.shutdown();
    await audit.shutdown();

    const lines = (await readFile(filePath, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      eventName: 'recipe.created',
      payload: { index: 1 }
    });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({
      eventName: 'recipe.updated',
      payload: { index: 2 }
    });
  });

  it('shutdownGlobalAudit is safe with transports that do not implement close', async () => {
    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [createCapturingTransport().transport]
    });

    await expect(shutdownGlobalAudit()).resolves.toBeUndefined();
    await expect(shutdownGlobalAudit()).resolves.toBeUndefined();
  });
});

describe('initGlobalAudit', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['empty string', ''],
    ['whitespace', '   ']
  ])(
    'createAudit rejects invalid serviceName: %s',
    (_caseName, serviceName) => {
      expect(() => {
        createAudit(
          createUnsafeAuditConfig({
            serviceName,
            environment: 'development'
          })
        );
      }).toThrow(serviceNameError);
    }
  );

  it('initGlobalAudit rejects invalid serviceName', () => {
    expect(() => {
      initGlobalAudit(
        createUnsafeAuditConfig({
          serviceName: '   ',
          environment: 'development'
        })
      );
    }).toThrow(serviceNameError);
  });

  it('does not leave a global singleton configured after failed initialization', () => {
    expect(() => {
      initGlobalAudit(
        createUnsafeAuditConfig({
          serviceName: undefined,
          environment: 'development'
        })
      );
    }).toThrow(serviceNameError);

    expect(getGlobalAudit()).toBeUndefined();
  });

  it('rejects invalid environments', () => {
    expect(() => {
      initGlobalAudit({
        serviceName: 'recipes-api',
        environment: 'invalid' as Environment
      });
    }).toThrow('[mapa-audit] invalid environment "invalid"');
  });

  it('returns undefined global audit info before initialization', () => {
    expect(getGlobalAudit()).toBeUndefined();
  });

  it('returns an inspection view after global initialization', () => {
    const first = createCapturingTransport();
    const second = createCapturingTransport();

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'staging',
      transports: [first.transport, second.transport]
    });

    const info = getGlobalAudit();

    expect(info).toEqual({
      configured: true,
      serviceName: 'recipes-api',
      environment: 'staging',
      transportCount: 2
    });
    expect(Object.hasOwn(info ?? {}, 'shutdown')).toBe(false);
    expect(Object.hasOwn(info ?? {}, 'record')).toBe(false);
    expect(Object.hasOwn(info ?? {}, 'transports')).toBe(false);

    (info as { serviceName: string }).serviceName = 'mutated';

    expect(getGlobalAudit()?.serviceName).toBe('recipes-api');
  });
});

async function createTempFilePath(fileName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mapa-audit-'));
  tempDirs.push(dir);

  return join(dir, fileName);
}

function createPayloadWithSerializedSize(
  targetSizeBytes: number
): Record<string, unknown> {
  const emptyPayload = { value: '' };
  const structuralSize = serializedPayloadSize(emptyPayload);
  const contentSize = targetSizeBytes - structuralSize;

  if (contentSize < 0) {
    throw new Error('target payload size is smaller than JSON structure');
  }

  return {
    value: 'x'.repeat(contentSize)
  };
}

function serializedPayloadSize(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}
