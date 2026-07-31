import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import {
  FastifyAdapter,
  type NestFastifyApplication
} from '@nestjs/platform-fastify';
import {
  initGlobalAudit,
  shutdownGlobalAudit,
  type Environment,
  type Transport
} from '@tnet06/mapa-audit-sdk';
import {
  ConsoleTransport,
  FileTransport
} from '@tnet06/mapa-audit-sdk/transports';
import { AppModule } from './app.module.js';

type AuditTransportName = 'console' | 'file-jsonl' | 'file-csv' | 'file-text';
type NestPlatformName = 'express' | 'fastify';

const currentDir = dirname(fileURLToPath(import.meta.url));
const packageRoot =
  basename(dirname(currentDir)) === 'dist'
    ? resolve(currentDir, '../..')
    : resolve(currentDir, '..');
const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const host = process.env.HOST ?? '127.0.0.1';
const auditTransportName = parseAuditTransport(process.env.AUDIT_TRANSPORT);
const platformName = parseNestPlatform(process.env.NEST_PLATFORM);

initGlobalAudit({
  serviceName: 'nestjs-demo',
  serviceVersion: '0.0.0',
  environment: getEnvironment(process.env.NODE_ENV),
  transports: [createAuditTransport(auditTransportName)],
  maskedFields: ['creditCard', 'user.ssn', 'card.cvv'],
  maxPayloadSize: 900
});

const app = await createApp(platformName);

await app.listen(port, host);

process.stdout.write(
  `nestjs-demo listening on http://${host}:${port} with NEST_PLATFORM=${platformName} AUDIT_TRANSPORT=${auditTransportName}\n`
);

process.on('SIGINT', () => {
  void stop(app, 'SIGINT');
});

process.on('SIGTERM', () => {
  void stop(app, 'SIGTERM');
});

async function createApp(
  platform: NestPlatformName
): Promise<INestApplication> {
  if (platform === 'fastify') {
    return NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { logger: false }
    );
  }

  return NestFactory.create(AppModule, new ExpressAdapter(), {
    logger: false
  });
}

function parseNestPlatform(value: string | undefined): NestPlatformName {
  if (value === undefined || value === 'express' || value === 'fastify') {
    return value ?? 'express';
  }

  throw new Error(
    `Unsupported NEST_PLATFORM "${value}". Use express or fastify.`
  );
}

function parseAuditTransport(value: string | undefined): AuditTransportName {
  if (
    value === undefined ||
    value === 'console' ||
    value === 'file-jsonl' ||
    value === 'file-csv' ||
    value === 'file-text'
  ) {
    return value ?? 'console';
  }

  throw new Error(
    `Unsupported AUDIT_TRANSPORT "${value}". Use console, file-jsonl, file-csv, or file-text.`
  );
}

function createAuditTransport(name: AuditTransportName): Transport {
  switch (name) {
    case 'console':
      return new ConsoleTransport();
    case 'file-jsonl':
      return new FileTransport({
        path: resolve(packageRoot, 'audit-output.jsonl'),
        format: 'jsonl'
      });
    case 'file-csv':
      return new FileTransport({
        path: resolve(packageRoot, 'audit-output.csv'),
        format: 'csv'
      });
    case 'file-text':
      return new FileTransport({
        path: resolve(packageRoot, 'audit-output.txt'),
        format: 'text'
      });
  }
}

function getEnvironment(value: string | undefined): Environment {
  if (value === 'production' || value === 'staging') {
    return value;
  }

  return 'development';
}

async function stop(
  appToClose: INestApplication,
  signal: NodeJS.Signals
): Promise<void> {
  process.stdout.write(`received ${signal}, shutting down nestjs-demo\n`);

  await appToClose.close();
  await shutdownGlobalAudit();
  process.exit(0);
}
