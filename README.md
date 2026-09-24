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

## Contents

- [Installation](#installation)
- [Quickstart](#quickstart)
- [Core Concepts](#core-concepts)
- [Global API vs Creational API](#global-api-vs-creational-api)
- [Public API Reference](#public-api-reference)
- [Adapters](#adapters)
- [Transports](#transports)
- [Data Safety](#data-safety)
- [Lifecycle and Graceful Shutdown](#lifecycle-and-graceful-shutdown)
- [Errors and Warnings](#errors-and-warnings)
- [Troubleshooting](#troubleshooting)
- [Executable Examples](#executable-examples)
- [Project Status and Roadmap](#project-status-and-roadmap)

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

Once the packages are published, install the SDK with only the framework you
actually use:

```sh
npm install @tnet06/mapa-audit-sdk express
npm install @tnet06/mapa-audit-sdk fastify
npm install @tnet06/mapa-audit-sdk @nestjs/common
```

Those commands are examples for the future published package; they do not work
against the public npm registry while this monorepo remains private.

Express, Fastify, and `@nestjs/common` are optional peer dependencies of the SDK.
Installing the SDK should not force a consumer app to install all three
frameworks. Monorepo `devDependencies` exist only for developing and testing this
repository and are not installed into consumer projects. Framework adapters are
loaded through subpath exports:

```ts
import { expressAdapter } from '@tnet06/mapa-audit-sdk/express';
import { fastifyAdapter } from '@tnet06/mapa-audit-sdk/fastify';
import { AuditContextMiddleware } from '@tnet06/mapa-audit-sdk/nestjs';
```

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

`AuditEvent` is the transport/consumer contract. It is not the same as
`RecordInput`, which is the smaller object application code passes to
`record()`. One field is part of the shared event contract but is not currently
configurable through the SDK core:

- `payloadSchemaVersion` exists on `AuditEvent`, but `RecordInput` does not yet
  expose a way to set it.

Do not treat that field as a current core feature unless a future release adds
public configuration for it.

### Classification Model

The three classification fields are independent axes:

| Field       | Meaning                 | Canonical values                                                      |
| ----------- | ----------------------- | --------------------------------------------------------------------- |
| `eventType` | Domain or category      | `request`, `business`, `audit`, `error`, `security`, `system`         |
| `severity`  | Gravity of the event    | `debug`, `info`, `warn`, `error`, `critical`                          |
| `outcome`   | Result of the operation | `success`, `failure`, `partial`; optional when there is no result yet |

For example, a business operation can fail with high severity:

```ts
record({
  eventType: 'business',
  eventName: 'payment.capture_failed',
  severity: 'error',
  outcome: 'failure',
  entity: { type: 'payment', id: 'pay-123' }
});
```

A security event can also succeed and still be important:

```ts
record({
  eventType: 'security',
  eventName: 'mfa.challenge_passed',
  severity: 'info',
  outcome: 'success'
});
```

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

## Public API Reference

### AuditConfig

Used by `createAudit(config)` and `initGlobalAudit(config)`.

| Field            | Required | Default                    | Notes                                                                   |
| ---------------- | -------- | -------------------------- | ----------------------------------------------------------------------- |
| `serviceName`    | Yes      | none                       | Non-empty string; invalid values throw during configuration             |
| `serviceVersion` | No       | omitted                    | Written to `event.service.version` when provided                        |
| `instanceId`     | No       | omitted                    | Written to `event.service.instanceId` when provided                     |
| `environment`    | Yes      | none                       | Must be `development`, `staging`, or `production`; invalid values throw |
| `transports`     | No       | `[new ConsoleTransport()]` | Every event is sent to each transport in the array                      |
| `maskedFields`   | No       | no masking                 | Dot-notation payload paths; array indexing is not supported             |
| `maxPayloadSize` | No       | `1_000_000` bytes          | Inclusive byte limit for serialized payload after masking               |

### RecordInput

Passed to `record(input)` or `audit.record(input)`.

| Field       | Required | Default | Notes                                                                             |
| ----------- | -------- | ------- | --------------------------------------------------------------------------------- |
| `eventType` | Yes      | none    | Must be one of the canonical event types; validated at runtime                    |
| `eventName` | Yes      | none    | Non-empty application-defined name; validated at runtime                          |
| `severity`  | No       | `info`  | If provided, must be one of the canonical severities; `null` is invalid           |
| `outcome`   | No       | omitted | If provided, must be `success`, `failure`, or `partial`; `undefined` means absent |
| `entity`    | No       | omitted | Domain object affected by the event                                               |
| `payload`   | No       | `{}`    | Custom event data; masking and size limiting run before dispatch to any transport |

Invalid `RecordInput` from JavaScript does not throw into application code. The
event is discarded and one `[mapa-audit] failed to build audit event: ...`
warning is emitted for that call.

### AuditInstance

Returned by `createAudit(config)`.

| Method       | Behavior                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `record()`   | Builds an `AuditEvent` and dispatches it fire-and-forget to the instance's transports                    |
| `shutdown()` | Idempotently calls `close()` on transports that implement it; after it starts, `record()` is a no-op     |
| `getInfo()`  | Returns `{ configured, serviceName, environment, transportCount }` without transports or mutable methods |

`record()` contains `Transport.send()` errors and isolates each transport from
the others. `shutdown()` can reject if a transport's `close()` rejects.

### Global API

| Function                | Behavior                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `initGlobalAudit()`     | Creates the global singleton by delegating to `createAudit()`                               |
| `record()`              | Delegates to the global instance; warns once and discards if the global was not initialized |
| `getGlobalAudit()`      | Returns a read-only inspection snapshot or `undefined` when not initialized                 |
| `shutdownGlobalAudit()` | Drains the current global instance if one exists; it does not clear/reset the singleton     |
| `resetGlobalAudit()`    | Clears the global singleton and warning state; intended for tests or controlled reinit      |
| `setActor()`            | Replaces the actor in the current request context; `setActor(undefined)` clears it          |

`setActor()` outside an active request context is a silent no-op. It affects only
the current `AsyncLocalStorage` context, so concurrent requests remain isolated.
Use `resetGlobalAudit()` for test isolation; do not use `shutdownGlobalAudit()`
as a reset substitute.

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
The adapter resolves it lazily, so the documented global registration style
(`app.use(expressAdapter())` before routes) captures `/users/:id` for events
recorded inside the matched route handler.

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

### Custom Transports

The SDK core depends only on the shared `Transport` interface. A transport
receives an `AuditEvent` after context capture, validation, masking, size
limiting, id generation, and timestamp generation have already happened.

```ts
import type { AuditEvent, Transport } from '@tnet06/mapa-audit-types';

class MyTransport implements Transport {
  send(event: AuditEvent): void | Promise<void> {
    // Deliver the event.
    void event;
  }

  async close(): Promise<void> {
    // Drain resources when needed.
  }
}
```

`send()` can be synchronous or asynchronous. `close()` is optional and exists for
transports with resources to drain before shutdown. Errors from `send()` are
contained by `record()` and reported as warnings, so they do not break business
logic. Errors from `close()` can make `shutdown()` reject.

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
| `jsonl` | Default. One nested JSON event per line                                                                     |
| `csv`   | Fixed canonical columns; nested known groups flattened; missing fields are empty cells                      |
| `text`  | Human-readable line with `occurredAt`, `eventType`, `severity`, `eventName`, `correlationId`, and `outcome` |

An invalid `format` value from JavaScript throws synchronously in the
constructor:

```text
[mapa-audit] invalid FileTransport format; expected one of: jsonl, csv, text
```

Omitting `format`, or passing `format: undefined` from JavaScript, selects
`jsonl`. `FileTransport` serializes writes per instance and implements `close()`
so `shutdown()`/`shutdownGlobalAudit()` can drain pending writes.

CSV header coordination is safe within one `FileTransport` instance/process.
Multiple instances or processes writing to the same CSV file can still race. If
multiple parts of an app need the same file, share one `FileTransport` instance.

CSV output also neutralizes spreadsheet formula prefixes at the output boundary.
Any cell whose first character is `=`, `+`, `-`, `@`, tab, carriage return, or
line feed gets an ASCII apostrophe (`'`) prepended before normal CSV escaping.
Structural CSV escaping still runs afterward, duplicating quotes and quoting
cells that contain comma, quote, CR, or LF. This documents the exact mitigation
implemented by the transport; it is not a universal guarantee about every
spreadsheet program.

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

```sh
npm install @tnet06/mapa-audit-transport-rabbitmq
```

```ts
import { initGlobalAudit } from '@tnet06/mapa-audit-sdk';
import { RabbitMQTransport } from '@tnet06/mapa-audit-transport-rabbitmq';

const connection = process.env.AUDIT_RABBITMQ_URL;

if (connection === undefined) {
  throw new Error('AUDIT_RABBITMQ_URL is required');
}

initGlobalAudit({
  serviceName: 'orders-api',
  environment: 'production',
  transports: [
    new RabbitMQTransport({
      connection,
      exchange: 'audit.events',
      connectionOptions: {
        heartbeatIntervalInSeconds: 5,
        reconnectTimeInSeconds: 5
      },
      publishTimeoutMs: 5_000
    })
  ]
});
```

Behavior:

| Option              | Default          | Behavior                                                                |
| ------------------- | ---------------- | ----------------------------------------------------------------------- |
| `connection`        | required         | AMQP URL or URL array passed to `amqp-connection-manager`               |
| `exchange`          | `'audit.events'` | Durable topic exchange that receives audit events                       |
| `connectionOptions` | none             | Passed directly to `amqp-connection-manager.connect()`                  |
| `publishTimeoutMs`  | `5000`           | Maximum wait for one publish before warning and returning from `send()` |

The message body is `JSON.stringify(event)` with camelCase keys intact. Only the
routing key is converted to snake_case from `event.eventType`.

Operational behavior:

- `connectFailed` emits an early
  `[mapa-audit-transport-rabbitmq] rabbitmq connection failed: ...` warning.
- `disconnect` emits
  `[mapa-audit-transport-rabbitmq] rabbitmq disconnected: ...`.
- A publish that exceeds `publishTimeoutMs` emits
  `rabbitmq transport publish timed out after <ms>ms` and `send()` returns
  without throwing into the host app. The timeout uses timers and does not block
  the event loop.
- Connection warnings may repeat according to `amqp-connection-manager`'s own
  reconnection policy. Each publish timeout can also produce its own warning.
- `close()` removes connection listeners, then closes the channel and connection.

Connection warning URL details are sanitized. String AMQP/AMQPS URLs keep only
scheme, host, port, and vhost; username, password, query string, and hash are
removed. Objects with a `url` property are sanitized through that URL. Amqplib
connection option objects are rendered from safe `protocol`, `hostname`, `port`,
and `vhost` fields without exposing `username` or `password`. Malformed or
unsupported URL values fail closed as `[invalid connection URL redacted]`. The
original connection value passed to the broker client is not mutated.

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

Masking runs before payload size measurement. When masking is configured, the
SDK deep-clones before replacing values, so the original payload object passed by
the caller is not mutated.

### maxPayloadSize

`maxPayloadSize` limits the serialized payload size in bytes. The default is
`1_000_000` bytes. The limit is inclusive: a prepared payload whose serialized
JSON UTF-8 representation is exactly `1_000_000` bytes is preserved; only
payloads larger than that are replaced.

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

If payload preparation fails, `record()` still does not throw into the host
application. A circular or otherwise non-serializable payload is discarded with a
`[mapa-audit] failed to build audit event: ...` warning. If masking is
configured and `structuredClone()` cannot clone the payload, the event is also
discarded with the same contained-warning behavior.

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

The SDK separates startup/configuration errors from operational event dispatch.
Configuration problems fail fast. `record()` remains fire-and-forget and does
not throw into business logic.

| Situation                                           | Behavior                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Empty or invalid `serviceName`                      | Throws synchronously during `createAudit()` / `initGlobalAudit()` with `[mapa-audit]`            |
| Invalid `environment`                               | Throws synchronously during `createAudit()` / `initGlobalAudit()` with `[mapa-audit]`            |
| Invalid `FileTransport.format`                      | Throws synchronously in the `FileTransport` constructor with `[mapa-audit]`                      |
| Invalid `record()` input enum/name                  | Emits `[mapa-audit] failed to build audit event: ...`, discards the event, does not throw        |
| Circular, non-serializable, or non-clonable payload | Emits `[mapa-audit] failed to build audit event: ...`, discards the event, does not throw        |
| Global `record()` before `initGlobalAudit()`        | Emits one warning per process, discards events, does not throw                                   |
| Sync or async `Transport.send()` failure            | Emits `[mapa-audit] transport send failed: ...`; other transports still receive the event        |
| RabbitMQ connect/disconnect/publish timeout         | Emits `[mapa-audit-transport-rabbitmq] ...`; `send()` returns without throwing into the host app |
| `Transport.close()` failure during shutdown         | `shutdown()` / `shutdownGlobalAudit()` can reject                                                |
| `record()` after an instance shutdown has started   | No-op                                                                                            |

This is not a promise that every possible adapter option is runtime-validated.
The current runtime validation covers the fields listed above and the canonical
record classification fields.

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

### My CSV shows an apostrophe before a formula-like value

That is expected. `FileTransport` neutralizes cells that start with spreadsheet
formula prefixes by prepending `'` before normal CSV escaping. The apostrophe is
part of the CSV value so spreadsheet software treats the cell as text.

### RabbitMQ is not delivering events

Check process warnings. `RabbitMQTransport` emits warnings for connection
failures and disconnects with the `[mapa-audit-transport-rabbitmq]` prefix. URL
details in those warnings are sanitized, so credentials are not printed. Also
confirm that the broker is reachable and that consumers bind queues with routing
keys that match the event type. The transport declares the configured exchange
as a durable topic exchange when its channel is set up.

### RabbitMQ publishes are timing out

Each publish waits up to `publishTimeoutMs` milliseconds, default `5000`. If the
broker client does not confirm the publish before that limit, `send()` returns
and emits a timeout warning. Increase `publishTimeoutMs` only if the broker is
healthy but slower than the default under expected load.

### I called shutdown but getGlobalAudit still returns configured

`shutdownGlobalAudit()` drains transports; it does not clear the singleton. Use
`resetGlobalAudit()` only in tests or controlled reinitialization flows when you
explicitly want to remove the global instance.

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
