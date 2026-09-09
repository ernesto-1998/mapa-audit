import type { AuditEvent } from '@tnet06/mapa-audit-types';
import type { RabbitMQConnectionOptions } from '../src/rabbitmq-transport.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const amqpMocks = vi.hoisted(() => {
  type Listener = (event: unknown) => void;

  const setupResults: Array<Promise<unknown>> = [];
  const assertExchange = vi.fn().mockResolvedValue(undefined);
  const setupChannel = { assertExchange };
  const publish = vi.fn().mockResolvedValue(true);
  const channelClose = vi.fn().mockResolvedValue(undefined);
  const connectionClose = vi.fn().mockResolvedValue(undefined);
  const listeners = new Map<string, Set<Listener>>();
  const connection = {
    on: vi.fn((event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);

      return connection;
    }),
    removeListener: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);

      return connection;
    }),
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
    createChannel: vi.fn(),
    close: connectionClose
  };
  const createChannel = vi.fn(
    (options?: {
      setup?: (channel: typeof setupChannel) => Promise<void> | void;
    }) => {
      const setupResult = options?.setup?.(setupChannel);

      if (setupResult !== undefined) {
        setupResults.push(Promise.resolve(setupResult));
      }

      return {
        publish,
        close: channelClose
      };
    }
  );
  const connect = vi.fn(() => ({
    ...connection,
    createChannel
  }));

  return {
    assertExchange,
    channelClose,
    connection,
    connect,
    connectionClose,
    createChannel,
    listeners,
    publish,
    setupResults
  };
});

vi.mock('amqp-connection-manager', () => ({
  connect: amqpMocks.connect
}));

const { RabbitMQTransport } = await import('../src/rabbitmq-transport.js');

