# Audit & Business Observability Platform
## SDK Architecture Document (Final)

**Status:** Draft for review
**Audience:** Engineering
**Companion to:** Platform Design Overview, Database Design (TimescaleDB)

---

### 1. Purpose

This document describes the SDK that backend services use to record audit,
business, error, and security events. The SDK's core value is **automatic,
framework-aware capture of request context** (correlation ID, user, endpoint, IP,
etc.) plus a **structured business-audit event model** — not log transport, which
is a solved problem.

Where events go is a **pluggable transport**: console, file, or (later) a queue
feeding a persistence pipeline. The SDK does not compete with general-purpose
loggers (Pino, Winston) on transport; it focuses on what they don't do — turning
raw requests into structured, correlated, business-meaningful audit events.

Design priorities:

- A minimal, stable public surface.
- **Two independent axes:** adapters (capture, per framework) and transports
  (delivery, per destination) — neither knows about the other.
- Zero-infrastructure default: works out of the box (console) with no queue or DB.
- Framework-agnostic core; thin adapters per framework; thin transports per sink.
- Client-generated event identity, preserved for the queue transport's idempotency.

---

### 2. The Two-Axis Architecture (read this first)

The single most important structural idea: **capture and delivery are independent
axes, decoupled by the core.**

```
   ADAPTERS (capture context)      CORE            TRANSPORTS (deliver event)
   ┌──────────────┐                                ┌────────────────────┐
   │ express       │──┐          ┌──────────┐   ┌──│ console             │
   │ fastify       │──┤          │  record  │   ├──│ file (jsonl/csv/xlsx)│
   │ nestjs        │──┼─────────▶│  (core)  │──▶┼──│ queue (later module) │
   │ node (manual) │──┘          └──────────┘   └──│ (custom)            │
   └──────────────┘                                └────────────────────┘
        ▲                                                    ▲
   only job: read the request        only job: send the finished event
   and populate context              somewhere; knows nothing of frameworks
```

Consequences of this design:

- **Any adapter works with any transport.** Express→console, NestJS→file,
  Fastify→queue — every combination works, because adapters and transports never
  interact. They only talk to the core.
- **Adding a transport touches no adapter**, and **adding a framework touches no
  transport.** Each is added in isolation.
- The RabbitMQ/DB pipeline is simply **one transport (the queue transport)**, built
  last as a separate module — not the core of the SDK.

---

### 3. Package Structure

```
packages/sdk/
├── src/
│   ├── core/
│   │   ├── storage.ts        → AsyncLocalStorage + RequestContext
│   │   ├── record.ts         → public record(); builds event, hands to transport
│   │   ├── configure.ts      → init: select transport, set service metadata
│   │   ├── transport.ts      → the Transport interface
│   │   └── flatten.ts        → shared helper: nested event → flat row (for tabular sinks)
│   ├── transports/
│   │   ├── console.ts        → ConsoleTransport (process.stdout / process.stderr)
│   │   └── file.ts           → FileTransport (jsonl / csv / xlsx)
│   ├── adapters/
│   │   ├── express.ts
│   │   ├── fastify.ts
│   │   └── nestjs.ts
│   └── index.ts               → public exports
├── package.json
└── tsconfig.json
```

Adapters and transports are exposed as **subpath exports**
(`@tnet06/mapa-audit-sdk/nestjs`, `@tnet06/mapa-audit-sdk/transports`) so a
consumer only pulls in what they use. The `AuditEvent` type is imported from the
shared package `@tnet06/mapa-audit-types` (never redeclared here). The queue
transport lives in its **own package** (see §10), not here — it carries heavier
dependencies.

---

### 4. Event Data Model (nested canonical form, flattened on output)

This is a foundational decision that shapes every transport, so it comes before the
core mechanics.

**The event is structured as a nested object, grouped by concern.** This is the
single canonical representation that `record()` produces and that travels to the
transport:

