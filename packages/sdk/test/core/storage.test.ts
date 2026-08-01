import { describe, expect, it } from 'vitest';
import { contextStore, getContext, setActor } from '../../src/core/storage.js';
import type { RequestContext } from '../../src/core/storage.js';

async function readContextDeeply(): Promise<RequestContext | undefined> {
  await Promise.resolve();

  return readContextDeeper();
}

async function readContextDeeper(): Promise<RequestContext | undefined> {
  await Promise.resolve();

  return getContext();
}

function runWithContext<T>(
  context: RequestContext,
  callback: () => Promise<T>
): Promise<T> {
  return contextStore.run(context, callback);
}

describe('context storage', () => {
  it('reads context from deeply nested async functions', async () => {
    const context: RequestContext = {
      correlationId: 'request-1',
      request: {
        endpoint: '/recipes/123',
        httpMethod: 'GET'
      },
      actor: {
        type: 'user',
        userId: 'user-1'
      }
    };

    const storedContext = await runWithContext(context, readContextDeeply);

    expect(storedContext).toEqual(context);
  });

  it('keeps concurrent contexts isolated', async () => {
    const readFirst = runWithContext(
      { correlationId: 'first-request' },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));

        return getContext()?.correlationId;
      }
    );

    const readSecond = runWithContext(
      { correlationId: 'second-request' },
      async () => {
        await Promise.resolve();

        return getContext()?.correlationId;
      }
    );

    await expect(Promise.all([readFirst, readSecond])).resolves.toEqual([
      'first-request',
      'second-request'
    ]);
  });

  it('returns undefined outside a context', () => {
    expect(getContext()).toBeUndefined();
  });

  it('updates actor inside an active context', () => {
    const context: RequestContext = {
      correlationId: 'request-1'
    };

    contextStore.run(context, () => {
      setActor({
        type: 'user',
        userId: 'user-1',
        userRole: 'admin'
      });

      expect(getContext()?.actor).toEqual({
        type: 'user',
        userId: 'user-1',
        userRole: 'admin'
      });
    });
  });

  it('replaces the previous actor without merging fields', () => {
    const context: RequestContext = {
      correlationId: 'request-1',
      actor: {
        type: 'user',
        userId: 'user-1',
        userRole: 'admin',
        tenantId: 'tenant-1'
      }
    };

    contextStore.run(context, () => {
      setActor({
        type: 'service',
        userId: 'service-1'
      });

      expect(getContext()?.actor).toEqual({
        type: 'service',
        userId: 'service-1'
      });
    });
  });

  it('clears the actor when setActor receives undefined', () => {
    const context: RequestContext = {
      correlationId: 'request-1',
      actor: {
        type: 'user',
        userId: 'user-1'
      }
    };

    contextStore.run(context, () => {
      setActor(undefined);

      expect(getContext()?.actor).toBeUndefined();
      expect(Object.hasOwn(getContext() ?? {}, 'actor')).toBe(false);
    });
  });

  it('does not throw when called outside an active context', () => {
    expect(() => {
      setActor({
        type: 'user',
        userId: 'user-1'
      });
    }).not.toThrow();
  });
});
