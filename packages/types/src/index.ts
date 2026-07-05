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

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface AuditEvent {
  id: string;
  correlation_id: string;
  causation_id?: string;
  request_id?: string;
  trace_id?: string;
  span_id?: string;
  service_name: string;
  service_version?: string;
  instance_id?: string;
  server_name?: string;
  environment: Environment;
  event_type: EventType;
  event_name: string;
  severity: EventSeverity;
  outcome?: EventOutcome;
  actor_type?: ActorType;
  user_id?: string;
  user_role?: string;
  tenant_id?: string;
  http_method?: string;
  endpoint?: string;
  route_pattern?: string;
  status_code?: number;
  duration_ms?: number;
  ip_address?: string;
  user_agent?: string;
  entity_type?: string;
  entity_id?: string;
  payload_schema_version: number;
  payload: JsonObject;
  occurred_at: string;
  created_at?: string;
}
