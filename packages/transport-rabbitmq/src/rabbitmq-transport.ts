import {
  connect,
  type AmqpConnectionManager,
  type AmqpConnectionManagerOptions,
  type Channel,
  type ChannelWrapper
} from 'amqp-connection-manager';
import type { AuditEvent, Transport } from '@tnet06/mapa-audit-types';
import { emitAuditWarning, errorMessage } from './warnings.js';

const defaultExchange = 'audit.events';
const defaultPublishTimeoutMs = 5_000;

interface ConnectionFailedEvent {
  err?: unknown;
  url?: unknown;
}

interface DisconnectEvent {
  err?: unknown;
}

/** Options for `RabbitMQTransport`. */
export interface RabbitMQTransportOptions {
  /**
   * AMQP broker URL or URLs used by `amqp-connection-manager`.
   *
   * Multiple URLs are passed through to the connection manager for its built-in
   * reconnect and round-robin behavior.
   */
  connection: string | string[];
  /**
   * RabbitMQ exchange that receives audit events.
   *
   * @default "audit.events"
   */
  exchange?: string;
  /**
   * Pass-through connection options for `amqp-connection-manager.connect()`.
   *
   * The transport does not interpret these options; it forwards them directly
   * to the broker client.
   */
  connectionOptions?: AmqpConnectionManagerOptions;
  /**
   * Maximum time to wait for one publish operation before reporting it as
   * failed from this transport.
   *
   * @default 5000
   */
  publishTimeoutMs?: number;
}

/**
 * Transport that publishes audit events to RabbitMQ.
 *
 * This transport only publishes events. It never consumes from queues; the
 * Worker is a separate service that owns queue consumption and persistence.
 *
 * The published message body is the canonical `AuditEvent` serialized as JSON,
 * preserving camelCase keys. Only the routing key is converted to snake_case to
 * match the queue/DB boundary described in `rabbitmq-worker-architecture.md`.
 */
export class RabbitMQTransport implements Transport {
  readonly #exchange: string;
  readonly #connection: AmqpConnectionManager;
  readonly #channel: ChannelWrapper;
  readonly #publishTimeoutMs: number;
  readonly #onConnectFailed = (event: ConnectionFailedEvent): void => {
    emitConnectionFailedWarning(event);
  };
  readonly #onDisconnect = (event: DisconnectEvent): void => {
    emitDisconnectWarning(event);
  };

  /** Creates a RabbitMQ transport and declares the configured topic exchange. */
  constructor(options: RabbitMQTransportOptions) {
    this.#exchange = options.exchange ?? defaultExchange;
    this.#publishTimeoutMs =
      options.publishTimeoutMs ?? defaultPublishTimeoutMs;
    this.#connection = connect(options.connection, options.connectionOptions);
    this.#connection.on('connectFailed', this.#onConnectFailed);
    this.#connection.on('disconnect', this.#onDisconnect);
    this.#channel = this.#connection.createChannel({
      name: 'mapa-audit-rabbitmq-transport',
      setup: async (channel: Channel) => {
        await channel.assertExchange(this.#exchange, 'topic', {
          durable: true
        });
      }
    });
  }

  /**
   * Publishes one audit event to RabbitMQ.
   *
   * Publish failures are emitted as warnings via `process.emitWarning` and are
   * not thrown into host application code.
   */
  async send(event: AuditEvent): Promise<void> {
    try {
      const publish = this.#channel.publish(
        this.#exchange,
        camelToSnakeCase(event.eventType),
        Buffer.from(JSON.stringify(event), 'utf8'),
        {
          timeout: this.#publishTimeoutMs
        }
      );
      const publishResult = await withPublishTimeout(
        publish,
        this.#publishTimeoutMs
      );

      if (publishResult === 'timeout') {
        emitPublishTimeoutWarning(this.#publishTimeoutMs);
      }
    } catch (error: unknown) {
      if (isPublishTimeoutError(error)) {
        emitPublishTimeoutWarning(this.#publishTimeoutMs);
        return;
      }

      emitPublishWarning(error);
    }
  }

  /**
   * Closes the RabbitMQ channel and connection.
   *
   * `amqp-connection-manager` does not expose a separate public drain hook for
   * in-flight publishes beyond `ChannelWrapper.close()`. This transport does
   * not add custom buffering, so broker-client lifecycle remains the library's
   * concern.
   */
  async close(): Promise<void> {
    this.#connection.removeListener('connectFailed', this.#onConnectFailed);
    this.#connection.removeListener('disconnect', this.#onDisconnect);
    await this.#channel.close();
    await this.#connection.close();
  }
}

function camelToSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function emitPublishWarning(error: unknown): void {
  emitAuditWarning(`rabbitmq transport publish failed: ${errorMessage(error)}`);
}

function isPublishTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout';
}

function emitPublishTimeoutWarning(timeoutMs: number): void {
  emitAuditWarning(`rabbitmq transport publish timed out after ${timeoutMs}ms`);
}

function emitConnectionFailedWarning(event: ConnectionFailedEvent): void {
  emitAuditWarning(
    `rabbitmq connection failed: ${connectionEventMessage(event)}`
  );
}

function emitDisconnectWarning(event: DisconnectEvent): void {
  emitAuditWarning(`rabbitmq disconnected: ${errorMessage(event.err)}`);
}

function connectionEventMessage(event: ConnectionFailedEvent): string {
  const message = errorMessage(event.err);

  if (event.url === undefined) {
    return message;
  }

  return `${message} (url: ${String(event.url)})`;
}

async function withPublishTimeout(
  publish: Promise<unknown>,
  timeoutMs: number
): Promise<'published' | 'timeout'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;
  const guardedPublish = publish.catch((error: unknown) => {
    if (didTimeout) {
      return undefined;
    }

    throw error;
  });
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => {
      didTimeout = true;
      resolve('timeout');
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      guardedPublish.then(() => 'published' as const),
      timeoutPromise
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
