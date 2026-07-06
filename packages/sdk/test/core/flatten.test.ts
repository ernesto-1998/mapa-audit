import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { flatten } from '../../src/core/flatten.js';

describe('flatten', () => {
  it('converts a nested AuditEvent into one flat object', () => {
    const event: AuditEvent = {
      id: 'event-1',
      correlationId: 'correlation-1',
      causationId: 'causation-1',
      eventType: 'business',
      eventName: 'recipe.updated',
      severity: 'info',
      outcome: 'success',
      occurredAt: '2026-07-05T00:00:00.000Z',
      payloadSchemaVersion: 2,
      service: {
        name: 'recipes-api',
        version: '1.2.3',
        environment: 'development',
        instanceId: 'instance-1'
      },
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
      },
      entity: {
        type: 'recipe',
        id: 'recipe-1'
      },
      payload: {
        changedFields: ['title']
      }
    };

    expect(flatten(event)).toEqual({
      id: 'event-1',
      correlationId: 'correlation-1',
      causationId: 'causation-1',
      eventType: 'business',
      eventName: 'recipe.updated',
      severity: 'info',
      outcome: 'success',
      occurredAt: '2026-07-05T00:00:00.000Z',
      payloadSchemaVersion: '2',
      service_name: 'recipes-api',
      service_version: '1.2.3',
      service_environment: 'development',
      service_instanceId: 'instance-1',
      request_httpMethod: 'PATCH',
      request_endpoint: '/recipes/recipe-1',
      request_routePattern: '/recipes/:id',
      request_ipAddress: '127.0.0.1',
      request_userAgent: 'vitest',
      actor_type: 'user',
      actor_userId: 'user-1',
      actor_userRole: 'admin',
      actor_tenantId: 'tenant-1',
      entity_type: 'recipe',
      entity_id: 'recipe-1',
      payload: JSON.stringify({ changedFields: ['title'] })
    });
  });

  it('omits absent optional fields', () => {
    const flatEvent = flatten({
      id: 'event-1',
      eventType: 'system',
      eventName: 'job.completed',
      severity: 'info',
      occurredAt: '2026-07-05T00:00:00.000Z',
      service: {
        name: 'jobs-api',
        environment: 'production'
      }
    });

    expect(flatEvent).toEqual({
      id: 'event-1',
      eventType: 'system',
      eventName: 'job.completed',
      severity: 'info',
      occurredAt: '2026-07-05T00:00:00.000Z',
      service_name: 'jobs-api',
      service_environment: 'production'
    });
  });
});
