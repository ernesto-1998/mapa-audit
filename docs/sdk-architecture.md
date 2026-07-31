# Audit & Business Observability Platform
## SDK Architecture Document (Current State — v3)

**Status:** Reflects the implemented SDK as of this revision
**Audience:** Engineering
**Companion to:** Platform Design Overview (future queue module), Database Design
(TimescaleDB, future queue module), RabbitMQ + Worker Architecture (future queue
module)

> **Superseded content notice:** this document replaces all earlier revisions.
> Earlier drafts described a `configureAudit()`/`transport` (singular) API and a
> `core/configure.ts` file that no longer exist. This document reflects the SDK as
> actually implemented.

---

### 1. Purpose

This document describes the SDK that backend services use to record audit,
business, error, and security events. The SDK's core value is **automatic,
framework-aware capture of request context** (correlation ID, actor, request
metadata) plus a **structured business-audit event model with built-in data
safety** (field masking, payload size limiting) — not log transport, which is a
solved problem the SDK deliberately does not try to out-compete.

Where events go is a **pluggable transport**: console or file today; a queue
feeding a persistence pipeline is a future, separate, opt-in module (see §10).

Design priorities:

- A minimal, stable public surface, offered in two complementary shapes: a
  **creational API** (isolated instances) and a **global convenience API** (a
  singleton wrapper over one creational instance) — see §2.
- **Two independent axes:** adapters (capture, per framework) and transports
  (delivery, per destination) — neither knows about the other.
- Zero-infrastructure default: works out of the box (console) with no queue or DB.
- Built-in data safety: sensitive field masking and payload size limiting, applied
  once during event assembly, before any transport sees the event.
- Explicit lifecycle: transports may declare a `close()` to drain pending work; the
  SDK exposes `shutdown()` so no event is silently lost on process exit.
- Visible failure: transport errors and misconfiguration emit `process.emitWarning`
  instead of failing silently — while still never throwing into the host app.

---

### 2. The Two APIs: Creational vs. Global

The SDK exposes two ways to get an audit client. They share **one implementation**
— the global API is a thin wrapper over a creational instance, not a duplicate.

```
createAudit(config) ──────────────► AuditInstance
                                       { record(), shutdown(), getInfo() }
                                       Isolated state (closure), no module globals.

initGlobalAudit(config) ──► internally calls createAudit() and stores the
                             resulting instance in a module-level singleton.
record(input) ─────────────► delegates to the stored global instance.
shutdownGlobalAudit() ──────► delegates to the stored global instance's shutdown().
resetGlobalAudit() ─────────► clears the stored global instance (test isolation).
getGlobalAudit() ───────────► read-only inspection view (see §2.3), never the
                               instance itself.
```

**When to use which:**

