import {
  environments,
  type AuditEvent,
  type Environment
} from '@tnet06/mapa-audit-types';
import { ConsoleTransport } from '../transports/console.js';
import {
  buildAuditEvent,
  sendFireAndForget,
  type PayloadOptions,
  type RecordInput
} from './record.js';
import type { Transport } from './transport.js';

/**
 * Configuration for an audit SDK instance.
 *
 * Use this with `createAudit()` for an explicit instance, or with
 * `initGlobalAudit()` for the convenience singleton.
 */
export interface AuditConfig {
  /** Logical service name written into every emitted audit event. */
  serviceName: string;
  /** Optional service version written into event service metadata. */
  serviceVersion?: string;
  /** Runtime environment for the emitting service. */
  environment: Environment;
  /**
   * Destinations that receive each event.
   *
   * @default [new ConsoleTransport()]
   */
  transports?: Transport[];
  /**
   * Dot-notation payload paths to mask before dispatching events.
   *
   * Examples: `creditCard`, `user.ssn`, `payment.card.cvv`.
   * Array indexing is not supported in this version.
   */
  maskedFields?: string[];
  /**
   * Maximum serialized payload size in bytes before replacing it with a
   * truncation marker.
   *
   * @default 1000000
   */
  maxPayloadSize?: number;
}

/**
 * Independent audit client with isolated service metadata, transports, and
 * payload safety options.
 */
export interface AuditInstance {
  /**
   * Builds and dispatches one audit event to this instance's transports.
   *
   * This method is fire-and-forget: transport errors are contained and reported
   * as warnings rather than thrown into host application code.
   */
  record(input: RecordInput): void;
  /**
   * Drains transports that expose `close()` so pending writes can finish before
   * process shutdown.
   */
  shutdown(): Promise<void>;
  /**
   * Returns a read-only inspection snapshot for this instance.
   *
   * The returned object does not expose transports or mutating methods.
   */
  getInfo(): GlobalAuditInfo;
}

/** Read-only inspection view for a configured audit instance/global singleton. */
export interface GlobalAuditInfo {
  /** Always true when an audit instance exists. */
  readonly configured: true;
  /** Service name configured for this audit instance. */
  readonly serviceName: string;
  /** Environment configured for this audit instance. */
  readonly environment: Environment;
  /** Number of transports currently configured on this instance. */
  readonly transportCount: number;
}

/**
 * Creates an isolated audit client with its own configuration.
 *
 * Prefer this for tests, multi-tenant apps, or any process that needs multiple
 * independent audit configurations. Use `initGlobalAudit()` for the simpler
 * singleton API.
 *
 * @param config Service metadata, transports, and payload safety options.
 * @returns An independent audit instance.
 */
export function createAudit(config: AuditConfig): AuditInstance {
  if (!isEnvironment(config.environment)) {
    throw new Error(
      `[mapa-audit] invalid environment "${String(config.environment)}"`
    );
  }

  const service: AuditEvent['service'] = {
    name: config.serviceName,
    ...(config.serviceVersion === undefined
      ? {}
      : { version: config.serviceVersion }),
    environment: config.environment
  };
  const transports: Transport[] = config.transports ?? [new ConsoleTransport()];
  const payloadOptions: PayloadOptions = {
    ...(config.maskedFields === undefined
      ? {}
      : { maskedFields: config.maskedFields }),
    ...(config.maxPayloadSize === undefined
      ? {}
      : { maxPayloadSize: config.maxPayloadSize })
  };
  let isShutdown = false;
  let shutdownPromise: Promise<void> | undefined;

  return {
    record(input) {
      if (isShutdown) {
        return;
      }

      const event = buildAuditEvent(input, service, payloadOptions);

      for (const transport of transports) {
        sendFireAndForget(transport, event);
      }
    },
    getInfo() {
      return {
        configured: true,
        serviceName: service.name,
        environment: service.environment,
        transportCount: transports.length
      };
    },
    async shutdown() {
      if (shutdownPromise !== undefined) {
        await shutdownPromise;
        return;
      }

      isShutdown = true;
      shutdownPromise = Promise.all(
        transports.map(async (transport) => {
          await transport.close?.();
        })
      ).then(() => undefined);

      await shutdownPromise;
    }
  };
}

export function isEnvironment(value: string): value is Environment {
  return environments.includes(value as Environment);
}
