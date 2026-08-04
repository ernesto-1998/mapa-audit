# Audit & Business Observability Platform
## SDK Architecture Document (Current State — v4)

**Status:** Reflects the implemented SDK as of this revision
**Audience:** Engineering
**Companion to:** Platform Design Overview (future queue consumption module),
Database Design (TimescaleDB, future), RabbitMQ + Worker Architecture (future
Worker; the SDK-side publisher is implemented — see §10)

> **Superseded content notice:** this document replaces all earlier revisions,
> including v3. Since v3, three things changed: (1) all three planned HTTP
> adapters (Express, NestJS, Fastify) are now implemented, not just Express;
> (2) the `Transport` interface moved from the SDK to
> `@tnet06/mapa-audit-types`; (3) the first queue transport
> (`@tnet06/mapa-audit-transport-rabbitmq`, publish-only) exists as an
> independent package. This document reflects the SDK as actually
> implemented.

---

### 1. Purpose

This document describes the SDK that backend services use to record audit,
business, error, and security events. The SDK's core value is **automatic,
framework-aware capture of request context** (correlation ID, actor, request
metadata) plus a **structured business-audit event model with built-in data
safety** (field masking, payload size limiting) — not log transport, which is a
solved problem the SDK deliberately does not try to out-compete.

Where events go is a **pluggable transport**: console or file today, with a
publish-only RabbitMQ transport also available as a separate package. A
consuming Worker feeding a persistence pipeline remains a future, separate,
opt-in service (see §10).

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
packages/
├── types/
│   └── src/index.ts       → AuditEvent, ActorType, Environment, EventType,
│                              EventSeverity, EventOutcome, and Transport
│                              (moved here in this revision — see §5.2)
├── sdk/
│   └── src/
│       ├── core/
│       │   ├── storage.ts        → AsyncLocalStorage + RequestContext,
│       │   │                        getContext(), setActor() (§5.1)
│       │   ├── transport.ts      → re-exports Transport from
│       │   │                        @tnet06/mapa-audit-types (§5.2)
│       │   ├── audit-instance.ts → AuditConfig, AuditInstance, GlobalAuditInfo,
│       │   │                        createAudit() — the creational factory
│       │   ├── record.ts         → RecordInput, buildAuditEvent(),
│       │   │                        sendFireAndForget(), payload masking/
│       │   │                        truncation, the public record() shortcut
│       │   ├── global-audit.ts   → initGlobalAudit, recordGlobal,
│       │   │                        shutdownGlobalAudit, resetGlobalAudit,
│       │   │                        getGlobalAudit
│       │   ├── flatten.ts        → flatten() + AUDIT_EVENT_CSV_COLUMNS
│       │   └── warnings.ts       → emitAuditWarning(), errorMessage()
│       ├── transports/
│       │   ├── console.ts        → ConsoleTransport
│       │   └── file.ts           → FileTransport (jsonl/csv/text)
│       ├── adapters/
│       │   ├── http-context.ts   → buildHttpRequestContext(), nonEmptyString(),
│       │   │                        ExtractActor<TRequest> — shared by all
│       │   │                        three adapters below (§7)
│       │   ├── express.ts        → expressAdapter(options?)
│       │   ├── nestjs.ts         → AuditContextMiddleware
│       │   └── fastify.ts        → fastifyAdapter
│       └── index.ts               → public exports
└── transport-rabbitmq/
    └── src/
        ├── rabbitmq-transport.ts → RabbitMQTransport (§10)
        ├── warnings.ts            → package-local emitAuditWarning/errorMessage
        │                            (duplicated from the SDK's, not imported)
        └── index.ts
```

Note on `core/audit-instance.ts`/`record.ts`/`global-audit.ts`: these were
reorganized out of a single `configure.ts` once that file had accumulated
four unrelated responsibilities. `configure.ts` no longer exists.

Adapters and local transports are exposed as **subpath exports**
(`@tnet06/mapa-audit-sdk/express`, `@tnet06/mapa-audit-sdk/nestjs`,
`@tnet06/mapa-audit-sdk/fastify`, `@tnet06/mapa-audit-sdk/transports`) so a
consumer only pulls in what they use. The RabbitMQ transport, and any future
broker transport, ships as its **own independent package** (§10), never as a
subpath — see §5.2 for why.

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
shared `flatten()` helper in `core/flatten.ts`. Console, JSONL, and the RabbitMQ
transport's message body all preserve the nested structure as-is.

**Schema drift protection:** because `AUDIT_EVENT_CSV_COLUMNS` (the canonical CSV
schema) is a hand-maintained list, a dedicated test
(`test/core/flatten.sync.test.ts`) verifies that a fully-populated `AuditEvent`,
once flattened, produces exactly the same key set as `AUDIT_EVENT_CSV_COLUMNS` —
neither more nor fewer. This catches silent drift if a field is added to
`AuditEvent` without updating the CSV schema, or vice versa.

---

### 5. Core

#### 5.1 `storage.ts` — request context via AsyncLocalStorage

`AsyncLocalStorage` provides a store isolated per async execution chain (per
request). `contextStore.run(context, callback)` is called by adapters, once
per request; `getContext()` reads the current store from anywhere inside that
chain.

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

**`setActor(actor)`** (added this revision) — replaces the actor on the
*current* active context in place. Exists for architectures where identity is
resolved **after** the adapter already opened the context — most notably
NestJS Guards, the idiomatic place for JWT verification in Nest, which run
*after* middleware in Nest's request lifecycle (middleware → Guards →
Interceptors → controller). An adapter's `extractActor` (§7) cannot see an
actor that doesn't exist yet at the point the adapter runs; `setActor()` is
the escape hatch for that timing gap.

```ts
export function setActor(actor: RequestContext['actor']): void {
  const ctx = getContext();
  if (ctx === undefined) return;          // no-op outside an active request
  if (actor === undefined) { delete ctx.actor; return; }  // explicit clear
  ctx.actor = actor;                       // full replace, never merged
}
```

Semantics: fully replaces any actor previously set (by `extractActor` or a
prior `setActor()` call) — same replace-not-merge contract as `extractActor`.
`setActor(undefined)` clears the actor via `delete` (not assignment), keeping
`RequestContext` consistent with `exactOptionalPropertyTypes` — the field is
*absent*, not present-with-value-`undefined`. Silent no-op outside an active
request context, mirroring `record()`'s behavior when unconfigured. Affects
only the current request's context (`AsyncLocalStorage` isolation), so
concurrent requests never interfere.

This is a standalone function operating on the active context, not a method
on `AuditInstance` — actor identity is a per-request concern, not a
per-instance one, so it works identically whether the app uses the global API
or `createAudit()`, without needing to thread an instance into a Guard.

This capability's premise — that the *same* `RequestContext` object survives
from the point the adapter opens it through to wherever `setActor()` or
`record()` is later called — was verified empirically against a real NestJS
app (`test/adapters/nestjs-context-lifecycle.test.ts`, using `@nestjs/testing`
+ `supertest`), confirming the same reference (via `toBe`, not `toEqual`)
reaches a Guard, an Interceptor, and the controller.

#### 5.2 `transport.ts` — the Transport contract, and why it lives in `types`

```ts
// packages/types/src/index.ts
export interface Transport {
  send(event: AuditEvent): void | Promise<void>;
  /** Optional. Drains any pending work before shutdown. Transports with nothing
   *  to flush (e.g. ConsoleTransport) may omit this. */
  close?(): Promise<void>;
}
```

`Transport` moved from `packages/sdk/src/core/transport.ts` to
`@tnet06/mapa-audit-types` in this revision. `packages/sdk/src/core/
transport.ts` now only re-exports it (`export type { Transport } from
'@tnet06/mapa-audit-types'`) — no change to the SDK's public API surface for
anyone already importing `Transport` from `@tnet06/mapa-audit-sdk`.

**Why:** `Transport` is a contract shared between the SDK core and any
external transport package (like `@tnet06/mapa-audit-transport-rabbitmq`,
§10) — not an internal SDK detail. Before this move, an external "leaf"
transport package wanting to type correctly against `Transport` would have had
to depend on the SDK (a "root" package that *consumes* transports) just for a
type — a circular dependency in spirit. Moving `Transport` to the shared types
package, which everything already depends on, removes that circularity:
`types` is the base of the dependency graph; nothing depends on the SDK for a
type.

The core depends only on this interface — never on a concrete transport.
`close()` is opt-in: `ConsoleTransport` does not implement it (nothing to
drain); `FileTransport` and `RabbitMQTransport` do.

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
(`randomUUID()`, preserved for the queue transport's downstream idempotency),
context merge, default `severity: 'info'`, and payload preparation.

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

`@tnet06/mapa-audit-transport-rabbitmq` (§10) has its **own**, deliberately
duplicated, minimal version of these two functions rather than importing the
SDK's — see §10 for why.

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
  could each observe an "empty file" and each write a duplicate header,
  verified with a genuinely concurrent test (`Promise.all` of simultaneous
  `send()` calls, not sequential). Missing fields are left as **empty cells**
  (never the literal string `"null"`).
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
`logrotate`) or use the RabbitMQ transport (§10) feeding a persistence
pipeline instead.

---

### 7. Adapters

All three implemented adapters share one context-building helper,
`adapters/http-context.ts` (`buildHttpRequestContext()`, `nonEmptyString()`,
the `ExtractActor<TRequest>` type), so the logic for reading headers, merging
context, and applying default/custom actor extraction exists **once**, not
once per adapter.

`ExtractActor<TRequest>` is a **function type**, not a declarative
configuration object: `(req: TRequest) => Actor | undefined`. The caller
writes real code — reading whatever property holds identity in their app,
applying any transformation needed (e.g. mapping a numeric role ID to a
string) — and returns the actor shape directly, or `undefined` if none
applies. This is deliberate: a declarative "path" config (e.g. `{ userIdPath:
'session.user.id' }`) could not express transformations or conditional
logic, and different apps hold identity in structurally different places
(`req.user`, `req.session.user`, a decoded JWT claim, etc.) — a function
handles all of them without the SDK anticipating each convention.

**Default actor extraction** (used when `extractActor` is not provided)
follows the Passport.js convention: reads `req.user?.id` and
`req.user?.role`; when either is present, sets `actor.type: 'user'`. This
does **not** apply to apps using session-based auth that store the user
elsewhere (e.g. `req.session.user`, common with `express-session` without
Passport) — those apps need `extractActor` (see the example in §7.1).

#### 7.1 `expressAdapter(options?)`

```ts
export interface ExpressAdapterOptions {
  correlationIdHeader?: string;   // default: 'x-correlation-id'
  causationIdHeader?: string;     // default: 'x-causation-id'
  extractActor?: (req: Request) => NonNullable<RequestContext['actor']> | undefined;
}

export function expressAdapter(options?: ExpressAdapterOptions): RequestHandler;
```

Builds a `RequestContext` from the incoming request and runs the rest of the
request inside `contextStore.run(context, next)`. `correlationId` is reused from
the configured header if present (cross-service correlation), otherwise generated
(`randomUUID()`) — this service becomes the origin. `causationId` is read the same
way, symmetrically, and left absent if the header is missing. Captures
`request.routePattern` from `req.route.path`.

`extractActor`, when provided, **fully replaces** the default extraction (not
merged with it) — the caller owns the entire actor shape.

**Example — session-based auth without Passport** (a real case encountered
integrating this adapter into an existing app):

```ts
app.use(sessionInstance);           // populates req.session
app.use(expressAdapter({
  extractActor: (req) => {
    const user = req.session?.user;
    if (user === undefined) return undefined;
    return {
      type: 'user',
      userId: String(user.id),
      userRole: user.roleId === 1 ? 'admin' : 'user',
    };
  },
}));
```

**Common mistake:** `app.use(expressAdapter)` (without invoking the factory)
silently hangs every request — Express calls the factory itself with
`(req, res, next)`, so `next()` is never called. Always invoke it:
`app.use(expressAdapter())`.

#### 7.2 `AuditContextMiddleware` (NestJS)

```ts
export interface NestAuditMiddlewareOptions {
  correlationIdHeader?: string;
  causationIdHeader?: string;
  extractActor?: ExtractActor<NestAuditRequest>;
}

@Injectable()
export class AuditContextMiddleware implements NestMiddleware {
  constructor(options?: NestAuditMiddlewareOptions);
  use(req, res, next): void;
}
```

Built against a minimal, platform-agnostic request shape (`method`, `url`,
`headers`, `ip`, `user?`) rather than Express or Fastify types — **one**
middleware works under both `@nestjs/platform-express` and
`@nestjs/platform-fastify`. Verified against both platforms with two real,
running example apps (`examples/nestjs-demo/`, selectable via an env var),
not just at the type level.

Registered via Nest's standard middleware configuration:
```ts
consumer.apply(new AuditContextMiddleware(options).use.bind(...)).forRoutes('*');
```

Requires `experimentalDecorators: true` in the SDK package's `tsconfig.json`
(for `@Injectable()`) — a deliberate, package-wide, zero-runtime-cost
trade-off, documented inline in the tsconfig, rather than isolating this one
file into a nested build config.

**Known trade-off:** does **not** capture `request.routePattern` — Express's
`req.route.path` is not part of the common shape Nest normalizes across
platforms, so including it would break platform-agnosticism.

**Known limitation — Guards and identity resolved late:** if authentication
is verified in a NestJS Guard (the idiomatic place for JWT verification in
Nest), the actor is not yet known when this middleware runs, since Guards run
*after* middleware in Nest's lifecycle. Use `setActor()` (§5.1) inside the
Guard instead:

```ts
@Injectable()
class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const payload = this.jwtService.verify(extractBearerToken(req));
    setActor({ type: 'user', userId: payload.sub, userRole: payload.role });
    return true;
  }
}
```

This works because the same `RequestContext` object opened by the middleware
survives, by reference, through Guards, Interceptors, and the controller —
empirically verified (§5.1), not assumed.

#### 7.3 `fastifyAdapter` (Fastify)

```ts
export interface FastifyAdapterOptions {
  correlationIdHeader?: string;
  causationIdHeader?: string;
  extractActor?: ExtractActor<FastifyAuditRequest>;
}

