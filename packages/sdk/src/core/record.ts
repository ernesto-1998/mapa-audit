import { randomUUID } from 'node:crypto';
import {
  eventOutcomes,
  eventSeverities,
  eventTypes,
  type AuditEvent
} from '@tnet06/mapa-audit-types';
import { recordGlobal } from './global-audit.js';
import { getContext } from './storage.js';
import type { Transport } from './transport.js';
import { isNonBlankString, isStringMember } from './validation.js';
import { emitAuditWarning, errorMessage } from './warnings.js';

/** Input accepted by `record()` and `AuditInstance.record()`. */
export interface RecordInput {
  /** Event domain/category, such as `business`, `audit`, or `security`. */
  eventType: AuditEvent['eventType'];
  /** Application-defined event name, for example `user.created`. */
  eventName: string;
  /** Event severity. Defaults to `info` when omitted. */
  severity?: AuditEvent['severity'];
  /** Optional result of the operation being recorded. */
  outcome?: AuditEvent['outcome'];
  /** Optional entity affected by the event. */
  entity?: NonNullable<AuditEvent['entity']>;
  /** Optional custom event payload. Payload safety rules run before dispatch. */
  payload?: NonNullable<AuditEvent['payload']>;
}

export interface PayloadOptions {
  maskedFields?: string[];
  maxPayloadSize?: number;
}

const defaultMaxPayloadSize = 1_000_000;

/**
 * Records one event through the global audit singleton.
 *
 * Call `initGlobalAudit()` during application startup before using this helper.
 * This global path is recommended for the simple case: one audit configuration
 * per process, typically a single app/service initialized once at startup.
 * If it is called before initialization, the event is discarded and a warning is
 * emitted once for the process.
 *
 * @param input Event fields supplied by the caller.
 */
export function record(input: RecordInput): void {
  recordGlobal(input);
}

export function buildAuditEvent(
  input: RecordInput,
  service: AuditEvent['service'],
  payloadOptions: PayloadOptions = {}
): AuditEvent {
  validateRecordInput(input);

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

function validateRecordInput(input: unknown): asserts input is RecordInput {
  if (!isRecord(input)) {
    throw new Error('record input must be an object');
  }

  if (!isStringMember(input.eventType, eventTypes)) {
    throw new Error('invalid eventType');
  }

  if (!isNonBlankString(input.eventName)) {
    throw new Error('eventName must be a non-empty string');
  }

  if (
    input.severity !== undefined &&
    !isStringMember(input.severity, eventSeverities)
  ) {
    throw new Error('invalid severity');
  }

  if (
    input.outcome !== undefined &&
    !isStringMember(input.outcome, eventOutcomes)
  ) {
    throw new Error('invalid outcome');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
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

  const maskedPayload = structuredClone(payload);

  for (const field of options.maskedFields) {
    maskPath(maskedPayload, field.split('.'));
  }

  return maskedPayload;
}

function maskPath(target: Record<string, unknown>, segments: string[]): void {
  if (segments.length === 0) {
    return;
  }

  let current: unknown = target;

  for (const segment of segments.slice(0, -1)) {
    if (!isNavigableObject(current) || !Object.hasOwn(current, segment)) {
      return;
    }

    current = current[segment];
  }

  if (!isNavigableObject(current)) {
    return;
  }

  const lastSegment = segments.at(-1);

  if (lastSegment !== undefined && Object.hasOwn(current, lastSegment)) {
    current[lastSegment] = '***';
  }
}

function isNavigableObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
