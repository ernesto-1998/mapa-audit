import type { AuditEvent } from '@tnet06/mapa-audit-types';

// Keep this CSV schema in sync with AuditEvent in @tnet06/mapa-audit-types.
export const AUDIT_EVENT_CSV_COLUMNS = [
  'id',
  'correlationId',
  'causationId',
  'eventType',
  'eventName',
  'severity',
  'outcome',
  'occurredAt',
  'payloadSchemaVersion',
  'service_name',
  'service_version',
  'service_environment',
  'service_instanceId',
  'request_httpMethod',
  'request_endpoint',
  'request_routePattern',
  'request_ipAddress',
  'request_userAgent',
  'actor_type',
  'actor_userId',
  'actor_userRole',
  'actor_tenantId',
  'entity_type',
  'entity_id',
  'payload'
] as const;

export type AuditEventCsvColumn = (typeof AUDIT_EVENT_CSV_COLUMNS)[number];

export type FlatAuditEvent = Partial<Record<AuditEventCsvColumn, string>>;

export function flatten(event: AuditEvent): FlatAuditEvent {
  return {
    id: event.id,
    ...(event.correlationId === undefined
      ? {}
      : { correlationId: event.correlationId }),
    ...(event.causationId === undefined
      ? {}
      : { causationId: event.causationId }),
    eventType: event.eventType,
    eventName: event.eventName,
    severity: event.severity,
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
    occurredAt: event.occurredAt,
    ...(event.payloadSchemaVersion === undefined
      ? {}
      : { payloadSchemaVersion: String(event.payloadSchemaVersion) }),
    service_name: event.service.name,
    ...(event.service.version === undefined
      ? {}
      : { service_version: event.service.version }),
    service_environment: event.service.environment,
    ...(event.service.instanceId === undefined
      ? {}
      : { service_instanceId: event.service.instanceId }),
    ...(event.request?.httpMethod === undefined
      ? {}
      : { request_httpMethod: event.request.httpMethod }),
    ...(event.request?.endpoint === undefined
      ? {}
      : { request_endpoint: event.request.endpoint }),
    ...(event.request?.routePattern === undefined
      ? {}
      : { request_routePattern: event.request.routePattern }),
    ...(event.request?.ipAddress === undefined
      ? {}
      : { request_ipAddress: event.request.ipAddress }),
    ...(event.request?.userAgent === undefined
      ? {}
      : { request_userAgent: event.request.userAgent }),
    ...(event.actor?.type === undefined
      ? {}
      : { actor_type: event.actor.type }),
    ...(event.actor?.userId === undefined
      ? {}
      : { actor_userId: event.actor.userId }),
    ...(event.actor?.userRole === undefined
      ? {}
      : { actor_userRole: event.actor.userRole }),
    ...(event.actor?.tenantId === undefined
      ? {}
      : { actor_tenantId: event.actor.tenantId }),
    ...(event.entity?.type === undefined
      ? {}
      : { entity_type: event.entity.type }),
    ...(event.entity?.id === undefined ? {} : { entity_id: event.entity.id }),
    ...(event.payload === undefined
      ? {}
      : { payload: JSON.stringify(event.payload) })
  };
}
