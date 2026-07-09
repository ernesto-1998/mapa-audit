import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import {
  initGlobalAudit,
  resetGlobalAudit
} from '../../src/core/global-audit.js';
import { record } from '../../src/core/record.js';
import { ConsoleTransport } from '../../src/transports/console.js';

const event: AuditEvent = {
  id: 'event-1',
  correlationId: 'correlation-1',
  eventType: 'business',
  eventName: 'recipe.updated',
  severity: 'info',
  outcome: 'success',
  occurredAt: '2026-07-05T00:00:00.000Z',
  service: {
    name: 'recipes-api',
    environment: 'development'
  },
  request: {
    httpMethod: 'PATCH',
    endpoint: '/recipes/recipe-1',
    routePattern: '/recipes/:id',
    ipAddress: '127.0.0.1',
    userAgent: 'vitest'
  },
  actor: {
    type: 'user',
    userId: 'user-1',
    userRole: 'admin',
    tenantId: 'tenant-1'
  },
  entity: {
    type: 'recipe',
    id: 'recipe-1'
  },
  payload: {
    changedFields: ['title']
  }
};

describe('ConsoleTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetGlobalAudit();
  });

  it('writes info events to stdout as single-line JSON', () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    new ConsoleTransport().send(event);

    expect(stdoutWrite).toHaveBeenCalledWith(`${JSON.stringify(event)}\n`);
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('writes error events to stderr and not stdout', () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const errorEvent: AuditEvent = {
      ...event,
      severity: 'error'
    };

    new ConsoleTransport().send(errorEvent);

    expect(stderrWrite).toHaveBeenCalledWith(`${JSON.stringify(errorEvent)}\n`);
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('writes critical events to stderr', () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const criticalEvent: AuditEvent = {
      ...event,
      severity: 'critical'
    };

    new ConsoleTransport().send(criticalEvent);

    expect(stderrWrite).toHaveBeenCalledWith(
      `${JSON.stringify(criticalEvent)}\n`
    );
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('emits the nested event structure without flattening it', () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    new ConsoleTransport().send(event);

    const line = stdoutWrite.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');

    const parsed = JSON.parse(String(line)) as AuditEvent;
    expect(parsed.service).toEqual(event.service);
    expect(parsed.request).toEqual(event.request);
    expect(parsed.actor).toEqual(event.actor);
    expect(parsed.entity).toEqual(event.entity);
    expect(Object.hasOwn(parsed, 'service_name')).toBe(false);
    expect(Object.hasOwn(parsed, 'request_httpMethod')).toBe(false);
  });

  it('is used as the default transport by initGlobalAudit', () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development'
    });

    record({
      eventType: 'business',
      eventName: 'recipe.updated'
    });

    expect(stdoutWrite).toHaveBeenCalledTimes(1);
    const line = stdoutWrite.mock.calls[0]?.[0];
    const parsed = JSON.parse(String(line)) as AuditEvent;
    expect(parsed).toMatchObject({
      eventType: 'business',
      eventName: 'recipe.updated',
      severity: 'info',
      service: {
        name: 'recipes-api',
        environment: 'development'
      },
      payload: {}
    });
  });
});
