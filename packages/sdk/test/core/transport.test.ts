import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import type { Transport } from '../../src/core/transport.js';

const event: AuditEvent = {
  id: 'event-1',
  correlationId: 'correlation-1',
  eventType: 'business',
  eventName: 'recipe.updated',
  severity: 'info',
  outcome: 'success',
  occurredAt: '2026-07-05T00:00:00.000Z',
  service: {
    name: 'recipes-api',
    environment: 'development'
  },
  entity: {
    type: 'recipe',
    id: 'recipe-1'
  },
  payload: {
    changedFields: ['title']
  }
};

describe('Transport', () => {
  it('allows a transport stub to receive an AuditEvent', () => {
    let receivedEvent: AuditEvent | undefined;

    const transport: Transport = {
      send(received) {
        receivedEvent = received;
      }
    };

    transport.send(event);

    expect(receivedEvent).toBe(event);
  });

  it('accepts synchronous and asynchronous transport implementations', async () => {
    const syncTransport: Transport = {
      send() {
        return undefined;
      }
    };

    const asyncTransport: Transport = {
      async send() {
        await Promise.resolve();
      }
    };

    expect(syncTransport.send(event)).toBeUndefined();
    await expect(asyncTransport.send(event)).resolves.toBeUndefined();
  });
});
