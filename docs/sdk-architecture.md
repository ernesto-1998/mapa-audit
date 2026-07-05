# Audit & Business Observability Platform
## SDK Architecture Document (v2)

**Status:** Draft for review
**Audience:** Engineering
**Companion to:** Platform Design Overview, Database Design (v2)

---

### 1. Purpose

This document describes the SDK that backend services use to emit audit, business, error, and security events to the platform. The SDK is the **only** component application developers interact with directly — it hides RabbitMQ, correlation propagation, and event formatting behind a small, stable public API.

Design priorities:

- A minimal, stable public surface (two functions cover ~95% of usage).
- Framework independence at the core, with thin adapters per framework.
- Zero business logic — the SDK captures context and publishes; it never decides what an event *means*.
- Safe failure behavior — a broken pipeline must never take down or slow the host application.
- Client-generated event identity, so the platform can guarantee idempotency downstream.

---

### 2. Package Structure

```
packages/sdk/
├── src/
│   ├── core/
│   │   ├── storage.ts        → AsyncLocalStorage instance + helpers
│   │   ├── producer.ts       → RabbitMQ connection + publish logic
│   │   ├── record.ts         → public record() function
│   │   ├── contextBuilder.ts → merges ALS context + explicit event data
│   │   └── config.ts         → init(), validates config
│   ├── adapters/
│   │   ├── express.ts
│   │   ├── fastify.ts
│   │   ├── nestjs.ts
│   │   └── nextjs.ts
│   ├── types.ts              → AuditEvent, EventType, Severity, InitConfig
│   └── index.ts               → public exports only
├── package.json
└── tsconfig.json
```

Only `index.ts` is a public entry point. Adapters are exposed as **subpath exports** (`@tuorg/audit-sdk/express`, `/fastify`, etc.) so a project using Express never bundles NestJS-specific code, and vice versa.

---

### 3. Public API Surface

The entire public contract a consuming developer must learn:

```ts
import { initAuditSDK, record } from '@tuorg/audit-sdk';
import { expressAdapter } from '@tuorg/audit-sdk/express';

initAuditSDK({
  serviceName: 'recipes-api',
  serviceVersion: '1.4.0',
  environment: 'production',
  amqpUrl: process.env.AUDIT_AMQP_URL,
});

app.use(expressAdapter());

// anywhere in business logic — no request object needed:
record({
  eventType: 'business',
  eventName: 'recipe.updated',
  entityType: 'recipe',
  entityId: recipeId,
  payload: { changes: { title: { before, after } } },
});
```

Correlation ID, IP, endpoint, user, and service metadata are captured automatically by the adapter and merged in by `record()`. The developer never passes them manually.

---

### 4. Core Modules

#### 4.1 `storage.ts` — AsyncLocalStorage

Holds per-request context for the request's lifetime, regardless of how deep in the call stack `record()` is invoked. Framework-agnostic — it only knows how to store and retrieve a plain object for the current async execution context.

```ts
export interface RequestContext {
  correlationId: string;
  requestId: string;
  serviceName: string;
  environment: string;
  httpMethod?: string;
  endpoint?: string;
  routePattern?: string;
  ipAddress?: string;
  userAgent?: string;
  serverName?: string;
  userId?: string;
  userRole?: string;
  tenantId?: string;
}

export const auditContext = new AsyncLocalStorage<RequestContext>();
```

#### 4.2 `producer.ts` — RabbitMQ Publisher

Maintains a single long-lived connection/channel (using `amqp-connection-manager` for automatic reconnection, consistent with patterns already used in this codebase) and publishes events to the configured exchange.

Its most important property: **it never throws into the caller's request flow.** If the queue is unreachable, it buffers events in a capped in-memory ring buffer and logs a warning. It does not retry synchronously and does not block the request.

