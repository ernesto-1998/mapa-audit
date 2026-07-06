import { describe, expect, it } from 'vitest';
import type { AuditEvent, Environment } from '@tnet06/mapa-audit-types';
import { configureAudit } from '../../src/core/configure.js';
import { record } from '../../src/core/record.js';
import { contextStore, type RequestContext } from '../../src/core/storage.js';
import type { Transport } from '../../src/core/transport.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

describe('record', () => {
  it('generates a client-side UUID for each event', () => {
    const { events, transport } = createCapturingTransport();

    configureAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transport
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

    configureAudit({
      serviceName: 'recipes-api',
      serviceVersion: '1.2.3',
      environment: 'staging',
      transport
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
        environment: 'staging'
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

    configureAudit({
      serviceName: 'jobs-api',
      environment: 'production',
      transport
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

  it('does not throw when no transport is configured yet', () => {
    configureAudit({
      serviceName: 'recipes-api',
      environment: 'development'
    });

    expect(() => {
      record({
        eventType: 'business',
        eventName: 'recipe.updated'
      });
    }).not.toThrow();
  });

  it('does not propagate synchronous transport failures', () => {
    configureAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transport: {
        send() {
          throw new Error('transport failed');
        }
      }
    });

    expect(() => {
      record({
        eventType: 'business',
        eventName: 'recipe.updated'
      });
    }).not.toThrow();
  });

  it('does not propagate asynchronous transport rejections', async () => {
    configureAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transport: {
        async send() {
          await Promise.reject(new Error('transport rejected'));
        }
      }
    });

    expect(() => {
      record({
        eventType: 'business',
        eventName: 'recipe.updated'
      });
    }).not.toThrow();

    await Promise.resolve();
  });
});

describe('configureAudit', () => {
  it('rejects invalid environments', () => {
    expect(() => {
      configureAudit({
        serviceName: 'recipes-api',
        environment: 'invalid' as Environment
      });
    }).toThrow('[mapa-audit] invalid environment "invalid"');
  });
});