```ts
// defined in @tnet06/mapa-audit-types, imported by the SDK
interface AuditEvent {
  id: string;                 // client-generated UUID
  correlationId?: string;
  causationId?: string;
  eventType: string;          // 'request' | 'business' | 'error' | 'security' | 'system' | 'audit'
  eventName: string;
  severity: string;           // 'debug' | 'info' | 'warn' | 'error' | 'critical'
  outcome?: string;           // 'success' | 'failure' | 'partial'
  occurredAt: string;         // ISO timestamp

  service: {
    name: string;
    version?: string;
    environment: string;
    instanceId?: string;
  };

  request?: {                 // present for HTTP-originated events
    httpMethod?: string;
    endpoint?: string;
    routePattern?: string;
    ipAddress?: string;
    userAgent?: string;
  };

  actor?: {                   // who caused it — human or machine
    type?: string;            // 'user' | 'service' | 'system' | 'job'
    userId?: string;
    userRole?: string;
    tenantId?: string;
  };

  entity?: {                  // the affected business resource
    type?: string;
    id?: string;
  };

  payload?: Record<string, unknown>;  // event-specific, genuinely variable data
}
```

**Why nested internally:**

- **Semantic clarity** — `event.request.ipAddress` communicates grouping that a
  loose `ipAddress` among 20 fields does not.
- **No name collisions** — `actor.userId` and `entity.id` coexist without ambiguity.
- **Extensible** — adding a field to a group doesn't disturb the rest.

**Why flatten only at output:** the nested form is canonical (one representation),
but each destination wants a different shape. Flattening is the responsibility of
the **transport** (via a shared `flatten()` helper), never the core:

| Destination | Shape | Flatten? |
|---|---|---|
| JSON / JSONL | Nested, as-is | No — JSON represents nesting natively |
| Console | Nested (single-line JSON) | No |
| CSV / XLSX | Tabular columns (`request_ipAddress`, `actor_userId`, ...) | **Yes** |
| TimescaleDB (future) | Fixed columns + `payload` as JSONB | **Yes**, for known fields; `payload` stays JSON |

The rule: **flatten the known/structured fields into columns; leave the variable
`payload` as JSON.** This maps cleanly onto the database schema (fixed columns +
`payload JSONB`) when the queue transport is built. `flatten.ts` is a single shared
utility so tabular transports don't each reimplement it (DRY).

---

### 5. The Core

#### 5.1 `storage.ts` — request context via AsyncLocalStorage

`AsyncLocalStorage` provides a store that is **isolated per async execution
chain** — i.e. per request. Two concurrent requests each get their own store; they
never mix. This is what lets `record()` read the correct correlation ID deep in the
call stack without the developer passing it around.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
  causationId?: string;
  request?: {
    httpMethod?: string;
    endpoint?: string;
    routePattern?: string;
    ipAddress?: string;
    userAgent?: string;
  };
  actor?: {
    type?: string;
    userId?: string;
    userRole?: string;
    tenantId?: string;
  };
}

export const contextStore = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return contextStore.getStore();
}
```

The context mirrors the nested event groups it feeds into, so merging in `record()`
is a straightforward structural copy.

#### 5.2 `transport.ts` — the contract that makes transports interchangeable

```ts
import type { AuditEvent } from '@tnet06/mapa-audit-types';

// Every transport implements exactly this. Nothing more.
export interface Transport {
  send(event: AuditEvent): void | Promise<void>;
}
```

The core depends only on this interface — never on a concrete transport. This is
the seam that keeps console/file/queue swappable.

#### 5.3 `record.ts` — the public event function

```ts
import { randomUUID } from 'node:crypto';
import { getContext } from './storage';
import type { Transport } from './transport';
import type { AuditEvent } from '@tnet06/mapa-audit-types';

let transport: Transport;
let service: AuditEvent['service'];

export function setTransport(t: Transport, svc: AuditEvent['service']) {
  transport = t;
  service = svc;
}

