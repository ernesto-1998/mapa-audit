import {
  environments,
  type AuditEvent,
  type Environment
} from '@tnet06/mapa-audit-types';
import { ConsoleTransport } from '../transports/console.js';
import type { Transport } from './transport.js';

export interface AuditConfig {
  serviceName: string;
  serviceVersion?: string;
  environment: Environment;
  transports?: Transport[];
}

interface AuditRuntimeState {
  service: AuditEvent['service'] | undefined;
  transports: Transport[];
}

const state: AuditRuntimeState = {
  service: undefined,
  transports: []
};

export function configureAudit(config: AuditConfig): void {
  if (!isEnvironment(config.environment)) {
    throw new Error(
      `[mapa-audit] invalid environment "${String(config.environment)}"`
    );
  }

  state.service = {
    name: config.serviceName,
    ...(config.serviceVersion === undefined
      ? {}
      : { version: config.serviceVersion }),
    environment: config.environment
  };

  state.transports = config.transports ?? [new ConsoleTransport()];
}

export function getConfiguredService(): AuditEvent['service'] | undefined {
  return state.service;
}

export function getConfiguredTransports(): readonly Transport[] {
  return state.transports;
}

function isEnvironment(value: string): value is Environment {
  return environments.includes(value as Environment);
}