export const fastifyAdapter: FastifyPluginCallback<FastifyAdapterOptions>;
```

Registered as a plugin: `await fastify.register(fastifyAdapter, options)`.

Implemented as an `onRequest` hook using Fastify's **callback-style**
continuation — `contextStore.run(context, hookDone)` — not the async/await
hook variant, which would lose `AsyncLocalStorage` context before reaching
the route handler (verified with real `fastify.inject()` integration tests
against a genuine Fastify instance, including a dedicated concurrent-request
isolation test with overlapping in-flight requests).

Captures `request.routePattern` with a version-compatible fallback:
`request.routeOptions?.url` (Fastify v5) falling back to `request.routerPath`
(v4) — verified against a real Fastify v4 instance (installed via an npm
alias, `fastify4@npm:fastify@^4.0.0`, dev-only, never shipped to consumers),
not just designed on paper. Registers Fastify's `skip-override` symbol so the
hook applies to the parent scope rather than being encapsulated to the
plugin's own scope.

Unlike `AuditContextMiddleware`, this adapter **does** capture
`routePattern` — it is built against the real Fastify types, with no
cross-platform agnosticism constraint.

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

Runnable, end-to-end versions of this pattern — multiple endpoints, all local
transports, masking, and truncation demonstrated live — exist for all three
adapters: `examples/express-demo/`, `examples/nestjs-demo/` (runnable on
either `platform-express` or `platform-fastify` via an env var), and
`examples/fastify-demo/` (which also demonstrates `routePattern` capture, in
contrast with `nestjs-demo`).

---

### 9. Failure & Durability

| Transport | Durability characteristics |
|---|---|
| Console | Ephemeral — goes to stdout/stderr; best-effort by nature |
| File | Persisted to local disk; durability = the file's durability; writes serialized and drainable via `close()`/`shutdown()` |
| RabbitMQ (publish-only) | Durability = the broker's; `close()` cannot guarantee in-flight publishes complete first (§10) |

Universal guarantees, regardless of transport:
- `record()`/`AuditInstance.record()` never blocks or throws into the host
  application.
- A transport failure is contained and reported via `process.emitWarning` — never
  propagated to business logic.
- `shutdown()` drains transports that support draining before the process exits,
  when the host app calls it on a signal handler (see §8).

---

### 10. Distribution & Packaging

- **`@tnet06/mapa-audit-sdk`** — core + console + file transports + all three
  adapters. Main package; zero heavy dependencies; works standalone.
- **`@tnet06/mapa-audit-types`** — shared event contract, including
  `Transport` (§5.2). Every other package depends on this one; it depends on
  nothing in this ecosystem.
- **`@tnet06/mapa-audit-transport-rabbitmq`** — a **separate, independent**
  package, implemented in this revision. Publishes `AuditEvent`s to a durable
  RabbitMQ topic exchange (`'audit.events'` by default), implementing the
  same `Transport` interface as `ConsoleTransport`/`FileTransport` — a
  drop-in addition to the `transports` array, not a core dependency:

  ```ts
  import { RabbitMQTransport } from '@tnet06/mapa-audit-transport-rabbitmq';

  initGlobalAudit({
    serviceName: 'recipes-api',
    environment: 'production',
    transports: [
      new ConsoleTransport(),
      new RabbitMQTransport({ connection: 'amqp://user:pass@host:5672/vhost' }),
    ],
  });
  ```

  Key design points:
  - Depends **only** on `@tnet06/mapa-audit-types`, never on
    `@tnet06/mapa-audit-sdk` — deliberately, to keep this "leaf" package's
    dependency direction pointing only toward the shared types, and to allow
    network-transport error handling to evolve independently of local
    transports. Its `emitAuditWarning`/`errorMessage` are its own small,
    duplicated implementation, not imported from the SDK.
  - `connection: string | string[]` — a standard AMQP URL (or several, for
    cluster/HA), never a granular host/user/password object; any real
    RabbitMQ deployment already hands out a connection string.
    `connectionOptions?` is forwarded as-is to `amqp-connection-manager`'s
    `connect()` (TLS, heartbeat, reconnection tuning) — pure pass-through, no
    interpretation.
  - `amqp-connection-manager` is a **client-side only** library — it does not
    affect or constrain the user's RabbitMQ deployment in any way. Any real
    RabbitMQ instance (self-hosted, Docker, a managed service) works, since
    both sides speak the standard AMQP 0-9-1 protocol.
  - The published message body is the `AuditEvent` **as-is** (camelCase keys
    preserved, untransformed). **Only the routing key** is derived from
    `eventType` and converted to snake_case, matching the queue/DB boundary
    convention documented in `rabbitmq-worker-architecture.md` §3.1.
  - `send()` never throws — publish failures are caught and reported via the
    package's own warning helper, same fire-and-forget contract as every
    other transport.
  - `close()` closes the channel and connection. **Documented limitation:**
    `amqp-connection-manager` exposes no explicit hook to wait for in-flight
    publishes before closing; no custom buffering was added to simulate a
    guarantee the library doesn't make.
  - **This package only publishes.** It has no knowledge of queue
    consumption or persistence.

- **A Worker that consumes the queue and a TimescaleDB persistence pipeline
  remain a future, separate, opt-in service** — described at a design level
  in `platform-general-overview.md`, `database-design.md`, and
  `rabbitmq-worker-architecture.md`. **None of that is implemented today.**
  Those documents should be read as forward-looking design. The Worker is a
  reference implementation, not an imposed dependency: the real contract is
  the message shape on the queue (the shared `AuditEvent` type, snake_case
  routing key), not a code dependency on any specific Worker — a team can run
  the reference Worker as-is, adapt it, or write their own.
- The Worker and supporting infra are not npm packages — they are deployable
  services (Docker/Terraform), relevant only to consumers who adopt the queue
  transport.
- **Future broker transports** (e.g. BullMQ, Kafka) would each ship as their
  own independent package, named per-broker
  (`@tnet06/mapa-audit-transport-<broker>`) following the same pattern as
  this one — not a single generic "queue" package, since each broker is a
  genuinely different client/protocol requiring its own implementation.
- MIT-licensed (see the repository's `LICENSE` file). Not yet published to a
  registry as of this revision — see the project's publication checklist for
  outstanding `package.json` metadata work.

---

### 11. Out of Scope (current, deliberate)

- Worker + TimescaleDB persistence pipeline (§10) — future, separate service.
  Only the SDK-side RabbitMQ publisher is implemented.
- A manual-context helper for non-HTTP entry points (jobs, CLI scripts) —
  conceptually the generic primitive `expressAdapter`/`fastifyAdapter`/
  `AuditContextMiddleware` all build on top of; not yet extracted as its own
  public API.
- File rotation (`maxSize`/`maxFiles`) in `FileTransport` — pair with an external
  tool if needed.
- Array-element masking in `maskedFields` (only object paths are supported).
- Automatic correlation-ID propagation on outbound HTTP calls made by the service
  itself.
- Multi-process file locking for `FileTransport` CSV writes to a shared path.
- Guaranteed drain of in-flight `RabbitMQTransport` publishes on `close()` —
  bounded by what `amqp-connection-manager` exposes.

Documented as conscious boundaries, not omissions.