- **Global (`initGlobalAudit` + `record`)** — the common case: one audit
  configuration per process, a single app/service initialized once at startup.
  Ergonomic — `record()` is imported and called anywhere without threading an
  instance through call stacks. This mirrors how logging/telemetry SDKs in the
  wider ecosystem work (e.g. Sentry's `init()` + global capture calls).
- **Creational (`createAudit`)** — when isolated, independent configurations are
  needed in the same process: tests with independent state, multi-tenant
  scenarios, or any case where a single global configuration is not enough.

#### 2.1 Why a global singleton, deliberately

Earlier design discussion considered eliminating the global entirely in favor of a
pure creational API. That was rejected: audit/observability is a cross-cutting
concern used throughout a codebase, and forcing every call site to receive and
thread an instance is worse ergonomics for the common case, with no compensating
benefit. This mirrors established practice (Sentry, OpenTelemetry, Winston) where a
configurable global convenience layer coexists with instance creation.

#### 2.2 Why the global never mutates in place

`initGlobalAudit()` is called once, at startup. There is **no** API to add/remove
transports or change configuration on the live global instance afterward.
Mutating shared global state at runtime is exactly the kind of unpredictability
that makes concurrent systems hard to reason about — a `record()` call in one part
of the app could silently behave differently depending on whether another part
mutated the global first. If isolated, independently-controlled configuration is
needed, use `createAudit()` instead — mutating your *own* instance is safe because
only you hold it.

`resetGlobalAudit()` is the one exception, and it is a full atomic replacement (for
test isolation), not a partial mutation.

#### 2.3 `getGlobalAudit()` — inspection, not control

Returns a `GlobalAuditInfo` object (`{ configured, serviceName, environment,
transportCount }`) — a **read-only snapshot**, not the instance itself. It never
exposes `record()`, `shutdown()`, or the underlying transports array. This is
"read-only by construction": the returned object has no way to affect the global
instance, rather than relying on callers not to misuse a mutable reference.
Returns `undefined` if the global was never initialized.

---

### 3. Package Structure (current)

```
packages/sdk/
├── src/
│   ├── core/
│   │   ├── storage.ts        → AsyncLocalStorage + RequestContext
│   │   ├── transport.ts      → the Transport interface (send + optional close)
│   │   ├── audit-instance.ts → AuditConfig, AuditInstance, GlobalAuditInfo,
│   │   │                        createAudit() — the creational factory
│   │   ├── record.ts         → RecordInput, buildAuditEvent(), sendFireAndForget(),
│   │   │                        payload masking/truncation, the public record()
│   │   │                        shortcut (delegates to global-audit.ts)
│   │   ├── global-audit.ts   → initGlobalAudit, recordGlobal, shutdownGlobalAudit,
│   │   │                        resetGlobalAudit, getGlobalAudit — the thin global
│   │   │                        singleton wrapper
│   │   ├── flatten.ts        → flatten() + AUDIT_EVENT_CSV_COLUMNS (shared helper
│   │   │                        for tabular output; canonical CSV schema)
│   │   └── warnings.ts       → emitAuditWarning(), errorMessage() — shared,
│   │                            reused by record.ts and transports/file.ts
│   ├── transports/
│   │   ├── console.ts        → ConsoleTransport (process.stdout/stderr)
│   │   └── file.ts           → FileTransport (jsonl/csv/text)
│   ├── adapters/
│   │   └── express.ts        → expressAdapter(options?)
│   └── index.ts               → public exports
├── package.json
└── tsconfig.json / tsconfig.build.json
```

Note on the split between `audit-instance.ts`, `record.ts`, and `global-audit.ts`:
these were reorganized out of a single `configure.ts` once that file had
accumulated four unrelated responsibilities (instance creation, event assembly,
dispatch, global singleton management). Each file now owns one responsibility;
`configure.ts` no longer exists.

Adapters and transports are exposed as **subpath exports**
(`@tnet06/mapa-audit-sdk/express`, `@tnet06/mapa-audit-sdk/transports`) so a
consumer only pulls in what they use. The queue transport, when built, will live in
its **own package** (see §10), not here.

---

### 4. Event Data Model (nested canonical form, flattened on output)

Unchanged from earlier design — this remains foundational.

```ts
// defined in @tnet06/mapa-audit-types, imported by the SDK (never redeclared)
interface AuditEvent {
  readonly id: string;                 // client-generated UUID
  correlationId?: string;
  causationId?: string;
  eventType: string;
  eventName: string;
  severity: string;
  outcome?: string;
  readonly occurredAt: string;         // ISO timestamp
  payloadSchemaVersion?: number;

  service: {
    name: string;
    version?: string;
    environment: string;
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
    type?: string;            // e.g. 'user' | 'service' | 'system'
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

`id` and `occurredAt` are `readonly` — they are SDK-generated and not meant to be
mutated by consumers who receive the event (e.g. inside a custom `Transport`).

**Nested internally, flattened only at output** (unchanged principle): the core
produces this nested shape; only tabular transports (CSV) flatten it, via the
shared `flatten()` helper in `core/flatten.ts`. Console and JSONL preserve the
nested structure as-is.

**Schema drift protection:** because `AUDIT_EVENT_CSV_COLUMNS` (the canonical CSV
schema) is a hand-maintained list, a dedicated test
(`test/core/flatten.sync.test.ts`) verifies that a fully-populated `AuditEvent`,
once flattened, produces exactly the same key set as `AUDIT_EVENT_CSV_COLUMNS` —
neither more nor fewer. This catches silent drift if a field is added to
`AuditEvent` without updating the CSV schema, or vice versa.

---

### 5. Core

#### 5.1 `storage.ts` — request context via AsyncLocalStorage

Unchanged in design. `AsyncLocalStorage` provides a store isolated per async
execution chain (per request). `contextStore.run(context, callback)` is called by
adapters, once per request; `getContext()` reads the current store from anywhere
inside that chain.

```ts
export interface RequestContext {
  correlationId: string;
  causationId?: string;
  request?: NonNullable<AuditEvent['request']>;
  actor?: NonNullable<AuditEvent['actor']>;
}

export const contextStore = new AsyncLocalStorage<RequestContext>();
export function getContext(): RequestContext | undefined {
  return contextStore.getStore();
}
```

#### 5.2 `transport.ts` — the Transport contract

```ts
export interface Transport {
  send(event: AuditEvent): void | Promise<void>;
  /** Optional. Drains any pending work before shutdown. Transports with nothing
   *  to flush (e.g. ConsoleTransport) may omit this. */
  close?(): Promise<void>;
}
```

The core depends only on this interface — never on a concrete transport.
`close()` is opt-in: `ConsoleTransport` does not implement it (nothing to drain);
`FileTransport` does (drains its internal write queue).

#### 5.3 `audit-instance.ts` — `createAudit()` and `AuditInstance`

```ts
export interface AuditConfig {
  serviceName: string;
  serviceVersion?: string;
  environment: Environment;         // validated against the shared Environment union
  transports?: Transport[];         // default: [new ConsoleTransport()]
  maskedFields?: string[];          // dot-notation paths into payload (see §5.4)
  maxPayloadSize?: number;          // bytes; default 1_000_000 (1MB)
}

export interface AuditInstance {
  record(input: RecordInput): void;
  shutdown(): Promise<void>;
  getInfo(): GlobalAuditInfo;
}

export function createAudit(config: AuditConfig): AuditInstance;
```

Each call to `createAudit()` creates fully isolated state (service metadata,
transports array, masking/size options, shutdown flags) inside a closure — nothing
is shared at module scope. `record()` on the returned instance:

1. Builds the event via `buildAuditEvent()` (§5.4), merging context + service +
   caller input.
2. Dispatches to every configured transport via `sendFireAndForget()` (§5.5),
   isolated per transport.

`shutdown()` calls `close()` on every transport that implements it, in parallel,
and is idempotent (a second call awaits the same in-flight shutdown rather than
re-running it). Once `shutdown()` has started, `record()` on that instance becomes
a no-op — no new work is queued into a transport that's being torn down.

#### 5.4 `record.ts` — event assembly, masking, and size limiting

`buildAuditEvent()` assembles the nested `AuditEvent`: client-generated `id`
(`randomUUID()`, preserved for future queue-transport idempotency), context merge,
default `severity: 'info'`, and payload preparation.

**Payload masking (`maskedFields`)** — supports dot-notation paths of arbitrary
depth (`'creditCard'`, `'user.ssn'`, `'payment.card.cvv'`). Implementation:

- Only clones (`structuredClone`) the payload when masking is actually configured
  — no cost for consumers who don't use it.
- Navigates each path segment by segment; aborts that path silently (no throw) if
  a segment is missing, `null`, a primitive, or an array. **Array element masking
  is not supported** in this version (documented limitation — e.g.
  `payments.0.cvv` will not be masked; if array elements carry sensitive data,
  flatten or redact them before calling `record()`).
- Matched values are replaced with the string `'***'`.
- The caller's original payload object is never mutated, at any depth.

**Payload size limiting (`maxPayloadSize`)** — applied *after* masking (so a large
but subsequently-masked payload is measured post-mask). If the serialized payload
exceeds the configured byte limit, the entire payload is replaced with:
```ts
{ truncated: true, originalSizeBytes: number, maxSizeBytes: number }
```
Partial truncation of the JSON string is deliberately avoided (it would risk
producing invalid JSON); the marker object is a clean, unambiguous replacement.

#### 5.5 `sendFireAndForget()` — dispatch, isolated per transport

```ts
export function sendFireAndForget(transport: Transport, event: AuditEvent): void
```

For a single transport: calls `send()`; if it throws synchronously or returns a
rejecting Promise, the error is caught and reported via `emitAuditWarning()`
(§5.6) — never re-thrown, never propagated to the caller. `AuditInstance.record()`
calls this once per configured transport, in a loop with each call independently
try/caught — a failure in one transport never affects delivery to the others
(fan-out isolation).

#### 5.6 `warnings.ts` — shared warning helper

```ts
export function emitAuditWarning(message: string): void;  // process.emitWarning(`[mapa-audit] ${message}`), self-guarded
export function errorMessage(error: unknown): string;      // safe unknown -> string
```

Extracted to avoid duplicating the same warning-emission logic between
`record.ts` (transport dispatch failures) and `transports/file.ts` (write
failures). Used for: transport send failures, file write failures, and the
one-time "record() called before initGlobalAudit()" warning (§5.7).

#### 5.7 `global-audit.ts` — the global convenience singleton

```ts
export function initGlobalAudit(config: AuditConfig): void;      // creates and stores one createAudit() instance
export function recordGlobal(input: RecordInput): void;           // delegates to the stored instance; warns once if none exists
export function shutdownGlobalAudit(): Promise<void>;
export function resetGlobalAudit(): void;                         // test isolation
export function getGlobalAudit(): GlobalAuditInfo | undefined;    // §2.3
```

If `record()` (the public shortcut, re-exported from `record.ts`) is called before
`initGlobalAudit()`, the event is silently discarded **and** a `process.emitWarning`
is emitted — but only **once** per process (a module-level flag prevents repeated
warnings from flooding output on repeated misuse). `resetGlobalAudit()` also
resets this flag, so each test that needs to re-trigger the warning can.

---

### 6. Transports

#### 6.1 ConsoleTransport

```ts
export class ConsoleTransport implements Transport {
  send(event: AuditEvent): void { /* process.stdout.write or process.stderr.write */ }
}
```

Writes directly to `process.stdout` / `process.stderr` — **not** `console.log`
(control and throughput, same rationale as Pino/Winston). Events with severity
`error` or `critical` go to `stderr`; everything else to `stdout`. Emits the
nested event as a single line of JSON (no flattening). No `close()` — nothing to
drain. This is the default when no `transports` are configured.

**Data-safety note:** `ConsoleTransport` writes the event as received. It does not
redact anything on its own; `maskedFields` (§5.4) must be configured by the
consumer for sensitive fields to be redacted before they reach any transport,
including console.

#### 6.2 FileTransport

```ts
export interface FileTransportOptions {
  path: string;
  format?: 'jsonl' | 'csv' | 'text';   // default: 'jsonl'
}
```

Appends one entry per event (never rewrites the file). Robustness details:

- **Directory creation** is cached as a one-time operation (`#ensureDirectory`),
  not repeated on every `send()`.
- **Write ordering** under fire-and-forget: writes are chained through an internal
  `#pendingWrite` promise, so concurrent `send()` calls on the same instance are
  serialized and applied in order, even though the caller never awaits them.
- **`close()`** awaits `#pendingWrite`, draining any queued writes before
  resolving — this is what `AuditInstance.shutdown()` relies on to avoid losing
  the last event(s) on process exit.
- **Write failures** are reported via `emitAuditWarning()` (§5.6), not swallowed.

**Formats:**
- `'jsonl'` (default) — one line of nested JSON per event.
- `'csv'` — uses `flatten()` (§4) against the canonical, fixed
  `AUDIT_EVENT_CSV_COLUMNS` schema. The header is written once, decided by an
  **in-memory flag** (`#headerWritten`), not by re-checking the filesystem on
  every write — this closes a race condition where concurrent `send()` calls
  could each observe an "empty file" and each write a duplicate header. Missing
  fields are left as **empty cells** (never the literal string `"null"`).
  **Known limitation:** this protects a single `FileTransport` instance/process.
  Multiple separate instances (or processes) writing to the *same* CSV path can
  still race — if several parts of an app, or several `createAudit()` calls, need
  to write to the same file, share one `FileTransport` instance rather than
  creating several pointed at the same path. Multi-process concurrent writers
  would need OS-level file locking, which is out of scope.
- `'text'` — a single human-readable line, intentionally minimal:
  `<occurredAt> [<eventType>/<severity>] <eventName> correlationId=<...> outcome=<...>`.
  This is deliberately not exhaustive (no actor/entity/service/payload) — it is
  meant for quick human scanning, not full fidelity; use `'jsonl'` when the
  complete event is needed.

**Not implemented:** file rotation (`maxSize`/`maxFiles`). For high-volume
production use, pair `FileTransport` with an external rotation tool (e.g.
`logrotate`) or defer to the future queue/DB module.

---

### 7. Adapters

#### 7.1 `expressAdapter(options?)`

```ts
export interface ExpressAdapterOptions {
  correlationIdHeader?: string;   // default: 'x-correlation-id'
  causationIdHeader?: string;     // default: 'x-causation-id'
  extractActor?: (req: Request) => NonNullable<RequestContext['actor']> | undefined;
                                    // default: reads req.user?.id / req.user?.role,
                                    // infers type: 'user' (ActorType) when present
}

export function expressAdapter(options?: ExpressAdapterOptions): RequestHandler;
```

Builds a `RequestContext` from the incoming request and runs the rest of the
request inside `contextStore.run(context, next)`. `correlationId` is reused from
the configured header if present (cross-service correlation), otherwise generated
(`randomUUID()`) — this service becomes the origin. `causationId` is read the same
way, symmetrically, and left absent if the header is missing.

`extractActor`, when provided, **fully replaces** the default `req.user`-based
extraction (not merged with it) — the caller owns the entire actor shape. Default
extraction is defensive: `req.user`, `req.route`, and header values may be
`undefined` and are handled without throwing; when present, `actor.type` defaults
to `'user'` (`ActorType`), so requests captured with an authenticated user are
correctly classified rather than leaving `type` empty.

This is the only adapter implemented today. Fastify and NestJS adapters, plus a
manual-context helper for non-HTTP entry points (jobs, CLI scripts), remain
planned but unimplemented — see the BUILD_PLAN.

---

### 8. Usage Example (Express, console transport)

```ts
// main.ts — configure once, at startup
import { initGlobalAudit } from '@tnet06/mapa-audit-sdk';
import { ConsoleTransport } from '@tnet06/mapa-audit-sdk/transports';

initGlobalAudit({
  serviceName: 'recipes-api',
  environment: 'production',
  transports: [new ConsoleTransport()],   // omit for the same default
  maskedFields: ['creditCard', 'user.ssn'],
});
```

```ts
// app setup — register the adapter before routes
import { expressAdapter } from '@tnet06/mapa-audit-sdk/express';
app.use(expressAdapter());
```

```ts
// anywhere in a request handler — record, no context passed manually
import { record } from '@tnet06/mapa-audit-sdk';

record({
  eventType: 'business',
  eventName: 'recipe.updated',
  outcome: 'success',
  entity: { type: 'recipe', id: recipe.id },
  payload: { changes: { title: { before, after } } },
});
// automatically carries correlationId, request.*, actor.* of THIS request
```

```ts
// graceful shutdown — drain pending transport writes before exit
import { shutdownGlobalAudit } from '@tnet06/mapa-audit-sdk';

process.on('SIGTERM', async () => {
  await shutdownGlobalAudit();
  process.exit(0);
});
```

A runnable version of this pattern (multiple endpoints, all transports, masking,
and truncation demonstrated live) exists at `examples/express-demo/` in this
repository.

---

### 9. Failure & Durability

| Transport | Durability characteristics |
|---|---|
| Console | Ephemeral — goes to stdout/stderr; best-effort by nature |
| File | Persisted to local disk; durability = the file's durability; writes serialized and drainable via `close()`/`shutdown()` |
| Queue (future) | Decoupled pipeline; see §10 |

Universal guarantees, regardless of transport:
- `record()`/`AuditInstance.record()` never blocks or throws into the host
  application.
- A transport failure is contained and reported via `process.emitWarning` — never
  propagated to business logic.
- `shutdown()` drains transports that support draining before the process exits,
  when the host app calls it on a signal handler (see §8).

---

### 10. Distribution & Packaging, and the Future Queue Module

- **`@tnet06/mapa-audit-sdk`** — core + console + file transports + adapters. Main
  package; zero heavy dependencies; works standalone.
- **`@tnet06/mapa-audit-types`** — shared event contract; published alongside the
  SDK (the SDK depends on it).
- **A queue transport, Worker, and TimescaleDB persistence pipeline remain a
  future, separate, opt-in module** — described at a design level in
  `platform-general-overview.md`, `database-design.md`, and
  `rabbitmq-worker-architecture.md`. **None of that is implemented today.** Those
  documents should be read as forward-looking design, not as a description of the
  current SDK's behavior. When built, the queue transport will ship as its own
  package (carrying `amqp-connection-manager` and related dependencies so
  console/file-only consumers never install them), implementing the same
  `Transport` interface — a drop-in addition, not a core dependency.
- The Worker and supporting infra are not npm packages — they are deployable
  services (Docker/Terraform), relevant only to consumers who adopt the future
  queue transport.
- MIT-licensed; publishable to the public npm registry or an internal registry —
  same code, different registry destination (not yet published as of this
  revision — see the project's publication checklist for outstanding
  `package.json` metadata work).

---

### 11. Out of Scope (current, deliberate)

- Queue transport + Worker + TimescaleDB module (§10) — future, separate.
- Additional framework adapters beyond Express (Fastify, NestJS, a manual-context
  helper for non-HTTP contexts) — planned, unimplemented.
- File rotation (`maxSize`/`maxFiles`) in `FileTransport` — pair with an external
  tool if needed.
- Array-element masking in `maskedFields` (only object paths are supported).
- Automatic correlation-ID propagation on outbound HTTP calls made by the service
  itself.
- Multi-process file locking for `FileTransport` CSV writes to a shared path.

Documented as conscious boundaries, not omissions.