import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, {
  type NextFunction,
  type Request,
  type Response
} from 'express';
import {
  initGlobalAudit,
  record,
  shutdownGlobalAudit,
  type Environment,
  type Transport
} from '@tnet06/mapa-audit-sdk';
import { expressAdapter } from '@tnet06/mapa-audit-sdk/express';
import {
  ConsoleTransport,
  FileTransport
} from '@tnet06/mapa-audit-sdk/transports';

type AuditTransportName = 'console' | 'file-jsonl' | 'file-csv' | 'file-text';

type RequestWithDemoUser = Request & {
  user?: {
    id: string;
    role: string;
  };
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const packageRoot =
  basename(currentDir) === 'dist' ? resolve(currentDir, '..') : currentDir;
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '127.0.0.1';
const auditTransportName = parseAuditTransport(process.env.AUDIT_TRANSPORT);

initGlobalAudit({
  serviceName: 'express-demo',
  serviceVersion: '0.0.0',
  environment: getEnvironment(process.env.NODE_ENV),
  transports: [createAuditTransport(auditTransportName)],
  maskedFields: ['creditCard', 'user.ssn', 'card.cvv'],
  maxPayloadSize: 900
});

const app = express();

app.use(express.json({ limit: '64kb' }));
app.use(attachDemoUser);
app.use(expressAdapter());

// Demonstrates automatic request context plus a simple business audit event.
app.get('/users/:id', (req: Request<{ id: string }>, res: Response): void => {
  const user = {
    id: req.params.id,
    name: 'Ada Lovelace',
    email: 'ada@example.test'
  };

  record({
    eventType: 'business',
    eventName: 'user.viewed',
    outcome: 'success',
    entity: {
      type: 'user',
      id: req.params.id
    },
    payload: {
      viewedFrom: 'express-demo'
    }
  });

  res.json({ user });
});

// Demonstrates actor capture from req.user before the route records the event.
app.post(
  '/users',
  (
    req: Request<Record<string, never>, unknown, unknown>,
    res: Response
  ): void => {
    const body = payloadFromBody(req.body);
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

    res.status(201).json({
      id: userId,
      status: 'created'
    });
  }
);

// Demonstrates first-level and nested maskedFields in the emitted payload.
app.post(
  '/payments',
  (
    req: Request<Record<string, never>, unknown, unknown>,
    res: Response
  ): void => {
    const body = payloadFromBody(req.body);

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

    res.status(201).json({
      id: 'payment-demo-1',
      status: 'accepted'
    });
  }
);

// Demonstrates maxPayloadSize by sending a payload large enough to be truncated.
app.get('/reports/:id', (req: Request<{ id: string }>, res: Response): void => {
  record({
    eventType: 'business',
    eventName: 'report.generated',
    outcome: 'success',
    entity: {
      type: 'report',
      id: req.params.id
    },
    payload: buildLargeReportPayload(req.params.id)
  });

  res.json({
    id: req.params.id,
    status: 'generated',
    auditPayload: 'truncated'
  });
});

// Demonstrates a system event without an authenticated actor.
app.get('/health', (_req: Request, res: Response): void => {
  record({
    eventType: 'system',
    eventName: 'health.checked',
    severity: 'debug',
    outcome: 'success',
    payload: {
      status: 'ok'
    }
  });

  res.json({ status: 'ok' });
});

const server = app.listen(port, host, () => {
  process.stdout.write(
    `express-demo listening on http://${host}:${port} with AUDIT_TRANSPORT=${auditTransportName}\n`
  );
});

process.on('SIGINT', () => {
  stop('SIGINT');
});

process.on('SIGTERM', () => {
  stop('SIGTERM');
});

function attachDemoUser(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (req.path !== '/health') {
    (req as RequestWithDemoUser).user = {
      id: 'demo-user-1',
      role: 'demo-admin'
    };
  }

  next();
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

function stop(signal: NodeJS.Signals): void {
  process.stdout.write(`received ${signal}, shutting down express-demo\n`);

  server.close(() => {
    void shutdownGlobalAudit().finally(() => {
      process.exit(0);
    });
  });
}