export function record(input: {
  eventType: string;
  eventName: string;
  severity?: string;
  outcome?: string;
  entity?: { type?: string; id?: string };
  payload?: Record<string, unknown>;
}): void {
  const ctx = getContext();

  const event: AuditEvent = {
    id: randomUUID(),                     // client-generated (idempotency-ready)
    correlationId: ctx?.correlationId,    // same ID for the whole request
    causationId: ctx?.causationId,
    eventType: input.eventType,
    eventName: input.eventName,
    severity: input.severity ?? 'info',
    outcome: input.outcome,
    occurredAt: new Date().toISOString(),
    service,
    request: ctx?.request,
    actor: ctx?.actor,
    entity: input.entity,
    payload: input.payload ?? {},
  };

  // Fire-and-forget: never block or throw into the host app.
  try {
    void transport.send(event);
  } catch {
    /* a transport failure must never surface to business logic */
  }
}
```

Two invariants preserved from the original design:

- **`id` is generated client-side.** Harmless for console/file, but essential for
  the queue transport's `ON CONFLICT` idempotency later. Generating it here means
  the contract holds regardless of transport.
- **Fire-and-forget.** `record()` never blocks business logic and never throws into
  the host app, whatever the transport.

#### 5.4 `configure.ts` — initialization

```ts
export interface AuditConfig {
  serviceName: string;
  serviceVersion?: string;
  environment: 'development' | 'staging' | 'production';
  transport?: Transport;   // optional — defaults to ConsoleTransport
}

