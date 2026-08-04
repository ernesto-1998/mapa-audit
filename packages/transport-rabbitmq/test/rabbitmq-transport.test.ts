import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const amqpMocks = vi.hoisted(() => {
  const setupResults: Array<Promise<unknown>> = [];
  const assertExchange = vi.fn().mockResolvedValue(undefined);
  const setupChannel = { assertExchange };
  const publish = vi.fn().mockResolvedValue(true);
  const channelClose = vi.fn().mockResolvedValue(undefined);
  const connectionClose = vi.fn().mockResolvedValue(undefined);
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
    createChannel,
    close: connectionClose
  }));

  return {
    assertExchange,
    channelClose,
    connect,
    connectionClose,
    createChannel,
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
    amqpMocks.assertExchange.mockClear();
    amqpMocks.assertExchange.mockResolvedValue(undefined);
    amqpMocks.channelClose.mockClear();
    amqpMocks.channelClose.mockResolvedValue(undefined);
    amqpMocks.connect.mockClear();
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
    const connectionOptions = {
      heartbeatIntervalInSeconds: 10,
      reconnectTimeInSeconds: 2
    };

    new RabbitMQTransport({
      connection: ['amqp://one', 'amqp://two'],
      connectionOptions
    });

    expect(amqpMocks.connect).toHaveBeenCalledWith(
      ['amqp://one', 'amqp://two'],
      connectionOptions
    );
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
      expect.any(Buffer)
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

  it('closes the channel and connection', async () => {
    const transport = new RabbitMQTransport({ connection: 'amqp://localhost' });

    await transport.close();

    expect(amqpMocks.channelClose).toHaveBeenCalledOnce();
    expect(amqpMocks.connectionClose).toHaveBeenCalledOnce();
  });
});

async function waitForSetup(): Promise<void> {
  await Promise.all(amqpMocks.setupResults);
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
