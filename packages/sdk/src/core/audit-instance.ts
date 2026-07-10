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

export interface AuditConfig {
  serviceName: string;
  serviceVersion?: string;
  environment: Environment;
  transports?: Transport[];
  /**
   * Dot-notation payload paths to mask before dispatching events.
   * Array indexing is not supported in this version.
   */
  maskedFields?: string[];
  maxPayloadSize?: number;
}

export interface AuditInstance {
  record(input: RecordInput): void;
  shutdown(): Promise<void>;
  getInfo(): GlobalAuditInfo;
}

export interface GlobalAuditInfo {
  readonly configured: true;
  readonly serviceName: string;
  readonly environment: Environment;
  readonly transportCount: number;
}

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
