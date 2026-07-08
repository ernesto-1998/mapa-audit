import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { expressAdapter } from '../../src/adapters/express.js';
import { configureAudit } from '../../src/core/configure.js';
import { getContext } from '../../src/core/storage.js';
import { record } from '../../src/core/record.js';
import type { Transport } from '../../src/core/transport.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type MockRequest = Request & {
  user?: {
    id?: string;
    role?: string;
  };
  route?: {
    path?: string;
  };
};

function createRequest(options: {
  correlationId?: string;
  userAgent?: string;
  method?: string;
  originalUrl?: string;
  ip?: string;
  routePath?: string;
  user?: {
    id?: string;
    role?: string;
  };
}): MockRequest {
  const headers = new Map<string, string>();

  if (options.correlationId !== undefined) {
    headers.set('x-correlation-id', options.correlationId);
  }

  if (options.userAgent !== undefined) {
    headers.set('user-agent', options.userAgent);
  }

  return {
    method: options.method ?? 'GET',
    originalUrl: options.originalUrl ?? '/recipes/recipe-1',
    ...(options.ip === undefined ? {} : { ip: options.ip }),
    ...(options.routePath === undefined
      ? {}
      : { route: { path: options.routePath } }),
    ...(options.user === undefined ? {} : { user: options.user }),
    get(name: string) {
      return headers.get(name.toLowerCase());
    }
  } as MockRequest;
}

function createCapturingTransport(): {
  transport: Transport;
  events: AuditEvent[];
} {
  const events: AuditEvent[] = [];

  return {
    events,
    transport: {
      send(event) {
        events.push(event);
      }
    }
  };
}

describe('expressAdapter', () => {
  it('sets request context for the next middleware', () => {
    const middleware = expressAdapter();
    const request = createRequest({
      correlationId: 'correlation-1',
      userAgent: 'vitest',
      method: 'PATCH',
      originalUrl: '/recipes/recipe-1',
      ip: '127.0.0.1',
      routePath: '/recipes/:id',
      user: {
        id: 'user-1',
        role: 'admin'
      }
    });

    middleware(request, {} as Response, () => {
      expect(getContext()).toEqual({
        correlationId: 'correlation-1',
        request: {
          httpMethod: 'PATCH',
          endpoint: '/recipes/recipe-1',
          routePattern: '/recipes/:id',
          ipAddress: '127.0.0.1',
          userAgent: 'vitest'
        },
        actor: {
          userId: 'user-1',
          userRole: 'admin'
        }
      });
    });
  });

  it('reuses x-correlation-id when present', () => {
    expressAdapter()(
      createRequest({ correlationId: 'correlation-from-header' }),
      {} as Response,
      () => {
        expect(getContext()?.correlationId).toBe('correlation-from-header');
      }
    );
  });

  it('generates a UUID correlationId when the header is absent', () => {
    expressAdapter()(createRequest({}), {} as Response, () => {
      expect(getContext()?.correlationId).toMatch(uuidPattern);
    });
  });

  it('handles missing user, route, and optional headers defensively', () => {
    expect(() => {
      expressAdapter()(
        createRequest({
          method: 'GET',
          originalUrl: '/health'
        }),
        {} as Response,
        () => {
          expect(getContext()).toMatchObject({
            request: {
              httpMethod: 'GET',
              endpoint: '/health'
            }
          });
          expect(getContext()?.actor).toBeUndefined();
          expect(getContext()?.request?.routePattern).toBeUndefined();
          expect(getContext()?.request?.userAgent).toBeUndefined();
        }
      );
    }).not.toThrow();
  });

  it('lets record() use context captured by the adapter', () => {
    const { events, transport } = createCapturingTransport();

    configureAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    expressAdapter()(
      createRequest({
        correlationId: 'correlation-1',
        userAgent: 'vitest',
        method: 'POST',
        originalUrl: '/recipes',
        ip: '127.0.0.1',
        routePath: '/recipes',
        user: {
          id: 'user-1',
          role: 'editor'
        }
      }),
      {} as Response,
      () => {
        record({
          eventType: 'business',
          eventName: 'recipe.created',
          outcome: 'success',
          entity: {
            type: 'recipe',
            id: 'recipe-1'
          }
        });
      }
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      correlationId: 'correlation-1',
      eventType: 'business',
      eventName: 'recipe.created',
      service: {
        name: 'recipes-api',
        environment: 'development'
      },
      request: {
        httpMethod: 'POST',
        endpoint: '/recipes',
        routePattern: '/recipes',
        ipAddress: '127.0.0.1',
        userAgent: 'vitest'
      },
      actor: {
        userId: 'user-1',
        userRole: 'editor'
      }
    });
  });
});
