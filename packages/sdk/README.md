# @tnet06/mapa-audit-sdk

Audit and business observability SDK for Node.js. It provides a structured
audit event model, global and per-instance APIs, automatic request context
capture through framework adapters, built-in console/file transports, payload
masking, payload size limits, and fan-out to configurable transports.

Mapa Audit does not replace a general-purpose logger such as Pino or Winston.
Its focus is audit events: consistent request context, actor/entity separation,
runtime validation of event classification, and delivery to pluggable
transports.

## Contents

- [Installation](#installation)
- [Public Entrypoints](#public-entrypoints)
- [Quickstart](#quickstart)
- [Core Concepts](#core-concepts)
- [Configuration](#configuration)
- [Recording Events](#recording-events)
- [Global API and Instance API](#global-api-and-instance-api)
- [Framework Adapters](#framework-adapters)
- [Actor Context](#actor-context)
- [Built-in Transports](#built-in-transports)
- [Custom Transports](#custom-transports)
- [Payload Safety](#payload-safety)
- [Lifecycle](#lifecycle)
- [Errors and Warnings](#errors-and-warnings)
- [Related Packages](#related-packages)
- [License](#license)

## Installation

```sh
npm install @tnet06/mapa-audit-sdk
```

The framework adapters are exposed as optional subpath imports. Express,
Fastify, and `@nestjs/common` are optional peer dependencies, so installing the
SDK does not require installing all supported frameworks. Install only the
framework used by your application:

```sh
npm install @tnet06/mapa-audit-sdk express
npm install @tnet06/mapa-audit-sdk fastify
npm install @tnet06/mapa-audit-sdk @nestjs/common
```

The SDK depends on `@tnet06/mapa-audit-types` for the shared event and transport
contracts. Application code normally does not install it manually unless it is
implementing a custom transport.

This package is ESM and requires Node.js `>=20`.

## Public Entrypoints

Use only the exported package entrypoints below. Files under `core/*`,
`adapters/*`, `warnings`, `validation`, and `flatten` are internal
implementation details even if compiled files exist inside `dist/`.

```ts
import {
  buildEvent,
  createAudit,
  getGlobalAudit,
  initGlobalAudit,
  record,
  resetGlobalAudit,
  setActor,
  shutdownGlobalAudit
} from '@tnet06/mapa-audit-sdk';

import {
  ConsoleTransport,
  FileTransport
} from '@tnet06/mapa-audit-sdk/transports';

import { expressAdapter } from '@tnet06/mapa-audit-sdk/express';
import { fastifyAdapter } from '@tnet06/mapa-audit-sdk/fastify';
import { AuditContextMiddleware } from '@tnet06/mapa-audit-sdk/nestjs';
```

## Quickstart

Minimal Express application using the global API, automatic context capture, and
the default `ConsoleTransport`:

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
    void shutdownGlobalAudit().finally(() => {
      process.exit(0);
    });
  });
});
```

Register `expressAdapter()` before routes that call `record()`. The adapter
opens the request context; `record()` later reads that context automatically.

## Core Concepts

### Event Shape

Every transport receives a canonical nested `AuditEvent` from
`@tnet06/mapa-audit-types`. Application code does not build this full event
directly. Instead, it passes a smaller `RecordInput` to `record()` or
`audit.record()`, or to `buildEvent()` / `audit.buildEvent()` when it needs the
canonical event value without dispatching it.

The SDK generates `id` and `occurredAt`, service metadata comes from
configuration, framework adapters provide request/correlation/actor context when
available, and the developer supplies classification, entity, and payload data.

`AuditEvent.payloadSchemaVersion` is part of the shared transport contract, but
`RecordInput` does not currently expose a way to set it.

### Classification Model

`eventType`, `severity`, and `outcome` are independent axes:

| Field       | Meaning                 | Canonical values                                                      |
| ----------- | ----------------------- | --------------------------------------------------------------------- |
| `eventType` | Domain or category      | `request`, `business`, `audit`, `error`, `security`, `system`         |
| `severity`  | Gravity of the event    | `debug`, `info`, `warn`, `error`, `critical`                          |
| `outcome`   | Result of the operation | `success`, `failure`, `partial`; optional when there is no result yet |

A business event can fail and carry error severity:

```ts
record({
  eventType: 'business',
  eventName: 'payment.capture_failed',
  severity: 'error',
  outcome: 'failure',
  entity: { type: 'payment', id: 'pay-123' }
});
```

### Actor vs Entity

`actor` is who or what performed the action. `entity` is the domain object
affected by the action.

For example, when an administrator changes another user's role, the
adapter-captured `actor` is the administrator and `entity` should identify the
target user.

## Configuration

`AuditConfig` is accepted by both `initGlobalAudit(config)` and
`createAudit(config)`.

| Field            | Required | Default                    | Behavior                                                                                          |
| ---------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `serviceName`    | Yes      | none                       | Non-empty service name written to `event.service.name`; invalid values throw during configuration |
| `serviceVersion` | No       | omitted                    | Written to `event.service.version` when provided                                                  |
| `instanceId`     | No       | omitted                    | Written to `event.service.instanceId` when provided                                               |
| `environment`    | Yes      | none                       | Must be `development`, `staging`, or `production`; invalid values throw during configuration      |
| `transports`     | No       | `[new ConsoleTransport()]` | Every event is sent to each transport in the array                                                |
| `maskedFields`   | No       | no masking                 | Dot-notation payload paths to replace with `"***"`                                                |
| `maxPayloadSize` | No       | `1_000_000` bytes          | Inclusive UTF-8 serialized payload size limit after masking                                       |

Example with fan-out and payload safety:

```ts
import { initGlobalAudit } from '@tnet06/mapa-audit-sdk';
import {
  ConsoleTransport,
  FileTransport
} from '@tnet06/mapa-audit-sdk/transports';

const fileTransport = new FileTransport({
  path: './audit-events.jsonl'
});

initGlobalAudit({
  serviceName: 'payments-api',
  serviceVersion: '1.0.0',
  instanceId: 'payments-api-01',
  environment: 'production',
  transports: [new ConsoleTransport(), fileTransport],
  maskedFields: ['creditCard', 'user.ssn'],
  maxPayloadSize: 1_000_000
});
```

## Recording Events

`RecordInput` is the object passed to `record(input)`, `audit.record(input)`,
`buildEvent(input)`, or `audit.buildEvent(input)`.

| Field       | Required | Default | Behavior                                                                               |
| ----------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `eventType` | Yes      | none    | Must be one canonical event type; validated at runtime                                 |
| `eventName` | Yes      | none    | Non-empty application-defined name; validated at runtime                               |
| `severity`  | No       | `info`  | If provided, must be one canonical severity; `null` is invalid                         |
| `outcome`   | No       | omitted | If provided, must be `success`, `failure`, or `partial`; `undefined` means absent      |
| `entity`    | No       | omitted | Domain object affected by the event                                                    |
| `payload`   | No       | `{}`    | Custom event data; payload safety rules run before the event is returned or dispatched |

For `record()`, invalid event classification or an invalid `eventName` is
contained by the fire-and-forget boundary: the event is discarded, a
`[mapa-audit]` warning is emitted, and the host application's business logic
does not receive an exception. For `buildEvent()`, the same validation error is
thrown synchronously to the caller without dispatching an event or emitting a
warning.

## Global API and Instance API

The SDK has two usage styles. They share one implementation: the global API is a
small singleton wrapper around an `AuditInstance` created with `createAudit()`.

### Global API

Use `initGlobalAudit()` and `record()` for the common case: one audit
configuration per process, initialized once during startup.

```ts
import {
  buildEvent,
  getGlobalAudit,
  initGlobalAudit,
  record,
  resetGlobalAudit,
  shutdownGlobalAudit
} from '@tnet06/mapa-audit-sdk';

initGlobalAudit({
  serviceName: 'billing-api',
  environment: 'production'
});

const event = buildEvent({
  eventType: 'business',
  eventName: 'invoice.previewed',
  outcome: 'success',
  entity: { type: 'invoice', id: 'inv-123' }
});

record({
  eventType: 'business',
  eventName: 'invoice.created',
  outcome: 'success',
  entity: { type: 'invoice', id: 'inv-123' }
});

const info = getGlobalAudit();
await shutdownGlobalAudit();
resetGlobalAudit();
```

| Function                | Behavior                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `initGlobalAudit()`     | Creates the global singleton by delegating to `createAudit()`                                       |
| `buildEvent()`          | Delegates to the global instance and returns an independent event snapshot; throws if uninitialized |
| `record()`              | Delegates to the global instance; warns once and discards events if the global was not initialized  |
| `getGlobalAudit()`      | Returns `{ configured, serviceName, environment, transportCount }` or `undefined`                   |
| `shutdownGlobalAudit()` | Drains the current global instance if it exists; it does not clear/reset the singleton              |
| `resetGlobalAudit()`    | Clears the singleton and one-time warning state; intended for tests or controlled reinitialization  |

`record()` is fire-and-forget. `shutdownGlobalAudit()` can reject if a
configured transport's `close()` rejects. `buildEvent()` does not dispatch to
transports or emit construction warnings; it returns a deep mutable snapshot or
throws to the caller.

### Instance API

Use `createAudit()` when a process needs isolated configurations, such as tests,
multi-tenant apps, or dependency-injected services.

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

const event = audit.buildEvent({
  eventType: 'audit',
  eventName: 'tenant.report_previewed',
  outcome: 'success'
});

await audit.shutdown();
```

| Method         | Behavior                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `buildEvent()` | Builds and returns an independent `AuditEvent` snapshot without calling transports; construction errors throw      |
| `record()`     | Builds an `AuditEvent` and dispatches it fire-and-forget to this instance's transports                             |
| `shutdown()`   | Idempotently calls `close()` on transports that implement it; after shutdown starts, `record()` is a no-op         |
| `getInfo()`    | Returns `{ configured, serviceName, environment, transportCount }` without exposing transports or mutating methods |

Use `buildEvent()` when the application wants to own the canonical event value,
for example to persist it through an application-managed transaction or pass it
to another layer. The result is a deep mutable snapshot that does not share
references with request context, service metadata, entity input, or payload
input. The fields from request context still depend on an active adapter-created
`AsyncLocalStorage` context. Mapa Audit does not provide transaction guarantees
for `buildEvent()`; those belong to the persistence mechanism the application
uses. `buildEvent()` keeps working after `shutdown()` starts because it does not
use transports.

## Framework Adapters

Adapters only capture request context. They do not call `record()` and do not
know about transports.

All HTTP adapters support these options:

| Option                | Default              | Behavior                                                                         |
| --------------------- | -------------------- | -------------------------------------------------------------------------------- |
| `correlationIdHeader` | `'x-correlation-id'` | Header used to reuse an incoming correlation id; a UUID is generated when absent |
| `causationIdHeader`   | `'x-causation-id'`   | Header used to capture an incoming causation id when present                     |
| `extractActor`        | framework default    | Function returning the full actor object or `undefined`                          |

`extractActor` replaces the default actor extraction completely; it is not
merged with the default. The default extraction reads `req.user.id` /
`req.user.role` in Express/NestJS and `request.user.id` / `request.user.role` in
Fastify. When either field exists, actor `type` is set to `'user'`.

The adapters capture HTTP method, endpoint URL, IP address when available, user
agent header when present, correlation id, causation id, and actor when
available. Runtime validation of every adapter option is not currently part of
the public contract.

### Express

```ts
import express from 'express';
import { expressAdapter } from '@tnet06/mapa-audit-sdk/express';

const app = express();

app.use(express.json());
app.use(expressAdapter());
```

Express captures `request.routePattern` lazily from `req.route?.path`. This
allows global registration with `app.use(expressAdapter())` before routes while
still capturing patterns such as `/users/:id` for events recorded inside the
matched route handler.

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

Fastify captures `request.routePattern` from `request.routeOptions?.url` and
falls back to `request.routerPath` for Fastify 4 compatibility.

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

await app.register(fastifyAdapter);
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

`AuditContextMiddleware` uses only the request shape common to NestJS
platform-express and platform-fastify, so it does not capture
`request.routePattern`. If user identity is resolved in a Guard, the middleware
runs before the Guard and cannot see that actor automatically; call `setActor()`
after resolving identity.

## Actor Context

`setActor()` updates the current request context after an adapter has opened it.
It replaces any actor captured by an adapter `extractActor` hook or by an
earlier `setActor()` call.

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

`setActor(undefined)` removes the actor from the current request context.
Calling `setActor()` outside an active context is a silent no-op. Concurrent
requests remain isolated by `AsyncLocalStorage`.

## Built-in Transports

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
`error` or `critical` are written to `process.stderr`; all other severities are
written to `process.stdout`.

### FileTransport

```ts
import { FileTransport } from '@tnet06/mapa-audit-sdk/transports';

new FileTransport({
  path: './audit-output.jsonl'
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

| Format  | Output                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `jsonl` | Default. One nested JSON event per line                                                                                 |
| `csv`   | Fixed canonical columns; known nested groups are flattened; missing fields are empty cells                              |
| `text`  | One compact human-readable line with `occurredAt`, `eventType`, `severity`, `eventName`, `correlationId`, and `outcome` |

`FileTransport` serializes writes per instance and creates parent directories
automatically. `close()` waits for queued writes to finish. Invalid runtime
`format` values throw synchronously during construction:

```text
[mapa-audit] invalid FileTransport format; expected one of: jsonl, csv, text
```

CSV header coordination is safe within one `FileTransport` instance/process.
Multiple instances or processes writing to the same CSV file can still race; if
multiple parts of an app need one CSV destination, share a single
`FileTransport` instance.

CSV output neutralizes spreadsheet formula prefixes at the output boundary. Any
cell whose first character is `=`, `+`, `-`, `@`, tab, carriage return, or line
feed gets an ASCII apostrophe (`'`) prepended before normal CSV escaping. CSV
escaping still duplicates quotes and quotes cells containing comma, quote, CR,
or LF.

## Custom Transports

Custom transports implement the shared `Transport` contract from
`@tnet06/mapa-audit-types`.

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

`send()` may be synchronous or asynchronous. `close()` is optional. Every
transport receives the same already-built `AuditEvent`; transports should not
capture request context themselves. Errors from `send()` are contained by
`record()` and emitted as warnings. One failing transport does not prevent other
configured transports from receiving the event. Errors from `close()` can make
`shutdown()` reject.

## Payload Safety

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

Dot notation supports nested object paths. Array-element masking is not
supported in this version; do not rely on paths such as `items.0.card.cvv` for
redaction.

When masking is configured, the SDK uses `structuredClone()` before replacing
values, so masking does not mutate the original payload object. If
`maskedFields` is omitted or empty, the SDK does not clone solely for masking.

### maxPayloadSize

Masking happens before size measurement. `maxPayloadSize` measures the prepared
payload as serialized JSON in UTF-8 bytes. The default is `1_000_000` bytes, and
the limit is inclusive: exactly `1_000_000` bytes is preserved; larger payloads
are replaced with a marker.

```json
{
  "truncated": true,
  "originalSizeBytes": 1000001,
  "maxSizeBytes": 1000000
}
```

Circular or otherwise non-serializable payloads are discarded with a warning and
do not throw into the host application. If masking is configured and
`structuredClone()` cannot clone the payload, the event is also discarded with
the same contained-warning behavior.

## Lifecycle

Call `shutdown()` on an `AuditInstance` or `shutdownGlobalAudit()` for the global
singleton before process exit when transports may have pending work.

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

`shutdown()` is idempotent. Once shutdown starts for an instance, later
`record()` calls on that instance are no-ops. `shutdownGlobalAudit()` drains the
current singleton but does not clear it; use `resetGlobalAudit()` only for tests
or controlled reinitialization.

## Errors and Warnings

Configuration errors fail fast. Runtime event dispatch remains fire-and-forget.

| Situation                                                             | Behavior                                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Invalid or empty `serviceName`                                        | Throws synchronously during `createAudit()` / `initGlobalAudit()` with `[mapa-audit]`     |
| Invalid `environment`                                                 | Throws synchronously during `createAudit()` / `initGlobalAudit()` with `[mapa-audit]`     |
| Invalid `FileTransport.format`                                        | Throws synchronously in the `FileTransport` constructor with `[mapa-audit]`               |
| Invalid `buildEvent()` input                                          | Throws synchronously to the caller; no warning is emitted                                 |
| Invalid `record()` input                                              | Emits `[mapa-audit] failed to build audit event: ...`, discards the event, does not throw |
| Circular, non-serializable, or non-clonable payload in `buildEvent()` | Throws synchronously to the caller; no warning is emitted                                 |
| Circular, non-serializable, or non-clonable payload                   | Emits `[mapa-audit] failed to build audit event: ...`, discards the event, does not throw |
| Global `buildEvent()` before `initGlobalAudit()`                      | Throws `[mapa-audit] buildEvent() called before initGlobalAudit()`                        |
| Global `record()` before `initGlobalAudit()`                          | Emits one `[mapa-audit]` warning per process, discards events, does not throw             |
| Sync or async `Transport.send()` failure                              | Emits `[mapa-audit] transport send failed: ...`; other transports remain isolated         |
| `Transport.close()` failure during shutdown                           | `shutdown()` / `shutdownGlobalAudit()` can reject                                         |
| `record()` after instance shutdown has started                        | No-op                                                                                     |
| `buildEvent()` after instance shutdown has started                    | Still builds and returns an event snapshot                                                |

Warnings are emitted with `process.emitWarning`. To route them to your own
logging system:

```ts
process.on('warning', (warning) => {
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
```

## Related Packages

- `@tnet06/mapa-audit-types`: shared `AuditEvent`, enum unions, and `Transport`
  contract. Installed by the SDK; import from it directly when implementing
  custom transports.
- `@tnet06/mapa-audit-transport-rabbitmq`: optional RabbitMQ publisher
  transport. It is installed separately and implements the same `Transport`
  interface.

The SDK package does not include a Worker, retry/DLQ processing, TimescaleDB
persistence, or database query APIs.

For broader project documentation, see the repository:
https://github.com/ernesto-1998/mapa-audit

## License

MIT. See [LICENSE](./LICENSE).
