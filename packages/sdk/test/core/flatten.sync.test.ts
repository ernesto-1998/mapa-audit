import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { AUDIT_EVENT_CSV_COLUMNS, flatten } from '../../src/core/flatten.js';

describe('flatten CSV schema synchronization', () => {
  it('keeps flattened full AuditEvent keys in sync with canonical CSV columns', () => {
    const fullEvent: AuditEvent = {
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
        changedFields: ['title'],
        metadata: {
          source: 'sync-test'
        }
      }
    };

    const flatKeys = Object.keys(flatten(fullEvent));
    const flatKeySet = new Set(flatKeys);
    const columnSet = new Set(AUDIT_EVENT_CSV_COLUMNS);

    expect(AUDIT_EVENT_CSV_COLUMNS).toHaveLength(columnSet.size);
    expect(flatKeys).toHaveLength(AUDIT_EVENT_CSV_COLUMNS.length);
    expect(flatKeySet).toEqual(columnSet);
  });
});
