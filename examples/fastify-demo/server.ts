import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyRequest } from 'fastify';
import {
  initGlobalAudit,
  record,
  shutdownGlobalAudit,
  type Environment,
  type Transport
} from '@tnet06/mapa-audit-sdk';
import { fastifyAdapter } from '@tnet06/mapa-audit-sdk/fastify';
import {
  ConsoleTransport,
  FileTransport
} from '@tnet06/mapa-audit-sdk/transports';

type AuditTransportName = 'console' | 'file-jsonl' | 'file-csv' | 'file-text';

type DemoUser = {
  id: string;
  role: string;
};

type RequestWithDemoUser = FastifyRequest & {
  user?: DemoUser;
};

type IdParams = {
  id: string;
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const packageRoot =
  basename(currentDir) === 'dist' ? resolve(currentDir, '..') : currentDir;
const port = Number.parseInt(process.env.PORT ?? '3002', 10);
const host = process.env.HOST ?? '127.0.0.1';
const auditTransportName = parseAuditTransport(process.env.AUDIT_TRANSPORT);

initGlobalAudit({
  serviceName: 'fastify-demo',
  serviceVersion: '0.0.0',
  environment: getEnvironment(process.env.NODE_ENV),
  transports: [createAuditTransport(auditTransportName)],
  maskedFields: ['creditCard', 'user.ssn', 'card.cvv'],
  maxPayloadSize: 900
});

const app = fastify({
  logger: false
});

// Fastify runs hooks in registration order, so the demo actor is attached
// before fastifyAdapter captures the request context.
app.addHook('onRequest', (request, _reply, done) => {
  if (request.url !== '/health') {
    (request as RequestWithDemoUser).user = {
      id: 'demo-user-1',
      role: 'demo-admin'
    };
  }

  done();
});

await app.register(fastifyAdapter);

// Demonstrates automatic request context plus Fastify routePattern capture.
app.get<{ Params: IdParams }>('/users/:id', (request) => {
  const user = {
    id: request.params.id,
    name: 'Ada Lovelace',
    email: 'ada@example.test'
  };

  record({
    eventType: 'business',
    eventName: 'user.viewed',
    outcome: 'success',
    entity: {
      type: 'user',
      id: request.params.id
    },
    payload: {
      viewedFrom: 'fastify-demo'
    }
  });

  return { user };
});

// Demonstrates actor capture from request.user before the route records.
app.post<{ Body: unknown }>('/users', (request, reply) => {
  const body = payloadFromBody(request.body);
  const userId = stringField(body.id) ?? 'created-user-1';

  record({
    eventType: 'business',
    eventName: 'user.created',
    outcome: 'success',
    entity: {
      type: 'user',
      id: userId
    },
    payload: body
  });

  return reply.status(201).send({
    id: userId,
    status: 'created'
  });
});

// Demonstrates first-level and nested maskedFields in the emitted payload.
app.post<{ Body: unknown }>('/payments', (request, reply) => {
  const body = payloadFromBody(request.body);

  record({
    eventType: 'business',
    eventName: 'payment.created',
    severity: 'info',
    outcome: 'success',
    entity: {
      type: 'payment',
      id: 'payment-demo-1'
    },
    payload: body
  });

  return reply.status(201).send({
    id: 'payment-demo-1',
    status: 'accepted'
  });
});

// Demonstrates maxPayloadSize by sending a payload large enough to be truncated.
app.get<{ Params: IdParams }>('/reports/:id', (request) => {
  record({
    eventType: 'business',
    eventName: 'report.generated',
    outcome: 'success',
    entity: {
      type: 'report',
      id: request.params.id
    },
    payload: buildLargeReportPayload(request.params.id)
  });

  return {
    id: request.params.id,
    status: 'generated',
    auditPayload: 'truncated'
  };
});

// Demonstrates a system event without an authenticated actor.
app.get('/health', () => {
  record({
    eventType: 'system',
    eventName: 'health.checked',
    severity: 'debug',
    outcome: 'success',
    payload: {
      status: 'ok'
    }
  });

  return { status: 'ok' };
});

await app.listen({
  port,
  host
});

process.stdout.write(
  `fastify-demo listening on http://${host}:${port} with AUDIT_TRANSPORT=${auditTransportName}\n`
);

process.on('SIGINT', () => {
  void stop('SIGINT');
});

process.on('SIGTERM', () => {
  void stop('SIGTERM');
});

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

function payloadFromBody(body: unknown): Record<string, unknown> {
  if (isRecord(body)) {
    return body;
  }

  return {
    value: body
  };
}

function buildLargeReportPayload(reportId: string): Record<string, unknown> {
  return {
    reportId,
    rows: Array.from({ length: 80 }, (_, index) => ({
      index,
      metric: `metric-${index}`,
      description:
        'Repeated demo report content used to exceed the configured audit payload limit.'
    }))
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function stop(signal: NodeJS.Signals): Promise<void> {
  process.stdout.write(`received ${signal}, shutting down fastify-demo\n`);

  await app.close();
  await shutdownGlobalAudit();
  process.exit(0);
}
