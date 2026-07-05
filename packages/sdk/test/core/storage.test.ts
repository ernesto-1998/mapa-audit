import { describe, expect, it } from 'vitest';
import { contextStore, getContext } from '../../src/core/storage.js';
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
});
