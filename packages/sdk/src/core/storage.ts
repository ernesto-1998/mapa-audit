import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditEvent } from '@tnet06/mapa-audit-types';

export interface RequestContext {
  correlationId: string;
  causationId?: string;
  request?: NonNullable<AuditEvent['request']>;
  actor?: NonNullable<AuditEvent['actor']>;
}

export const contextStore = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return contextStore.getStore();
}