describe('RabbitMQTransport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    amqpMocks.assertExchange.mockClear();
    amqpMocks.assertExchange.mockResolvedValue(undefined);
    amqpMocks.channelClose.mockClear();
    amqpMocks.channelClose.mockResolvedValue(undefined);
    amqpMocks.connection.on.mockClear();
    amqpMocks.connection.removeListener.mockClear();
    amqpMocks.listeners.clear();
    amqpMocks.connect.mockClear();
    amqpMocks.connect.mockImplementation(() => ({
      ...amqpMocks.connection,
      createChannel: amqpMocks.createChannel
    }));
    amqpMocks.connectionClose.mockClear();
    amqpMocks.connectionClose.mockResolvedValue(undefined);
    amqpMocks.createChannel.mockClear();
    amqpMocks.publish.mockClear();
    amqpMocks.publish.mockResolvedValue(true);
    amqpMocks.setupResults.length = 0;
  });

  it('declares the exchange as topic and durable in channel setup', async () => {
    new RabbitMQTransport({ connection: 'amqp://localhost' });
    await waitForSetup();

    expect(amqpMocks.assertExchange).toHaveBeenCalledWith(
      'audit.events',
      'topic',
      {
        durable: true
      }
    );
  });

  it('passes connection URLs and connection options to amqp-connection-manager', () => {
    interface CustomConnectionOptions {
      reconnectTimeInSeconds?: number;
    }

    const connectionOptions: CustomConnectionOptions = {
      reconnectTimeInSeconds: 5
    };
    const acceptedConnectionOptions: RabbitMQConnectionOptions =
      connectionOptions;

    new RabbitMQTransport({
      connection: ['amqp://one', 'amqp://two'],
      connectionOptions: acceptedConnectionOptions
    });
    const [, passedConnectionOptions] = amqpMocks.connect.mock.calls[0] ?? [];

    expect(amqpMocks.connect).toHaveBeenCalledWith(
      ['amqp://one', 'amqp://two'],
      connectionOptions
    );
    expect(passedConnectionOptions).toBe(connectionOptions);
  });

  it('publishes with the configured exchange and a snake_case routing key', async () => {
    const transport = new RabbitMQTransport({
      connection: 'amqp://localhost',
      exchange: 'custom.audit.events'
    });
    const event = {
      ...auditEvent,
      eventType: 'securityAlert' as AuditEvent['eventType']
    };

    await transport.send(event);

    expect(amqpMocks.publish).toHaveBeenCalledWith(
      'custom.audit.events',
      'security_alert',
      expect.any(Buffer),
      {
        timeout: 5_000
      }
    );
  });

  it('publishes the event body as unchanged camelCase JSON', async () => {
    const transport = new RabbitMQTransport({ connection: 'amqp://localhost' });

    await transport.send(auditEvent);

    const [, , body] = amqpMocks.publish.mock.calls[0] ?? [];

    expect(Buffer.isBuffer(body)).toBe(true);
    expect(JSON.parse((body as Buffer).toString('utf8'))).toEqual(auditEvent);
  });

  it('does not propagate synchronous publish failures and emits a warning', async () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const transport = new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.publish.mockImplementationOnce(() => {
      throw new Error('sync publish failed');
    });

    await expect(transport.send(auditEvent)).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledWith(
      '[mapa-audit-transport-rabbitmq] rabbitmq transport publish failed: sync publish failed'
    );
  });

  it('does not propagate rejected publish promises and emits a warning', async () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const transport = new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.publish.mockRejectedValueOnce(new Error('async publish failed'));

    await expect(transport.send(auditEvent)).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledWith(
      '[mapa-audit-transport-rabbitmq] rabbitmq transport publish failed: async publish failed'
    );
  });

  it('emits a warning when the RabbitMQ connection fails', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.connection.emit('connectFailed', {
      err: new Error('connect ECONNREFUSED'),
      url: 'amqp://localhost'
    });

    expect(emitWarning).toHaveBeenCalledWith(
      '[mapa-audit-transport-rabbitmq] rabbitmq connection failed: connect ECONNREFUSED (url: amqp://localhost)'
    );
  });

  it('redacts username and password from connectFailed URL warnings', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.connection.emit('connectFailed', {
      err: new Error('connect ECONNREFUSED'),
      url: 'amqp://test-user:test-secret@rabbitmq:5672/audit'
    });

    const warning = emittedWarning(emitWarning);

    expect(warning).toContain(
      '[mapa-audit-transport-rabbitmq] rabbitmq connection failed: connect ECONNREFUSED'
    );
    expect(warning).toContain('(url: amqp://rabbitmq:5672/audit)');
    expect(warning).not.toContain('test-user');
    expect(warning).not.toContain('test-secret');
    expect(warning).not.toContain('test-user:test-secret@');
  });

  it('redacts percent-encoded credentials from connectFailed URL warnings', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.connection.emit('connectFailed', {
      err: new Error('connect ECONNREFUSED'),
      url: 'amqp://test%2Duser:test%2Dsecret@rabbitmq:5672/audit'
    });

    const warning = emittedWarning(emitWarning);

    expect(warning).toContain('(url: amqp://rabbitmq:5672/audit)');
    expect(warning).not.toContain('test%2Duser');
    expect(warning).not.toContain('test%2Dsecret');
    expect(warning).not.toContain('test-user');
    expect(warning).not.toContain('test-secret');
  });

  it('keeps a useful connectFailed URL when it has no credentials', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.connection.emit('connectFailed', {
      err: new Error('connect ECONNREFUSED'),
      url: 'amqps://rabbitmq:5671/audit'
    });

    const warning = emittedWarning(emitWarning);

    expect(warning).toContain('(url: amqps://rabbitmq:5671/audit)');
    expect(warning).not.toContain('[invalid connection URL redacted]');
  });

  it('omits the URL section when connectFailed has no URL', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.connection.emit('connectFailed', {
      err: new Error('connect ECONNREFUSED')
    });

    const warning = emittedWarning(emitWarning);

    expect(warning).toBe(
      '[mapa-audit-transport-rabbitmq] rabbitmq connection failed: connect ECONNREFUSED'
    );
    expect(warning).not.toContain('(url:');
  });

  it('fails closed for malformed connectFailed URL values', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.connection.emit('connectFailed', {
      err: new Error('connect ECONNREFUSED'),
      url: 'amqp://test-user:test-secret@%'
    });

    const warning = emittedWarning(emitWarning);

    expect(warning).toContain('(url: [invalid connection URL redacted])');
    expect(warning).not.toContain('test-user');
    expect(warning).not.toContain('test-secret');
    expect(warning).not.toContain('amqp://test-user:test-secret@%');
  });

  it('fails closed for unsupported connectFailed URL object shapes', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.connection.emit('connectFailed', {
      err: new Error('connect ECONNREFUSED'),
      url: {
        password: 'test-secret'
      }
    });

    const warning = emittedWarning(emitWarning);

    expect(warning).toContain('(url: [invalid connection URL redacted])');
    expect(warning).not.toContain('test-secret');
  });

  it('redacts credentials from connectFailed objects with a url property', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const connectionUrl = {
      url: 'amqp://test-user:test-secret@rabbitmq:5672/audit',
      connectionOptions: {
        timeout: 100
      }
    };

    new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.connection.emit('connectFailed', {
      err: new Error('connect ECONNREFUSED'),
      url: connectionUrl
    });

    const warning = emittedWarning(emitWarning);

    expect(connectionUrl.url).toBe(
      'amqp://test-user:test-secret@rabbitmq:5672/audit'
    );
    expect(warning).toContain('(url: amqp://rabbitmq:5672/audit)');
    expect(warning).not.toContain('test-user');
    expect(warning).not.toContain('test-secret');
  });

  it('redacts credentials from amqplib connection option objects', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const connectionOptions = {
      protocol: 'amqp',
      hostname: 'rabbitmq',
      port: 5672,
      username: 'test-user',
      password: 'test-secret',
      vhost: 'audit'
    };

    new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.connection.emit('connectFailed', {
      err: new Error('connect ECONNREFUSED'),
      url: connectionOptions
    });

    const warning = emittedWarning(emitWarning);

    expect(connectionOptions.username).toBe('test-user');
    expect(connectionOptions.password).toBe('test-secret');
    expect(warning).toContain('(url: amqp://rabbitmq:5672/audit)');
    expect(warning).not.toContain('test-user');
    expect(warning).not.toContain('test-secret');
  });

  it('emits a warning when RabbitMQ disconnects', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    new RabbitMQTransport({ connection: 'amqp://localhost' });
    amqpMocks.connection.emit('disconnect', {
      err: new Error('socket closed')
    });

    expect(emitWarning).toHaveBeenCalledWith(
      '[mapa-audit-transport-rabbitmq] rabbitmq disconnected: socket closed'
    );
  });

  it('times out a publish that never resolves without throwing', async () => {
    vi.useFakeTimers();
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const transport = new RabbitMQTransport({
      connection: 'amqp://localhost',
      publishTimeoutMs: 50
    });
    amqpMocks.publish.mockImplementationOnce(
      () => new Promise<boolean>(() => undefined)
    );

    const send = transport.send(auditEvent);

    await vi.advanceTimersByTimeAsync(50);
    await expect(send).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledWith(
      '[mapa-audit-transport-rabbitmq] rabbitmq transport publish timed out after 50ms'
    );
  });

  it('reports ChannelWrapper timeout rejections as publish timeouts', async () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const transport = new RabbitMQTransport({
      connection: 'amqp://localhost',
      publishTimeoutMs: 50
    });
    amqpMocks.publish.mockRejectedValueOnce(new Error('timeout'));

    await expect(transport.send(auditEvent)).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledWith(
      '[mapa-audit-transport-rabbitmq] rabbitmq transport publish timed out after 50ms'
    );
  });

  it('closes the channel and connection', async () => {
    const transport = new RabbitMQTransport({ connection: 'amqp://localhost' });

    await transport.close();

    expect(amqpMocks.channelClose).toHaveBeenCalledOnce();
    expect(amqpMocks.connectionClose).toHaveBeenCalledOnce();
  });

  it('removes connection listeners on close', async () => {
    const transport = new RabbitMQTransport({ connection: 'amqp://localhost' });

    expect(amqpMocks.connection.listenerCount('connectFailed')).toBe(1);
    expect(amqpMocks.connection.listenerCount('disconnect')).toBe(1);

    await transport.close();

    expect(amqpMocks.connection.listenerCount('connectFailed')).toBe(0);
    expect(amqpMocks.connection.listenerCount('disconnect')).toBe(0);
  });
});

async function waitForSetup(): Promise<void> {
  await Promise.all(amqpMocks.setupResults);
}

function emittedWarning(
  emitWarning: ReturnType<typeof vi.spyOn<typeof process, 'emitWarning'>>
): string {
  return String(emitWarning.mock.calls[0]?.[0]);
}

const auditEvent: AuditEvent = {
  id: 'event-id',
  correlationId: 'correlation-id',
  causationId: 'causation-id',
  eventType: 'business',
  eventName: 'payment.created',
  severity: 'info',
  outcome: 'success',
  occurredAt: '2026-01-01T00:00:00.000Z',
  payloadSchemaVersion: 1,
  service: {
    name: 'billing-api',
    version: '1.0.0',
    environment: 'development',
    instanceId: 'instance-1'
  },
  request: {
    httpMethod: 'POST',
    endpoint: '/payments',
    routePattern: '/payments',
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
    type: 'payment',
    id: 'payment-1'
  },
  payload: {
    amount: 100,
    creditCard: '***'
  }
};
