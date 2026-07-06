import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { getConfiguredService, getConfiguredTransport } from './configure.js';
import { getContext } from './storage.js';

export interface RecordInput {
  eventType: AuditEvent['eventType'];
  eventName: string;
  severity?: AuditEvent['severity'];
  outcome?: AuditEvent['outcome'];
  entity?: NonNullable<AuditEvent['entity']>;
  payload?: NonNullable<AuditEvent['payload']>;
}

export function record(input: RecordInput): void {
  const service = getConfiguredService();

  if (service === undefined) {
    return;
  }

  const ctx = getContext();
  const event: AuditEvent = {
    id: randomUUID(),
    ...(ctx?.correlationId === undefined
      ? {}
      : { correlationId: ctx.correlationId }),
    ...(ctx?.causationId === undefined ? {} : { causationId: ctx.causationId }),
    eventType: input.eventType,
    eventName: input.eventName,
    severity: input.severity ?? 'info',
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    occurredAt: new Date().toISOString(),
    service,
    ...(ctx?.request === undefined ? {} : { request: ctx.request }),
    ...(ctx?.actor === undefined ? {} : { actor: ctx.actor }),
    ...(input.entity === undefined ? {} : { entity: input.entity }),
    payload: input.payload ?? {}
  };

  const transport = getConfiguredTransport();

  if (transport === undefined) {
    return;
  }

  try {
    const result = transport.send(event);

    if (result instanceof Promise) {
      result.catch((error: unknown) => {
        void error;
      });
    }
  } catch (error: unknown) {
    void error;
  }
}