export function configureAudit(cfg: AuditConfig): void {
  const transport = cfg.transport ?? new ConsoleTransport();
  setTransport(transport, {
    name: cfg.serviceName,
    version: cfg.serviceVersion,
    environment: cfg.environment,
  });
}
```

If no transport is provided, the SDK falls back to `ConsoleTransport` so it works
with zero setup. `environment` is validated against the same allowed values the
database enforces.

---

### 6. Transports

Each transport is a self-contained class implementing `Transport.send()`. They
share nothing (except the `flatten()` helper for tabular formats) and are added
independently.

#### 6.1 ConsoleTransport (default, zero infrastructure)

Writes directly to `process.stdout` / `process.stderr` — **not** `console.log`.
`console.log` is a wrapper over stdout that adds its own formatting and inspection
overhead; writing the file descriptor directly gives full control over the output
and better throughput. This is the same approach Pino and Winston take, and is why
they're fast. Errors/critical go to stderr (standard convention), everything else
to stdout, so operators can redirect them separately.

```ts
export class ConsoleTransport implements Transport {
  send(event: AuditEvent): void {
    const line = JSON.stringify(event) + '\n';
    if (event.severity === 'error' || event.severity === 'critical') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }
}
```

The event stays **nested** here (JSON preserves structure naturally). Delivers
value immediately with no queue or DB — the automatic context capture is already
useful on its own.

#### 6.2 FileTransport (jsonl / csv)

Writes structured events to a file. Default format **JSON Lines** (one JSON object
per line — the standard for appendable logs, keeps the nested structure). CSV uses
the shared `flatten()` helper to produce columns.

```ts
export class FileTransport implements Transport {
  constructor(private opts: { path: string; format?: 'jsonl' | 'csv' }) {}
  send(event: AuditEvent): void { /* jsonl: append nested JSON; csv: append flatten(event) */ }
}
```

#### 6.3 QueueTransport (later module — see §10)

The RabbitMQ → Worker → TimescaleDB pipeline, packaged separately. **Opt-in and
self-hosted**: consumers who choose it run their own queue + worker + database
(provided via Docker/Terraform), pointing the SDK at their own instance. It
flattens known fields to columns and stores `payload` as JSONB (per §4). Built
last; console and file ship first.

---

### 7. Adapters

Adapters are the **only** framework-specific code. Each reads the incoming request
in that framework's shape, builds a `RequestContext`, and runs the rest of the
request inside `contextStore.run(context, next)`.

| Framework | Mechanism |
|---|---|
| Express | Middleware `(req, res, next)` |
| Fastify | `onRequest` hook |
| NestJS | Middleware or Interceptor (fits Nest's execution model) |
| Node (manual) | A helper to open a context explicitly, for non-HTTP entry points (jobs, scripts) |

Example (NestJS middleware):

```ts
@Injectable()
export class AuditMiddleware implements NestMiddleware {
  use(req: any, _res: any, next: () => void) {
    const context: RequestContext = {
      correlationId: req.headers['x-correlation-id'] ?? randomUUID(),
      request: {
        httpMethod: req.method,
        endpoint: req.originalUrl,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
      actor: { userId: req.user?.id, userRole: req.user?.role },
    };
    contextStore.run(context, () => next());
  }
}
```

Correlation ID: reused from the `x-correlation-id` header if present (cross-service
correlation), otherwise generated — this service becomes the origin. The same ID
lives in the store for the whole request; every `record()` call during that request
reads it automatically. Concurrent requests are isolated by `AsyncLocalStorage` —
they never share or mix IDs.

---

### 8. Usage Example (NestJS, console transport)

```ts
// main.ts — configure once
import { configureAudit } from '@tnet06/mapa-audit-sdk';
import { ConsoleTransport } from '@tnet06/mapa-audit-sdk/transports';

configureAudit({
  serviceName: 'recipes-api',
  environment: 'production',
  transport: new ConsoleTransport(),   // or omit for the default; or FileTransport
});
```

```ts
// app.module.ts — register the adapter
consumer.apply(AuditMiddleware).forRoutes('*');
```

```ts
// recipes.controller.ts — record anywhere, no context passed manually
record({
  eventType: 'business',
  eventName: 'recipe.updated',
  outcome: 'success',
  entity: { type: 'recipe', id: recipe.id },
  payload: { changes: { title: { before, after } } },
});
// automatically carries correlationId, request.*, actor.* of THIS request
```

Switching to file output is a one-line change at `configureAudit` — no controller
or middleware code changes.

---

### 9. Failure & Durability (per transport)

Durability depends on the chosen transport, not the SDK core:

| Transport | Durability characteristics |
|---|---|
| Console | Ephemeral — goes to stdout/stderr; capture is best-effort by nature |
| File | Persisted to local disk; durability = the file's durability |
| Queue | Decoupled pipeline; best-effort producer buffer (documented in the queue-transport module) |

Universal guarantee across all transports: **`record()` never blocks or throws into
the host application.** A transport error is contained and, where sensible, logged —
never propagated to business logic.

---

### 10. Distribution & Packaging

- **`@tnet06/mapa-audit-sdk`** — core + console + file transports + adapters. Main
  package; zero heavy dependencies; works standalone.
- **`@tnet06/mapa-audit-types`** — shared event contract; published alongside the
  SDK (the SDK depends on it).
- **Queue transport in its own package** (e.g. `@tnet06/mapa-audit-transport-queue`)
  — carries `amqp-connection-manager` and related deps, so console/file-only
  consumers never install them. Built last.
- **Worker + infra are NOT npm packages** — they're deployable services
  (Docker/Terraform), used only by consumers who adopt the queue transport.
- Semantic versioning via `changesets`; framework deps as `peerDependencies`;
  MIT-licensed; published to the public npm registry for portfolio/community use, or
  an internal registry in a company context — same code, different registry.

---

### 11. Out of Scope for v1

- Queue transport + Worker + TimescaleDB module (built after console/file are solid).
- Additional framework adapters beyond the first (each its own later phase).
- Automatic correlation-ID propagation on outbound HTTP calls.
- Built-in PII hashing at capture (planned config hook).

Documented as conscious boundaries — the console/file path is the v1 focus; the
queue path is a deliberate later module.