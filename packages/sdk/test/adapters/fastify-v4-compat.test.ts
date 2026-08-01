import fastify4, { type FastifyPluginCallback } from 'fastify4';
import { describe, expect, it } from 'vitest';
import {
  fastifyAdapter,
  type FastifyAdapterOptions
} from '../../src/adapters/fastify.js';
import { getContext, type RequestContext } from '../../src/core/storage.js';

// The adapter is compiled against the primary Fastify v5 types. This compat
// test intentionally registers the same runtime plugin in a v4 app, so bridge
// the duplicate Fastify type identities only inside this test.
const fastify4Adapter =
  fastifyAdapter as unknown as FastifyPluginCallback<FastifyAdapterOptions>;

describe('fastifyAdapter Fastify v4 compatibility', () => {
  it('keeps request context alive until the route handler in a real Fastify v4 app', async () => {
    const app = fastify4();

    await app.register(fastify4Adapter);

    app.patch('/recipes/:id', () => getContext());

    const response = await app.inject({
      method: 'PATCH',
      url: '/recipes/recipe-1',
      headers: {
        'x-correlation-id': 'correlation-v4',
        'user-agent': 'vitest-fastify-v4'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<RequestContext>()).toEqual({
      correlationId: 'correlation-v4',
      request: {
        httpMethod: 'PATCH',
        endpoint: '/recipes/recipe-1',
        routePattern: '/recipes/:id',
        ipAddress: '127.0.0.1',
        userAgent: 'vitest-fastify-v4'
      }
    });

    await app.close();
  });

  it('captures routePattern through routerPath fallback in a real Fastify v4 app', async () => {
    const app = fastify4();

    await app.register(fastify4Adapter);

    app.get('/users/:id', () => ({
      routePattern: getContext()?.request?.routePattern
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/users/user-1'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      routePattern: '/users/:id'
    });

    await app.close();
  });
});
