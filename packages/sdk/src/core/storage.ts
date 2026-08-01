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

/**
 * Replaces the actor for the current request context.
 *
 * Use this when identity is resolved after the audit adapter has already opened
 * the context, such as in a NestJS Guard or any later authentication step. The
 * actor fully replaces any actor captured by an adapter `extractActor` hook or a
 * previous `setActor()` call. Passing `undefined` clears the actor.
 *
 * Calling this outside an active request context is a silent no-op. The update
 * affects only the current AsyncLocalStorage context, so concurrent requests
 * remain isolated.
 */
export function setActor(actor: RequestContext['actor']): void {
  const ctx = getContext();

  if (ctx === undefined) {
    return;
  }

  if (actor === undefined) {
    delete ctx.actor;
    return;
  }

  ctx.actor = actor;
}
