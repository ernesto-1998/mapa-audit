# Mapa Audit Platform

Audit and business observability SDK for Node.js: automatic request context
capture, a structured audit event model, built-in data safety, and pluggable
transports.

## Why This Exists

Mapa Audit is not a replacement for general-purpose loggers such as Pino or
Winston. Its value is a higher-level audit model: framework-aware request
context capture, typed business/audit/security events, actor/entity separation,
payload masking, payload size limits, and transports that receive one canonical
event shape.

## Installation

This repository is currently a private monorepo. The packages have
`"private": true` and are not published to the public npm registry yet, so public
`npm install @tnet06/...` commands will not work until publishing metadata is
finalized.

Packages implemented today:

| Package                                 |            Status | Purpose                                                                                    |
| --------------------------------------- | ----------------: | ------------------------------------------------------------------------------------------ |
| `@tnet06/mapa-audit-sdk`                | private workspace | Core SDK, global/creational APIs, Express/Fastify/NestJS adapters, console/file transports |
| `@tnet06/mapa-audit-types`              | private workspace | Shared `AuditEvent`, enum unions, and `Transport` contract                                 |
| `@tnet06/mapa-audit-transport-rabbitmq` | private workspace | Optional RabbitMQ publisher transport                                                      |

For local development from this monorepo:

```sh
npm install
npm run build
npm test
```

`@tnet06/mapa-audit-types` is a dependency of the SDK and usually does not need
to be installed manually by application code. Custom transports should import
`Transport` and `AuditEvent` directly from `@tnet06/mapa-audit-types`.

## Quickstart

Minimal Express app using the global API, automatic context capture, and the
default console transport:

```ts
import express from 'express';
import {
  initGlobalAudit,
  record,
  shutdownGlobalAudit
} from '@tnet06/mapa-audit-sdk';
import { expressAdapter } from '@tnet06/mapa-audit-sdk/express';

initGlobalAudit({
  serviceName: 'users-api',
  environment: 'development'
});

const app = express();

app.use(express.json());
app.use(expressAdapter());

app.get('/users/:id', (req, res) => {
  record({
    eventType: 'business',
    eventName: 'user.viewed',
    outcome: 'success',
    entity: {
      type: 'user',
      id: req.params.id
    },
    payload: {
      source: 'quickstart'
    }
  });

  res.json({
    id: req.params.id,
    name: 'Ada Lovelace'
  });
});

const server = app.listen(3000);

process.on('SIGTERM', () => {
  server.close(() => {
    void shutdownGlobalAudit().finally(() => process.exit(0));
  });
});
```

Important: register `expressAdapter()` before routes that call `record()`.

## Core Concepts

### AuditEvent

Every transport receives the same canonical nested event:

```ts
interface AuditEvent {
  readonly id: string;
  correlationId?: string;
  causationId?: string;
  eventType: 'request' | 'business' | 'audit' | 'error' | 'security' | 'system';
  eventName: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  outcome?: 'success' | 'failure' | 'partial';
  readonly occurredAt: string;
  payloadSchemaVersion?: number;
  service: {
    name: string;
    version?: string;
    environment: 'development' | 'staging' | 'production';
    instanceId?: string;
  };
  request?: {
    httpMethod?: string;
    endpoint?: string;
    routePattern?: string;
    ipAddress?: string;
    userAgent?: string;
  };
  actor?: {
    type?: 'user' | 'service' | 'system' | 'job';
    userId?: string;
    userRole?: string;
    tenantId?: string;
  };
  entity?: {
    type?: string;
    id?: string;
  };
  payload?: Record<string, unknown>;
}
```

The event is nested in the SDK. Flattening happens only at output boundaries
that need it, such as CSV.

### Actor vs Entity

`actor` is who or what performed the action. `entity` is the domain object
affected by the action.

Example: if a superuser modifies another user's role:

```ts
record({
  eventType: 'audit',
  eventName: 'user.role_changed',
  outcome: 'success',
  entity: {
    type: 'user',
    id: 'target-user-123'
  },
  payload: {
    previousRole: 'viewer',
    newRole: 'admin'
  }
});
```

In the emitted event, the adapter-captured `actor` is the superuser. The
`entity` is `target-user-123`.

### Automatic Context Capture

Framework adapters open an `AsyncLocalStorage` context for each request. Code
inside that request can call `record()` without manually passing request data.

