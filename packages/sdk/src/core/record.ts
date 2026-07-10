import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { recordGlobal } from './global-audit.js';
import { getContext } from './storage.js';
import type { Transport } from './transport.js';
import { emitAuditWarning, errorMessage } from './warnings.js';

export interface RecordInput {
  eventType: AuditEvent['eventType'];
  eventName: string;
  severity?: AuditEvent['severity'];
  outcome?: AuditEvent['outcome'];
  entity?: NonNullable<AuditEvent['entity']>;
  payload?: NonNullable<AuditEvent['payload']>;
}

export interface PayloadOptions {
  maskedFields?: string[];
  maxPayloadSize?: number;
}

const defaultMaxPayloadSize = 1_000_000;

export function record(input: RecordInput): void {
  recordGlobal(input);
}

export function buildAuditEvent(
  input: RecordInput,
  service: AuditEvent['service'],
  payloadOptions: PayloadOptions = {}
): AuditEvent {
  const ctx = getContext();
  const payload = preparePayload(input.payload, payloadOptions);

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
    payload
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
        emitTransportWarning(error);
      });
    }
  } catch (error: unknown) {
    emitTransportWarning(error);
  }
}

function emitTransportWarning(error: unknown): void {
  emitAuditWarning(`transport send failed: ${errorMessage(error)}`);
}

function preparePayload(
  payload: NonNullable<AuditEvent['payload']> | undefined,
  options: PayloadOptions
): NonNullable<AuditEvent['payload']> {
  const maskedPayload = maskPayload(payload ?? Object.freeze({}), options);
  const maxPayloadSize = options.maxPayloadSize ?? defaultMaxPayloadSize;
  const originalSizeBytes = Buffer.byteLength(
    JSON.stringify(maskedPayload),
    'utf8'
  );

  if (originalSizeBytes <= maxPayloadSize) {
    return maskedPayload;
  }

  return {
    truncated: true,
    originalSizeBytes,
    maxSizeBytes: maxPayloadSize
  };
}

function maskPayload(
  payload: NonNullable<AuditEvent['payload']>,
  options: PayloadOptions
): NonNullable<AuditEvent['payload']> {
  if (options.maskedFields === undefined || options.maskedFields.length === 0) {
    return payload;
  }

  const maskedFields = new Set(options.maskedFields);
  const maskedPayload: NonNullable<AuditEvent['payload']> = { ...payload };

  for (const field of maskedFields) {
    if (Object.hasOwn(maskedPayload, field)) {
      maskedPayload[field] = '***';
    }
  }

  return maskedPayload;
}