```ts
export async function publish(event: AuditEvent): Promise<void> {
  try {
    await channel.publish(EXCHANGE_NAME, event.eventType, serialize(event));
  } catch (err) {
    bufferLocally(event);
    logger.warn('[audit-sdk] queue unreachable, event buffered locally');
  }
}
```

> **Durability note (see §7).** This in-memory buffer is a *best-effort* mechanism. It follows directly from the platform's observability-first positioning: protecting the host application is worth more than guaranteeing every single event. This is a conscious trade-off, not an oversight, and it is the SDK's single most consequential behavioral decision.

#### 4.3 `record.ts` — Public Event Function

```ts
export function record(input: RecordInput): void {
  const ctx = auditContext.getStore();

  const event: AuditEvent = {
    id: randomUUID(),                 // generated HERE, client-side — see §6
    correlationId: ctx?.correlationId ?? randomUUID(),
    requestId: ctx?.requestId,
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    environment: config.environment,
    eventType: input.eventType,
    eventName: input.eventName,
    severity: input.severity ?? defaultSeverityFor(input.eventType),
    httpMethod: ctx?.httpMethod,
    endpoint: ctx?.endpoint,
    routePattern: ctx?.routePattern,
    ipAddress: ctx?.ipAddress,
    userAgent: ctx?.userAgent,
    serverName: ctx?.serverName,
    userId: ctx?.userId,
    userRole: ctx?.userRole,
    tenantId: ctx?.tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    payloadSchemaVersion: input.payloadSchemaVersion ?? 1,  // see §8
    payload: input.payload ?? {},
    occurredAt: new Date().toISOString(),
  };

  void publish(event); // fire-and-forget, never awaited by caller
}
```

`record()` is intentionally **synchronous and fire-and-forget** from the caller's perspective. Business logic must never wait on audit logging — awaiting it would reintroduce exactly the coupling the queue exists to remove.

#### 4.4 `config.ts` — Initialization

```ts
export interface InitConfig {
  serviceName: string;
  serviceVersion?: string;
  environment: 'development' | 'staging' | 'production';
  amqpUrl: string;
  exchangeName?: string;   // default: 'audit.events'
  bufferSize?: number;     // default: 1000
}

export function initAuditSDK(cfg: InitConfig): void { ... }
```

Configuration is always explicit via `initAuditSDK()` — never inferred from ambient environment variables inside the SDK. The consuming app decides how to source `amqpUrl` and passes it in, keeping the contract simple and testable. `environment` is validated against the same allowed values the database enforces, so invalid values fail fast at startup rather than silently at insert.

---

### 5. Adapters

Adapters are the **only** framework-specific code in the package. Each has exactly one job: read the incoming request in whatever shape the framework exposes, build a `RequestContext`, and run the remainder of the request inside `auditContext.run(context, next)`.

