/** Allowed audit event domains. */
export const eventTypes = [
  'request',
  'business',
  'audit',
  'error',
  'security',
  'system'
] as const;

/** Audit event domain/category. */
export type EventType = (typeof eventTypes)[number];

/** Allowed audit event severities. */
export const eventSeverities = [
  'debug',
  'info',
  'warn',
  'error',
  'critical'
] as const;

/** Audit event severity/gravity. */
export type EventSeverity = (typeof eventSeverities)[number];

/** Allowed operation outcomes for audit events. */
export const eventOutcomes = ['success', 'failure', 'partial'] as const;

/** Result of the operation being audited. */
export type EventOutcome = (typeof eventOutcomes)[number];

/** Allowed actor classifications. */
export const actorTypes = ['user', 'service', 'system', 'job'] as const;

/** Actor classification for an audit event. */
export type ActorType = (typeof actorTypes)[number];

/** Runtime environments supported by the SDK. */
export const environments = ['development', 'staging', 'production'] as const;

/** Runtime environment for the emitting service. */
export type Environment = (typeof environments)[number];

/** Canonical nested audit event shape shared by SDK transports and consumers. */
export interface AuditEvent {
  /** Client-generated event UUID. */
  readonly id: string;
  /** Request or workflow correlation id, when available. */
  correlationId?: string;
  /** Parent event or operation id, when available. */
  causationId?: string;
  /** Event domain/category. */
  eventType: EventType;
  /** Application-defined event name. */
  eventName: string;
  /** Event severity/gravity. */
  severity: EventSeverity;
  /** Optional operation result. */
  outcome?: EventOutcome;
  /** ISO timestamp generated when the event is recorded. */
  readonly occurredAt: string;
  /** Optional payload schema version supplied by the producer. */
  payloadSchemaVersion?: number;
  /** Metadata for the service that emitted the event. */
  service: {
    name: string;
    version?: string;
    environment: Environment;
    instanceId?: string;
  };
  /** Request metadata captured by framework adapters when available. */
  request?: {
    httpMethod?: string;
    endpoint?: string;
    routePattern?: string;
    ipAddress?: string;
    userAgent?: string;
  };
  /** Authenticated actor metadata when available. */
  actor?: {
    type?: ActorType;
    userId?: string;
    userRole?: string;
    tenantId?: string;
  };
  /** Domain entity affected by the event when applicable. */
  entity?: {
    type?: string;
    id?: string;
  };
  /** Custom event payload. SDK safety options may mask or truncate it. */
  payload?: Record<string, unknown>;
}

/** Contract implemented by every audit event destination. */
export interface Transport {
  /**
   * Delivers one already-built audit event.
   *
   * Implementations may be synchronous or asynchronous. SDK dispatch contains
   * errors so transport failures do not throw into host application code.
   */
  send(event: AuditEvent): void | Promise<void>;
  /**
   * Optional lifecycle hook for transports with pending work.
   *
   * `AuditInstance.shutdown()` and `shutdownGlobalAudit()` call this to drain
   * buffered writes before process shutdown.
   */
  close?(): Promise<void>;
}
