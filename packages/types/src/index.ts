export const eventTypes = [
  'request',
  'business',
  'audit',
  'error',
  'security',
  'system'
] as const;

export type EventType = (typeof eventTypes)[number];

export const eventSeverities = [
  'debug',
  'info',
  'warn',
  'error',
  'critical'
] as const;

export type EventSeverity = (typeof eventSeverities)[number];

export const eventOutcomes = ['success', 'failure', 'partial'] as const;

export type EventOutcome = (typeof eventOutcomes)[number];

export const actorTypes = ['user', 'service', 'system', 'job'] as const;

export type ActorType = (typeof actorTypes)[number];

export const environments = ['development', 'staging', 'production'] as const;

export type Environment = (typeof environments)[number];

export interface AuditEvent {
  id: string;
  correlationId?: string;
  causationId?: string;
  eventType: EventType;
  eventName: string;
  severity: EventSeverity;
  outcome?: EventOutcome;
  occurredAt: string;
  payloadSchemaVersion?: number;
  service: {
    name: string;
    version?: string;
    environment: Environment;
    instanceId?: string;
  };
  request?: {
    httpMethod?: string;
    endpoint?: string;
    routePattern?: string;
    ipAddress?: string;
    userAgent?: string;
  };
  actor?: {
    type?: ActorType;
    userId?: string;
    userRole?: string;
    tenantId?: string;
  };
  entity?: {
    type?: string;
    id?: string;
  };
  payload?: Record<string, unknown>;
}