| Framework | Mechanism |
|---|---|
| Express | Standard middleware `(req, res, next)` |
| Fastify | `onRequest` hook |
| NestJS | `Interceptor` (fits Nest's DI and execution-context model better than raw middleware) |
| Next.js | Depends on router type — Middleware for App Router, or a wrapper around Route Handlers |

Example (Express):

```ts
export function expressAdapter() {
  return (req: Request, res: Response, next: NextFunction) => {
    const context: RequestContext = {
      correlationId: (req.headers['x-correlation-id'] as string) ?? randomUUID(),
      requestId: randomUUID(),
      serviceName: config.serviceName,
      environment: config.environment,
      httpMethod: req.method,
      endpoint: req.originalUrl,
      routePattern: req.route?.path,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      serverName: os.hostname(),
      userId: (req as any).user?.id,
      userRole: (req as any).user?.role,
    };
    auditContext.run(context, next);
  };
}
```

Supporting a new framework = one new adapter file. The core never changes.

---

### 6. Idempotency Contract (the SDK's most important guarantee)

The SDK generates `event.id` **before publishing**, not the database at insert time. This is what makes the Worker's deduplication possible: if RabbitMQ redelivers a message (at-least-once delivery), the same `id` arrives twice, and the Worker safely applies `ON CONFLICT DO NOTHING`. If `id` were left to the database, every redelivery would silently create a duplicate row.

This is a **fixed platform-wide contract**, not an implementation detail. Changing where `id` is generated is a breaking change across the entire platform.

---

### 7. Durability & Failure Modes

Consistent with the platform's observability-first positioning, the SDK prioritizes host-application safety over event-delivery guarantees.

| Scenario | SDK Behavior |
|---|---|
| RabbitMQ unreachable at publish time | Buffer in memory (capped), log warning, never throw |
| In-memory buffer full | Oldest events dropped, warning logged with drop count |
| Host process crashes with buffered events | **Buffered events are lost** — buffer is in-memory only in v1 |
| `record()` called outside a request context (no ALS store) | Event still published; `correlationId` generated fresh, request-specific fields left `null` |
| Malformed `payload` (circular reference, etc.) | Caught at serialization; event dropped with an error log — never crashes the host |

> **Explicit limitation:** because the buffer is in-memory, events can be lost on queue outage + buffer overflow, or on process crash. Teams requiring guaranteed capture for specific event types must treat that as a scoped platform extension (a disk-backed buffer or a synchronous local-durable write path), not an assumption about v1 behavior.

---

### 8. Payload Schema Governance

JSONB flexibility is a strength, but ungoverned it becomes a maintenance swamp where no one knows what fields exist per `event_type`, and dashboards break when a service silently changes its payload shape.

To keep flexibility without chaos:

- Every event carries a `payloadSchemaVersion` (defaulting to `1`), persisted as a fixed column in the database.
- When a service changes the shape of its payload for a given `eventName`, it increments the version. Dashboards and API consumers can then branch on version instead of guessing.
- A lightweight, per-service **event catalog** (which `eventName`s a service emits, and the expected payload shape per version) is recommended documentation — cheap to maintain, invaluable six months in.

This costs almost nothing to add now and is impossible to reconstruct retroactively.

---

### 9. Sensitive Data Responsibility

The SDK captures personal data by design — `ipAddress`, `userId`, `userAgent`. Consuming teams and platform operators should be aware:

- This is PII and subject to data-protection obligations wherever the organization operates.
- The SDK provides a config-level hook (planned) to **opt out of** or **hash** specific fields (e.g. IP anonymization) at capture time, for services that don't need raw values. Until built, teams should be conscious of what they capture.
- Retention and per-user erasure are handled downstream (storage layer / platform policy), not in the SDK — but the SDK is the capture point, so field-level minimization here is the cheapest place to reduce exposure.

---

### 10. Correlation ID Propagation

- If an incoming request carries an `x-correlation-id` header, the adapter reuses it — this is what enables correlation **across services**, not just within one.
- If absent, the adapter generates a new UUID; this service becomes the origin of the correlation chain.
- Propagating the header on **outbound** internal HTTP calls is currently the consuming team's responsibility. Automatic propagation would require the SDK to also wrap the HTTP client — a documented future addition, out of scope for v1.

---

### 11. Versioning & Distribution

- **Semantic versioning** enforced via `changesets` — every PR touching `packages/sdk` requires a changeset stating patch/minor/major intent.
- **Framework packages** (`express`, `fastify`, etc.) are declared as `peerDependencies`, never bundled — the host's installed version is used, avoiding duplicate copies and version conflicts.
- **Published to npm** (public registry for portfolio purposes; a private registry such as GitHub Packages is the equivalent in a real company setting).

---

### 12. Out of Scope for v1

- Disk-backed / crash-durable buffer (in-memory only today).
- Automatic correlation-ID propagation on outbound HTTP calls.
- Built-in PII hashing/anonymization hooks (planned, not yet implemented).
- Event batching/compression.
- Browser/frontend SDK variant.

Documented as conscious boundaries, each a candidate for a future scoped iteration.