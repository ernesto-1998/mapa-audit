import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { recordGlobal } from './global-audit.js';
import { getContext } from './storage.js';
import type { Transport } from './transport.js';

export interface RecordInput {
  eventType: AuditEvent['eventType'];
  eventName: string;
  severity?: AuditEvent['severity'];
  outcome?: AuditEvent['outcome'];
  entity?: NonNullable<AuditEvent['entity']>;
  payload?: NonNullable<AuditEvent['payload']>;
}

export function record(input: RecordInput): void {
  recordGlobal(input);
}

export function buildAuditEvent(
  input: RecordInput,
  service: AuditEvent['service']
): AuditEvent {
  const ctx = getContext();

  return {
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
    payload: input.payload ?? Object.freeze({})
  };
}

export function sendFireAndForget(
  transport: Transport,
  event: AuditEvent
): void {
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