| Event part                                                           | Filled by                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `id`, `occurredAt`                                                   | SDK `record()`                                                     |
| `service`                                                            | `initGlobalAudit()` or `createAudit()` config                      |
| `correlationId`, `causationId`                                       | Adapter headers or generated correlation id                        |
| `request`                                                            | Framework adapter                                                  |
| `actor`                                                              | Adapter default extraction, custom `extractActor`, or `setActor()` |
| `eventType`, `eventName`, `severity`, `outcome`, `entity`, `payload` | Developer's `record()` call                                        |

### correlationId and causationId

`correlationId` groups work across a request or workflow. Adapters reuse
`x-correlation-id` when present; otherwise they generate a UUID.

`causationId` links an event to a parent operation/event. Adapters read
`x-causation-id` when present and leave it absent otherwise.

Both header names are configurable in every HTTP adapter.

## Global API vs Creational API

The SDK has two public usage styles. They share one implementation:
`initGlobalAudit()` creates an internal `AuditInstance` with `createAudit()` and
the global `record()` delegates to it.

### Global API

Use the global API for the common case: one audit configuration per process,
initialized once at startup.

```ts
import {
  getGlobalAudit,
  initGlobalAudit,
  record,
  resetGlobalAudit,
  shutdownGlobalAudit
} from '@tnet06/mapa-audit-sdk';

initGlobalAudit({
  serviceName: 'billing-api',
  serviceVersion: '1.4.0',
  environment: 'production'
});

record({
  eventType: 'business',
  eventName: 'invoice.created',
  outcome: 'success',
  entity: { type: 'invoice', id: 'inv-123' }
});

const info = getGlobalAudit();
await shutdownGlobalAudit();
resetGlobalAudit(); // intended for tests or controlled reinitialization
```

If `record()` is called before `initGlobalAudit()`, the event is discarded and a
warning is emitted once for the process.

### Creational API

Use `createAudit()` when multiple isolated configurations are needed in the same
process: tests, multi-tenant apps, or explicit dependency injection.

```ts
import { createAudit } from '@tnet06/mapa-audit-sdk';
import { FileTransport } from '@tnet06/mapa-audit-sdk/transports';

const audit = createAudit({
  serviceName: 'tenant-a-api',
  environment: 'production',
  transports: [
    new FileTransport({
      path: './tenant-a-audit.jsonl',
      format: 'jsonl'
    })
  ]
});

audit.record({
  eventType: 'business',
  eventName: 'tenant.report_generated',
  outcome: 'success'
});

await audit.shutdown();
```

## Adapters

Adapters capture request context only. They do not call `record()` and they do
not know about transports.

All adapters support:

| Option                | Default              | Meaning                                                    |
| --------------------- | -------------------- | ---------------------------------------------------------- |
| `correlationIdHeader` | `'x-correlation-id'` | Header used to reuse an incoming correlation id            |
| `causationIdHeader`   | `'x-causation-id'`   | Header used to capture an incoming causation id            |
| `extractActor`        | framework default    | Function that returns the full actor object or `undefined` |

`extractActor` is a function you write. It is not a declarative route
configuration. When provided, it completely replaces the default actor
extraction; it is not merged with the default.

Default actor extraction follows the Passport-style convention:
`req.user.id`/`req.user.role` for Express/NestJS and
`request.user.id`/`request.user.role` for Fastify. If your auth system stores
identity somewhere else, such as `req.session.user`, use `extractActor`.

### Express

```ts
import express from 'express';
import { expressAdapter } from '@tnet06/mapa-audit-sdk/express';

const app = express();

app.use(express.json());
app.use(expressAdapter());
```

Express captures `request.routePattern` from `req.route?.path` when available.

Custom headers and session-based actor extraction:

```ts
import type { Request } from 'express';
import { expressAdapter } from '@tnet06/mapa-audit-sdk/express';

type SessionRequest = Request & {
  session?: {
    user?: {
      id?: string;
      role?: string;
      tenantId?: string;
    };
  };
};

app.use(
  expressAdapter({
    correlationIdHeader: 'x-trace-id',
    causationIdHeader: 'x-parent-event-id',
    extractActor: (req: Request) => {
      const sessionUser = (req as SessionRequest).session?.user;

      if (sessionUser === undefined) {
        return undefined;
      }

      return {
        type: 'user',
        ...(sessionUser.id === undefined ? {} : { userId: sessionUser.id }),
        ...(sessionUser.role === undefined
          ? {}
          : { userRole: sessionUser.role }),
        ...(sessionUser.tenantId === undefined
          ? {}
          : { tenantId: sessionUser.tenantId })
      };
    }
  })
);
```

