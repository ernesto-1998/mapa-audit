export {
  actorTypes,
  environments,
  eventOutcomes,
  eventSeverities,
  eventTypes
} from '@tnet06/mapa-audit-types';
export { configureAudit } from './core/configure.js';
export { record } from './core/record.js';

export type {
  ActorType,
  AuditEvent,
  Environment,
  EventOutcome,
  EventSeverity,
  EventType
} from '@tnet06/mapa-audit-types';
export type { AuditConfig } from './core/configure.js';
export type { RecordInput } from './core/record.js';
export type { Transport } from './core/transport.js';
