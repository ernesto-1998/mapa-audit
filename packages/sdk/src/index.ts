export {
  actorTypes,
  environments,
  eventOutcomes,
  eventSeverities,
  eventTypes
} from '@tnet06/mapa-audit-types';
export { createAudit } from './core/audit-instance.js';
export {
  getGlobalAudit,
  initGlobalAudit,
  resetGlobalAudit,
  shutdownGlobalAudit
} from './core/global-audit.js';
export { record } from './core/record.js';
export { setActor } from './core/storage.js';

export type {
  ActorType,
  AuditEvent,
  Environment,
  EventOutcome,
  EventSeverity,
  EventType
} from '@tnet06/mapa-audit-types';
export type {
  AuditConfig,
  AuditInstance,
  GlobalAuditInfo
} from './core/audit-instance.js';
export type { RecordInput } from './core/record.js';
export type { Transport } from './core/transport.js';