### Fastify

```ts
import fastify from 'fastify';
import { fastifyAdapter } from '@tnet06/mapa-audit-sdk/fastify';

const app = fastify({ logger: false });

await app.register(fastifyAdapter);
```

Fastify captures `request.routePattern` from `request.routeOptions?.url` with a
v4-compatible fallback to `request.routerPath`.

If another hook sets `request.user`, register that hook before
`fastifyAdapter`:

```ts
import type { FastifyRequest } from 'fastify';

type RequestWithUser = FastifyRequest & {
  user?: {
    id: string;
    role: string;
  };
};

app.addHook('onRequest', (request, _reply, done) => {
  (request as RequestWithUser).user = {
    id: 'demo-user-1',
    role: 'admin'
  };

  done();
});

await app.register(fastifyAdapter, {
  correlationIdHeader: 'x-trace-id'
});
```

### NestJS

```ts
import {
  Module,
  type MiddlewareConsumer,
  type NestModule
} from '@nestjs/common';
import { AuditContextMiddleware } from '@tnet06/mapa-audit-sdk/nestjs';

const auditContextMiddleware = new AuditContextMiddleware();

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(auditContextMiddleware.use.bind(auditContextMiddleware))
      .forRoutes('*');
  }
}
```

NestJS does not capture `request.routePattern`. The middleware intentionally uses
only the request shape common to Nest's Express and Fastify platforms, so it
cannot depend on Express-specific `req.route`.

If user identity is resolved in a Guard, the audit middleware runs before that
Guard and cannot see the actor automatically. Use `setActor()` after the Guard
resolves identity:

```ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { setActor } from '@tnet06/mapa-audit-sdk';

@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
    }>();

    const user = validateJwtForDemo(request.headers.authorization);

    setActor({
      type: 'user',
      userId: user.id,
      userRole: user.role,
      tenantId: user.tenantId
    });

    return true;
  }
}

function validateJwtForDemo(_authorization: string | undefined): {
  id: string;
  role: string;
  tenantId: string;
} {
  return {
    id: 'user-1',
    role: 'admin',
    tenantId: 'tenant-1'
  };
}
```

`setActor()` replaces the actor for the current request context only. Calling it
outside an active request context is a silent no-op.

### Adapter Differences

| Adapter | Registration                         | Default actor source                    | Captures routePattern                        |
| ------- | ------------------------------------ | --------------------------------------- | -------------------------------------------- |
| Express | `app.use(expressAdapter())`          | `req.user.id` / `req.user.role`         | Yes, from `req.route?.path`                  |
| Fastify | `await app.register(fastifyAdapter)` | `request.user.id` / `request.user.role` | Yes, from `routeOptions.url` or `routerPath` |
| NestJS  | `AuditContextMiddleware`             | `req.user.id` / `req.user.role`         | No, platform-agnostic request shape          |

## Transports

Transports deliver already-built `AuditEvent` objects. They do not capture
context.

### ConsoleTransport

```ts
import { initGlobalAudit } from '@tnet06/mapa-audit-sdk';
import { ConsoleTransport } from '@tnet06/mapa-audit-sdk/transports';

initGlobalAudit({
  serviceName: 'orders-api',
  environment: 'development',
  transports: [new ConsoleTransport()]
});
```

`ConsoleTransport` writes one nested JSON event per line. Events with severity
`error` or `critical` go to `process.stderr`; all others go to
`process.stdout`.

It does not mask data by itself. Masking is applied during event assembly when
`maskedFields` is configured.

### FileTransport

```ts
import { FileTransport } from '@tnet06/mapa-audit-sdk/transports';

new FileTransport({
  path: './audit-output.jsonl',
  format: 'jsonl'
});

new FileTransport({
  path: './audit-output.csv',
  format: 'csv'
});

new FileTransport({
  path: './audit-output.txt',
  format: 'text'
});
```

Formats:

| Format  | Output                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| `jsonl` | One nested JSON event per line                                                                              |
| `csv`   | Fixed canonical columns; nested known groups flattened; missing fields are empty cells                      |
| `text`  | Human-readable line with `occurredAt`, `eventType`, `severity`, `eventName`, `correlationId`, and `outcome` |

