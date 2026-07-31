import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { AuditContextMiddleware } from '../../src/adapters/nestjs.js';
import {
  initGlobalAudit,
  resetGlobalAudit
} from '../../src/core/global-audit.js';
import { record } from '../../src/core/record.js';
import { getContext } from '../../src/core/storage.js';
import type { Transport } from '../../src/core/transport.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type MockNestRequest = {
  method: string;
  url: string;
  originalUrl?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
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
  causationId?: string;
  userAgent?: string;
  method?: string;
  url?: string;
  originalUrl?: string;
  ip?: string;
  user?: {
    id?: string;
    role?: string;
  };
  headers?: Record<string, string>;
}): MockNestRequest {
  const headers: Record<string, string> = {};

  if (options.correlationId !== undefined) {
    headers['x-correlation-id'] = options.correlationId;
  }

  if (options.causationId !== undefined) {
    headers['x-causation-id'] = options.causationId;
  }

  if (options.userAgent !== undefined) {
    headers['user-agent'] = options.userAgent;
  }

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/recipes/recipe-1',
    ...(options.originalUrl === undefined
      ? {}
      : { originalUrl: options.originalUrl }),
    ...(options.ip === undefined ? {} : { ip: options.ip }),
    headers,
    ...(options.user === undefined ? {} : { user: options.user })
  };
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

describe('AuditContextMiddleware', () => {
  afterEach(() => {
    resetGlobalAudit();
  });

  it('sets request context for the next middleware', () => {
    const middleware = new AuditContextMiddleware();
    const request = createRequest({
      correlationId: 'correlation-1',
      userAgent: 'vitest',
      method: 'PATCH',
      originalUrl: '/recipes/recipe-1',
      ip: '127.0.0.1',
      user: {
        id: 'user-1',
        role: 'admin'
      }
    });

    middleware.use(request, {}, () => {
      expect(getContext()).toEqual({
        correlationId: 'correlation-1',
        request: {
          httpMethod: 'PATCH',
          endpoint: '/recipes/recipe-1',
          ipAddress: '127.0.0.1',
          userAgent: 'vitest'
        },
        actor: {
          type: 'user',
          userId: 'user-1',
          userRole: 'admin'
        }
      });
    });
  });

  it('reuses x-correlation-id when present', () => {
    new AuditContextMiddleware().use(
      createRequest({ correlationId: 'correlation-from-header' }),
      {},
      () => {
        expect(getContext()?.correlationId).toBe('correlation-from-header');
      }
    );
  });

  it('sets causationId from x-causation-id when present', () => {
    new AuditContextMiddleware().use(
      createRequest({ causationId: 'causation-from-header' }),
      {},
      () => {
        expect(getContext()?.causationId).toBe('causation-from-header');
      }
    );
  });

  it('leaves causationId absent when x-causation-id is missing', () => {
    new AuditContextMiddleware().use(createRequest({}), {}, () => {
      expect(getContext()?.causationId).toBeUndefined();
    });
  });

  it('uses custom correlationId and causationId headers when configured', () => {
    new AuditContextMiddleware({
      correlationIdHeader: 'X-Trace-Id',
      causationIdHeader: 'X-Parent-Event-Id'
    }).use(
      createRequest({
        correlationId: 'ignored-correlation',
        causationId: 'ignored-causation',
        headers: {
          'x-trace-id': 'trace-from-custom-header',
          'x-parent-event-id': 'parent-from-custom-header'
        }
      }),
      {},
      () => {
        expect(getContext()?.correlationId).toBe('trace-from-custom-header');
        expect(getContext()?.causationId).toBe('parent-from-custom-header');
      }
    );
  });

  it('generates a UUID correlationId when the header is absent', () => {
    new AuditContextMiddleware().use(createRequest({}), {}, () => {
      expect(getContext()?.correlationId).toMatch(uuidPattern);
    });
  });

  it('handles missing user and optional headers defensively', () => {
    expect(() => {
      new AuditContextMiddleware().use(
        createRequest({
          method: 'GET',
          url: '/health'
        }),
        {},
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

  it('uses custom actor extraction instead of req.user', () => {
    new AuditContextMiddleware({
      extractActor: () => ({
        type: 'service',
        userId: 'custom-id'
      })
    }).use(
      createRequest({
        user: {
          id: 'ignored-user',
          role: 'ignored-role'
        }
      }),
      {},
      () => {
        expect(getContext()?.actor).toEqual({
          type: 'service',
          userId: 'custom-id'
        });
      }
    );
  });

  it('uses the common Nest request shape with Express-like and Fastify-like mocks', () => {
    const middleware = new AuditContextMiddleware();

    const expressLikeRequest = {
      ...createRequest({
        correlationId: 'express-correlation',
        method: 'POST',
        originalUrl: '/recipes/recipe-1',
        url: '/recipes/recipe-1?include=steps'
      }),
      route: {
        path: '/recipes/:id'
      }
    };
    const fastifyLikeRequest = createRequest({
      correlationId: 'fastify-correlation',
      method: 'POST',
      url: '/recipes/recipe-2'
    });

    middleware.use(expressLikeRequest, {}, () => {
      expect(getContext()).toMatchObject({
        correlationId: 'express-correlation',
        request: {
          httpMethod: 'POST',
          endpoint: '/recipes/recipe-1'
        }
      });
      expect(getContext()?.request?.routePattern).toBeUndefined();
    });

    middleware.use(fastifyLikeRequest, {}, () => {
      expect(getContext()).toMatchObject({
        correlationId: 'fastify-correlation',
        request: {
          httpMethod: 'POST',
          endpoint: '/recipes/recipe-2'
        }
      });
      expect(getContext()?.request?.routePattern).toBeUndefined();
    });
  });

  it('lets record() use context captured by the adapter', () => {
    const { events, transport } = createCapturingTransport();

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    new AuditContextMiddleware().use(
      createRequest({
        correlationId: 'correlation-1',
        userAgent: 'vitest',
        method: 'POST',
        originalUrl: '/recipes',
        ip: '127.0.0.1',
        user: {
          id: 'user-1',
          role: 'editor'
        }
      }),
      {},
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
        ipAddress: '127.0.0.1',
        userAgent: 'vitest'
      },
      actor: {
        type: 'user',
        userId: 'user-1',
        userRole: 'editor'
      }
    });
  });
});
