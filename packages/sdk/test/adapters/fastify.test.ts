import fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { fastifyAdapter } from '../../src/adapters/fastify.js';
import {
  initGlobalAudit,
  resetGlobalAudit
} from '../../src/core/global-audit.js';
import { record } from '../../src/core/record.js';
import { getContext, type RequestContext } from '../../src/core/storage.js';
import type { Transport } from '../../src/core/transport.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type RequestWithDemoUser = FastifyRequest & {
  user?: {
    id?: string;
    role?: string;
  };
};

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

async function createApp(
  options: {
    attachUser?: boolean;
    registerAdapter?: (app: FastifyInstance) => Promise<void>;
  } = {}
): Promise<FastifyInstance> {
  const app = fastify();

  if (options.attachUser === true) {
    app.addHook('onRequest', (request, _reply, done) => {
      (request as RequestWithDemoUser).user = {
        id: 'user-1',
        role: 'admin'
      };
      done();
    });
  }

  if (options.registerAdapter === undefined) {
    await app.register(fastifyAdapter);
  } else {
    await options.registerAdapter(app);
  }

  return app;
}

describe('fastifyAdapter', () => {
  afterEach(() => {
    resetGlobalAudit();
  });

  it('keeps request context alive until the route handler', async () => {
    const app = await createApp({ attachUser: true });

    app.patch('/recipes/:id', () => getContext());

    const response = await app.inject({
      method: 'PATCH',
      url: '/recipes/recipe-1',
      headers: {
        'x-correlation-id': 'correlation-1',
        'user-agent': 'vitest'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<RequestContext>()).toEqual({
      correlationId: 'correlation-1',
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
        userRole: 'admin'
      }
    });

    await app.close();
  });

  it('reuses x-correlation-id when present', async () => {
    const app = await createApp();

    app.get('/context', () => ({
      correlationId: getContext()?.correlationId
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/context',
      headers: {
        'x-correlation-id': 'correlation-from-header'
      }
    });

    expect(response.json()).toEqual({
      correlationId: 'correlation-from-header'
    });

    await app.close();
  });

  it('generates a UUID correlationId when the header is absent', async () => {
    const app = await createApp();

    app.get('/context', () => ({
      correlationId: getContext()?.correlationId
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/context'
    });

    expect(response.json<{ correlationId: string }>().correlationId).toMatch(
      uuidPattern
    );

    await app.close();
  });

  it('sets causationId from x-causation-id when present', async () => {
    const app = await createApp();

    app.get('/context', () => ({
      causationId: getContext()?.causationId
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/context',
      headers: {
        'x-causation-id': 'causation-from-header'
      }
    });

    expect(response.json()).toEqual({
      causationId: 'causation-from-header'
    });

    await app.close();
  });

  it('leaves causationId absent when x-causation-id is missing', async () => {
    const app = await createApp();

    app.get('/context', () => ({
      causationId: getContext()?.causationId
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/context'
    });

    expect(response.json()).toEqual({});

    await app.close();
  });

  it('uses custom correlationId and causationId headers when configured', async () => {
    const app = await createApp({
      registerAdapter: async (fastifyApp) => {
        await fastifyApp.register(fastifyAdapter, {
          correlationIdHeader: 'X-Trace-Id',
          causationIdHeader: 'X-Parent-Event-Id'
        });
      }
    });

    app.get('/context', () => ({
      correlationId: getContext()?.correlationId,
      causationId: getContext()?.causationId
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/context',
      headers: {
        'x-correlation-id': 'ignored-correlation',
        'x-causation-id': 'ignored-causation',
        'x-trace-id': 'trace-from-custom-header',
        'x-parent-event-id': 'parent-from-custom-header'
      }
    });

    expect(response.json()).toEqual({
      correlationId: 'trace-from-custom-header',
      causationId: 'parent-from-custom-header'
    });

    await app.close();
  });

  it('uses default actor extraction from request.user', async () => {
    const app = await createApp({ attachUser: true });

    app.get('/context', () => ({
      actor: getContext()?.actor
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/context'
    });

    expect(response.json()).toEqual({
      actor: {
        type: 'user',
        userId: 'user-1',
        userRole: 'admin'
      }
    });

    await app.close();
  });

  it('uses custom actor extraction instead of request.user', async () => {
    const app = await createApp({
      attachUser: true,
      registerAdapter: async (fastifyApp) => {
        await fastifyApp.register(fastifyAdapter, {
          extractActor: () => ({
            type: 'service',
            userId: 'custom-id'
          })
        });
      }
    });

    app.get('/context', () => ({
      actor: getContext()?.actor
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/context'
    });

    expect(response.json()).toEqual({
      actor: {
        type: 'service',
        userId: 'custom-id'
      }
    });

    await app.close();
  });

  it('captures the route pattern for parameterized routes', async () => {
    const app = await createApp();

    app.get('/users/:id', () => ({
      routePattern: getContext()?.request?.routePattern
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/users/user-1'
    });

    expect(response.json()).toEqual({
      routePattern: '/users/:id'
    });

    await app.close();
  });

  it('isolates concurrent request contexts', async () => {
    const app = await createApp();

    app.get('/context', async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });

      return {
        correlationId: getContext()?.correlationId
      };
    });

    const [firstResponse, secondResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/context',
        headers: {
          'x-correlation-id': 'correlation-1'
        }
      }),
      app.inject({
        method: 'GET',
        url: '/context',
        headers: {
          'x-correlation-id': 'correlation-2'
        }
      })
    ]);

    expect(firstResponse.json()).toEqual({
      correlationId: 'correlation-1'
    });
    expect(secondResponse.json()).toEqual({
      correlationId: 'correlation-2'
    });

    await app.close();
  });

  it('lets record() use context captured by the adapter', async () => {
    const { events, transport } = createCapturingTransport();
    const app = await createApp({ attachUser: true });

    initGlobalAudit({
      serviceName: 'recipes-api',
      environment: 'development',
      transports: [transport]
    });

    app.post('/recipes/:id', () => {
      record({
        eventType: 'business',
        eventName: 'recipe.created',
        outcome: 'success',
        entity: {
          type: 'recipe',
          id: 'recipe-1'
        }
      });

      return {
        ok: true
      };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/recipes/recipe-1',
      headers: {
        'x-correlation-id': 'correlation-1',
        'user-agent': 'vitest'
      }
    });

    expect(response.statusCode).toBe(200);
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
        endpoint: '/recipes/recipe-1',
        routePattern: '/recipes/:id',
        ipAddress: '127.0.0.1',
        userAgent: 'vitest'
      },
      actor: {
        type: 'user',
        userId: 'user-1',
        userRole: 'admin'
      }
    });

    await app.close();
  });
});