`FileTransport` serializes writes per instance and implements `close()` so
`shutdown()`/`shutdownGlobalAudit()` can drain pending writes.

CSV header coordination is safe within one `FileTransport` instance/process.
Multiple instances or processes writing to the same CSV file can still race. If
multiple parts of an app need the same file, share one `FileTransport` instance.

### Fan-Out to Multiple Transports

```ts
import { initGlobalAudit } from '@tnet06/mapa-audit-sdk';
import {
  ConsoleTransport,
  FileTransport
} from '@tnet06/mapa-audit-sdk/transports';

const fileTransport = new FileTransport({
  path: './audit-output.jsonl',
  format: 'jsonl'
});

initGlobalAudit({
  serviceName: 'orders-api',
  environment: 'production',
  transports: [new ConsoleTransport(), fileTransport]
});
```

Each transport is isolated. If one transport fails, the SDK emits a warning for
that transport and continues dispatching to the others.

### RabbitMQTransport

`RabbitMQTransport` lives in a separate package:
`@tnet06/mapa-audit-transport-rabbitmq`. It depends on
`amqp-connection-manager` and `@tnet06/mapa-audit-types`, not on the SDK.

The package is private in this monorepo today. Once published to a public or
private registry, application projects can add it separately from the base SDK.

```ts
import { initGlobalAudit } from '@tnet06/mapa-audit-sdk';
import { RabbitMQTransport } from '@tnet06/mapa-audit-transport-rabbitmq';

initGlobalAudit({
  serviceName: 'orders-api',
  environment: 'production',
  transports: [
    new RabbitMQTransport({
      connection: 'amqp://user:pass@rabbitmq:5672/audit',
      exchange: 'audit.events',
      connectionOptions: {
        heartbeatIntervalInSeconds: 5,
        reconnectTimeInSeconds: 5
      }
    })
  ]
});
```

Behavior:

| Option              | Default          | Meaning                                                   |
| ------------------- | ---------------- | --------------------------------------------------------- |
| `connection`        | required         | AMQP URL or URL array passed to `amqp-connection-manager` |
| `exchange`          | `'audit.events'` | Topic exchange that receives audit events                 |
| `connectionOptions` | none             | Passed directly to `amqp-connection-manager.connect()`    |

The message body is `JSON.stringify(event)` with camelCase keys intact. Only the
routing key is converted to snake_case from `event.eventType`.

This transport only publishes. It does not consume queues and it does not include
the Worker, retry/DLQ handling, TimescaleDB persistence, or database schema.
Those are future infrastructure modules described in `docs/`.

`close()` closes the RabbitMQ channel and connection. The underlying
`amqp-connection-manager` API does not expose a separate public drain hook for
in-flight publishes beyond `ChannelWrapper.close()`, and this package does not
add custom buffering.

## Data Safety

### maskedFields

`maskedFields` masks payload values before any transport sees the event.

```ts
initGlobalAudit({
  serviceName: 'payments-api',
  environment: 'production',
  maskedFields: ['creditCard', 'user.ssn', 'payment.card.cvv']
});

record({
  eventType: 'business',
  eventName: 'payment.created',
  payload: {
    creditCard: '4111111111111111',
    user: {
      id: 'user-1',
      ssn: '123-45-6789'
    },
    payment: {
      card: {
        brand: 'visa',
        cvv: '123'
      }
    }
  }
});
```

Emitted payload:

```json
{
  "creditCard": "***",
  "user": {
    "id": "user-1",
    "ssn": "***"
  },
  "payment": {
    "card": {
      "brand": "visa",
      "cvv": "***"
    }
  }
}
```

Dot notation supports arbitrary object nesting. Array indexing is not supported
in this version; paths such as `items.0.card.cvv` should not be relied on for
redaction.

The original payload object passed by the caller is not mutated.

### maxPayloadSize

`maxPayloadSize` limits the serialized payload size in bytes. The default is
`1_000_000` bytes.

```ts
initGlobalAudit({
  serviceName: 'reports-api',
  environment: 'production',
  maxPayloadSize: 900
});
```

If the prepared payload exceeds the limit, the event payload is replaced with:

```json
{
  "truncated": true,
  "originalSizeBytes": 5324,
  "maxSizeBytes": 900
}
```

Masking runs before size measurement.

## Lifecycle and Graceful Shutdown

Call `shutdown()` on creational instances or `shutdownGlobalAudit()` for the
global singleton before process exit. This matters for transports with pending
work, especially `FileTransport`.

```ts
import { shutdownGlobalAudit } from '@tnet06/mapa-audit-sdk';

process.on('SIGTERM', () => {
  server.close(() => {
    void shutdownGlobalAudit().finally(() => {
      process.exit(0);
    });
  });
});
```

For Fastify or NestJS, close the framework app first and then drain audit
transports:

```ts
process.on('SIGTERM', () => {
  void (async () => {
    await app.close();
    await shutdownGlobalAudit();
    process.exit(0);
  })();
});
```

## Errors and Warnings

The SDK is fire-and-forget from the host application's perspective:

- `record()` does not throw transport errors into business logic.
- A failing transport does not prevent other transports from receiving the event.
- Calling global `record()` before `initGlobalAudit()` discards the event and
  emits one warning for the process.

Warnings use `process.emitWarning`. To route them into your own logging system:

```ts
process.on('warning', (warning) => {
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
```

SDK warnings use the `[mapa-audit]` prefix. RabbitMQ transport warnings use the
`[mapa-audit-transport-rabbitmq]` prefix.

## Troubleshooting

### My requests hang when I use the adapter

You probably passed the factory instead of invoking it.

```ts
app.use(expressAdapter()); // correct
app.use(expressAdapter); // wrong
```

### I do not see actor in my events

The default actor extraction only reads `req.user.id` / `req.user.role` or the
framework equivalent. If your auth stores identity somewhere else, such as
`req.session.user`, configure `extractActor`.

### Actor is missing on my login endpoint

That is often expected. During the login request, the actor may only be known at
the end of the request, after credentials are validated. For login events, record
the target account as `entity`, or call `setActor()` after identity is resolved
if the request context is still active.

### `Error: [mapa-audit] invalid environment "..."`

`environment` is required and must be exactly one of:
`development`, `staging`, or `production`.

`serviceName` is also required in `initGlobalAudit()` and `createAudit()`.

### I do not see events and there is no thrown error

Check whether `record()` is being called before `initGlobalAudit()`. The SDK
emits a warning once per process for this case, then keeps discarding silently to
avoid flooding stderr.

### My CSV has duplicate or interleaved headers

Share one `FileTransport` instance for a given CSV file path. Header coordination
is safe within one instance/process, not across multiple instances or processes.

## Executable Examples

The repository includes three runnable demos that use the real workspace
packages:

| Example                 |   Port | Demonstrates                                                                                         |
| ----------------------- | -----: | ---------------------------------------------------------------------------------------------------- |
| `examples/express-demo` | `3000` | Express context capture, actor extraction, transports, masking, truncation, shutdown                 |
| `examples/nestjs-demo`  | `3001` | NestJS middleware on platform-express or platform-fastify, transports, masking, truncation, shutdown |
| `examples/fastify-demo` | `3002` | Fastify context capture, route pattern capture, transports, masking, truncation, shutdown            |

Run from the repository root:

```sh
npm install
npm run build
```

Then choose the demo you want to run:

```sh
npm run start -w @tnet06/mapa-audit-express-demo
npm run start -w @tnet06/mapa-audit-nestjs-demo
npm run start -w @tnet06/mapa-audit-fastify-demo
```

Each demo supports:

```sh
AUDIT_TRANSPORT=console
AUDIT_TRANSPORT=file-jsonl
AUDIT_TRANSPORT=file-csv
AUDIT_TRANSPORT=file-text
```

See each example's local README for endpoint-specific curl commands.

## Project Status and Roadmap

Implemented today:

- Shared event/types package.
- SDK core with global and creational APIs.
- Express, Fastify, and NestJS adapters.
- Console and file transports.
- Optional RabbitMQ publisher transport package.
- Payload masking, payload size limiting, warnings, lifecycle shutdown, tests, and runnable examples.

Future design, not implemented here yet:

- Worker service that consumes RabbitMQ messages.
- Retry/DLQ processing.
- TimescaleDB schema and persistence.
- Query/read API and dashboard-oriented persistence features.

For deeper architecture and future pipeline details, see:

- `docs/sdk-architecture.md`
- `docs/rabbitmq-worker-architecture.md`
- `docs/database-design.md`
- `docs/BUILD_PLAN.md`

Note: some design docs may lag the newest working-tree implementation. The
README describes the current code in this repository.

## License

MIT. See [LICENSE](./LICENSE).
