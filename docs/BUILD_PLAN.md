# BUILD_PLAN.md

Ordered build plan for the Audit & Business Observability Platform.

> **Note (this revision):** phases 0–9 below are complete and reflect what is
> actually implemented, including the full adapter surface (Express, NestJS,
> Fastify), `setActor()` for identity resolved later in a request's lifecycle,
> the first queue transport package (RabbitMQ, publish-only), and the root
> README. Section references point to `docs/sdk-architecture.md` (v3). The
> queue *consumption* side — Worker + persistence — remains future and
> unimplemented; only the SDK-side publisher exists today.

This is the **shared map of what gets built and in what order**. The architect
assigns phases one at a time; the agent implements the referenced phase, notes
assumptions, and leaves the work for review (never commits — `AGENTS.md` §0.1).

Legend: `[x]` done & reviewed · `[ ]` not started

---

## Phase 0 — Repository Scaffolding  [x]
**Doc:** SDK Architecture §3

Monorepo under `packages/` with workspaces, shared strict TypeScript config,
shared types package (`@tnet06/mapa-audit-types`), lint/format config, Vitest
configured at the workspace root.

---

## Phase 1 — Core: Context Storage  [x]
**Doc:** SDK Architecture §5.1

`AsyncLocalStorage`-based `RequestContext` + `getContext()` in `core/storage.ts`.
Tests prove per-request isolation under concurrency.

---

## Phase 2 — Core: Transport Contract  [x]
**Doc:** SDK Architecture §5.2

`Transport` interface: `send(event)` plus an **optional** `close?():
Promise<void>` for transports that need to drain pending work before shutdown
(added after the original contract — see Phase 6b). Later moved to
`@tnet06/mapa-audit-types` (Phase 9a) so external transport packages can
implement it without depending on the SDK.

---

## Phase 3 — Core: Event Assembly & Dispatch  [x]
**Doc:** SDK Architecture §5.3, §5.4, §5.5

Originally a single `configureAudit()`/`record()` pair in `core/configure.ts`.
Reorganized (Phase 7a) into:
- `core/audit-instance.ts` — `createAudit()`, the creational factory.
- `core/record.ts` — `buildAuditEvent()`, `sendFireAndForget()` (fan-out,
  per-transport isolation), payload masking/size-limiting (Phase 8b), and the
  public `record()` shortcut.
- `core/global-audit.ts` — the global convenience singleton (Phase 7b).

`configure.ts` no longer exists.

---

## Phase 4 — Transport: Console  [x]
**Doc:** SDK Architecture §6.1

`ConsoleTransport` — `process.stdout`/`process.stderr` (not `console.log`),
severity-based routing (`error`/`critical` → stderr), nested JSON, no
flattening. No `close()` (nothing to drain). Default transport when none is
configured.

---

## Phase 5 — Framework Adapters  [x]
**Doc:** SDK Architecture §7

All three planned HTTP framework adapters are implemented, sharing one
context-building helper (`adapters/http-context.ts`: `buildHttpRequestContext`,
`nonEmptyString`, the `ExtractActor<TRequest>` type) so no logic is duplicated
across them.

### Phase 5a — Express  [x]
`expressAdapter(options?)` — automatic context capture via
`contextStore.run()`. Configurable: `correlationIdHeader`, `causationIdHeader`,
`extractActor`. Captures `routePattern` from `req.route.path`. Default actor
extraction follows the Passport convention (`req.user.id`/`req.user.role`).

**Milestone reached (first, with this adapter):** the SDK is usable end-to-end
with zero infrastructure.

### Phase 5b — NestJS  [x]
`AuditContextMiddleware` (`NestMiddleware`, `@Injectable`) — built against a
minimal, platform-agnostic request shape (`method`/`url`/`headers`/`ip`/`user`)
rather than Express or Fastify types, so **one** middleware works under both
`@nestjs/platform-express` and `@nestjs/platform-fastify`. Requires
`experimentalDecorators: true` at the SDK package's `tsconfig.json` (documented
inline as a deliberate, package-wide, zero-runtime-cost trade-off rather than
isolating it into a nested build config for a single file).

**Known trade-off:** does not capture `routePattern` — Express's
`req.route.path` is not part of the common shape Nest normalizes across
platforms. Documented in the adapter's JSDoc and in `sdk-architecture.md`.

**Verified empirically** (`test/adapters/nestjs-context-lifecycle.test.ts`,
using `@nestjs/testing` + `supertest` against a real app) that the same
`RequestContext` object reference survives through middleware → Guards →
Interceptors → controller — the premise `setActor()` (Phase 9c) depends on.

### Phase 5c — Fastify  [x]
`fastifyAdapter` — a Fastify plugin using the callback-style `onRequest` hook
(`contextStore.run(context, hookDone)`), **not** the async/await hook variant,
which would lose `AsyncLocalStorage` context before reaching the route handler.
Captures `routePattern` with a version-compatible fallback: `routeOptions?.url`
(Fastify v5) falling back to `routerPath` (v4) — verified against a real
Fastify v4 instance installed via an npm alias
(`fastify4@npm:fastify@^4.0.0`, dev-only, never shipped) in
`test/adapters/fastify-v4-compat.test.ts`, not just designed on paper.
Registers Fastify's `skip-override` symbol so the hook applies to the parent
scope instead of being encapsulated to the plugin's own scope.

All three adapters tested with real framework instances (`app.inject()` for
Express/Fastify-style testing, `@nestjs/testing` for NestJS) rather than
hand-built mocks, including dedicated concurrent-request isolation tests.

---

## Phase 6 — Transport: File  [x]
**Doc:** SDK Architecture §6.2

`FileTransport` — formats `'jsonl'` (default), `'csv'` (via the shared
`flatten()` helper and canonical `AUDIT_EVENT_CSV_COLUMNS` schema), and
`'text'` (deliberately minimal, human-readable). XLSX was evaluated and
explicitly dropped (binary format, poor fit for append-only writes) — never
implemented.

### Phase 6a — Robustness hardening  [x]
- One-time cached directory creation (`#ensureDirectory`), not repeated per
  `send()`.
- Chained writes (`#pendingWrite`) preserve append order under fire-and-forget.
- CSV header race condition fixed: an in-memory flag (`#headerWritten`)
  replaces per-write filesystem checks, verified with a genuinely concurrent
  test (`Promise.all` of simultaneous `send()` calls, not sequential). **Known
  limitation, by design:** protects a single instance/process; multiple
  `FileTransport` instances (or processes) writing the same path can still
  race — share one instance rather than creating several pointed at the same
  file.
- Write failures reported via `emitAuditWarning()` (Phase 8c), not swallowed.

### Phase 6b — Lifecycle (`close`/`shutdown`)  [x]
- `Transport.close?()` (Phase 2 addendum) implemented by `FileTransport`,
  draining `#pendingWrite` before resolving.
- `AuditInstance.shutdown()` calls `close()` on every transport that has one,
  in parallel; idempotent (concurrent calls await the same in-flight shutdown).
- `shutdownGlobalAudit()` mirrors this for the global singleton.

---

## Phase 7 — Hybrid API: Creational + Global  [x]
**Doc:** SDK Architecture §2

Originally a single module-global `configureAudit()`. Redesigned into two
complementary APIs sharing one implementation:

### Phase 7a — `createAudit()` factory  [x]
Isolated instances (`AuditInstance`: `record()`, `shutdown()`, `getInfo()`),
state held in a closure — no module-level mutable state per instance.

### Phase 7b — Global convenience singleton  [x]
`initGlobalAudit()`, `record()`, `shutdownGlobalAudit()`, `resetGlobalAudit()`
— a thin wrapper storing one `createAudit()` instance at module scope. The
global is deliberately **not mutable in place** after `initGlobalAudit()` (no
add/remove-transport API on the live global) — see SDK Architecture §2.2.

### Phase 7c — `getGlobalAudit()` inspection getter  [x]
Returns a read-only `GlobalAuditInfo` snapshot (`configured`, `serviceName`,
`environment`, `transportCount`) — never the instance itself, never a mutable
reference. `transportCount` is derived from the instance's real transports
array via `AuditInstance.getInfo()` (not recomputed separately) to avoid a
second source of truth.

### Phase 7d — API naming pass  [x]
Renamed for clarity: `configureAudit` → `initGlobalAudit`; internal
`recordWithConfiguredAudit` → `recordGlobal`. All global-scoped functions carry
"Global" in their name to visually distinguish them from the creational API.

---

## Phase 8 — Security & Robustness Hardening  [x]
**Doc:** SDK Architecture §5.4, §5.6

### Phase 8a — Adapter configurability  [x]
`correlationIdHeader`, `causationIdHeader`, `extractActor` across all three
adapters (Phase 5). `extractActor` fully replaces default extraction when
provided (never merged). Default `actor.type` set to `'user'` (`ActorType`)
when an authenticated actor is captured via the default path.

### Phase 8b — Payload masking & size limiting  [x]
- `maskedFields?: string[]` on `AuditConfig` — dot-notation paths of arbitrary
  depth (e.g. `'user.ssn'`, `'payment.card.cvv'`), not just first-level keys.
  Deep-clones (`structuredClone`) only when masking is configured; navigates
  paths defensively (missing/non-object/`null`/array segments abort silently,
  no throw). Array-element masking is explicitly **not supported**
  (documented limitation).
- `maxPayloadSize?: number` (default 1MB) — oversized payloads replaced with a
  `{ truncated, originalSizeBytes, maxSizeBytes }` marker, applied after
  masking.
- Neither mutates the caller's original payload object, at any depth.

### Phase 8c — Visible failure (no silent error swallowing)  [x]
- `emitAuditWarning()` / `errorMessage()` in `core/warnings.ts`, shared
  between transport-dispatch failures (`record.ts`) and file-write failures
  (`transports/file.ts`) — single implementation, not duplicated.
- `record()` (global) warns exactly **once** per process if called before
  `initGlobalAudit()`, instead of silently discarding events forever;
  `resetGlobalAudit()` resets the warned-once flag for test isolation.

### Phase 8d — Schema drift protection  [x]
`test/core/flatten.sync.test.ts` — verifies a fully-populated `AuditEvent`
flattens to exactly the `AUDIT_EVENT_CSV_COLUMNS` key set (no more, no fewer),
catching silent drift between the two hand-maintained schemas.

### Phase 8e — JSDoc  [x]
Public API surface documented across the SDK (`AuditConfig`, `RecordInput`,
`createAudit`, `AuditInstance`, global functions, `Transport`, both local
transports, all three adapters' options), including guidance on when to use
the global API vs. `createAudit()`.

### Phase 8f — Example Apps  [x]
`examples/express-demo/`, `examples/nestjs-demo/`, `examples/fastify-demo/` —
from-scratch apps in the monorepo workspace, each consuming the SDK directly
(not an external install). Each demonstrates: automatic context capture,
actor extraction, first-level and nested `maskedFields`, `maxPayloadSize`
truncation, transport selection via env var, and graceful shutdown draining
pending writes on `SIGINT`/`SIGTERM`. `nestjs-demo` additionally runs on
either `platform-express` or `platform-fastify` via an env var, verifying the
adapter's platform-agnosticism against two real, running apps (not just
mocks). `fastify-demo` demonstrates `routePattern` capture as a contrast to
`nestjs-demo`, where it is intentionally absent.

---

## Phase 9 — Identity Resolved Later, and the First Queue Transport  [x]
**Doc:** SDK Architecture §5, §10

### Phase 9a — `Transport` moved to shared types  [x]
The `Transport` interface moved from `packages/sdk/src/core/transport.ts` to
`@tnet06/mapa-audit-types`, with the SDK re-exporting it (`export type {
Transport } from '@tnet06/mapa-audit-types'`) — no change to the SDK's public
API surface. This resolves the circular dependency an external, independent
transport package would otherwise have on the SDK just to type against
`Transport`.

### Phase 9b — Queue Transport (RabbitMQ, publish-only)  [x]
`@tnet06/mapa-audit-transport-rabbitmq` — a new, **independent** workspace
package (not a subpath of the SDK), depending only on
`@tnet06/mapa-audit-types` (never on `@tnet06/mapa-audit-sdk`), with its own
duplicated `emitAuditWarning`/`errorMessage` helpers rather than importing the
SDK's — a deliberate choice to allow network-transport error handling to
evolve independently of local transports.

- `RabbitMQTransport implements Transport`, using `amqp-connection-manager`
  (a real dependency, not an optional peer — unlike the framework adapters,
  this package is unusable without its broker client).
- `connection: string | string[]` (standard AMQP URL(s); supports
  cluster/HA via multiple URLs) — deliberately **not** a granular
  host/user/password object; any real RabbitMQ deployment already provides a
  connection string.
- `connectionOptions?` is forwarded as-is to `amqp-connection-manager`'s
  `connect()` (TLS, heartbeat, reconnection tuning) — no interpretation, pure
  pass-through.
- Declares a durable topic exchange (`'audit.events'` by default). The
  published message body is the `AuditEvent` as-is (camelCase preserved);
  only the routing key is derived from `eventType` and converted to
  snake_case, matching the queue/DB boundary convention in
  `rabbitmq-worker-architecture.md` §3.1.
- `send()` never throws — publish failures are caught and reported via the
  package's own warning helper.
- `close()` closes the channel and connection. **Documented limitation:**
  `amqp-connection-manager` exposes no explicit hook to wait for in-flight
  publishes before closing; no custom buffering was added to simulate one.
- This package **only publishes**. It has no knowledge of consumption or
  persistence — the Worker (Phase 11) remains a separate, unimplemented
  service.
- Tested with a mocked `amqp-connection-manager` (no real broker required for
  the unit suite).

### Phase 9c — `setActor()` for identity resolved after context capture  [x]
**Doc:** SDK Architecture §5.1 (storage)

Addresses a real gap: in architectures where authentication is resolved
*after* the audit adapter has already opened the request context — most
notably NestJS Guards (the idiomatic place for JWT verification in Nest,
which run after middleware in Nest's request lifecycle) — the adapter's
`extractActor` cannot see the actor, because it runs too early.

- `setActor(actor)` in `core/storage.ts`, exported from the SDK's public API:
  mutates the `actor` field on the *current* `AsyncLocalStorage` context
  in-place. Fully replaces any actor previously set (by an adapter's
  `extractActor` or a prior `setActor()` call) — same replace-not-merge
  semantics as `extractActor`.
- `setActor(undefined)` clears the actor via `delete`, keeping
  `RequestContext` consistent with `exactOptionalPropertyTypes` (absent, not
  present-as-`undefined`).
- Silent no-op outside an active request context, mirroring `record()`'s
  behavior when unconfigured.
- Deliberately a standalone function operating on the active context — not a
  method on `AuditInstance` — because actor identity is a per-request concern,
  not a per-instance one; this makes it work identically whether the app uses
  the global API or `createAudit()`, without needing to thread an instance
  into a Guard.
- Preceded by an empirical verification (Phase 5b) that the same
  `RequestContext` reference survives NestJS's middleware → Guard →
  Interceptor → controller chain — the premise this feature depends on.

---

## Phase 10 — Root README  [x]
**Doc:** N/A (this document *is* the practical entry point)

`README.md` at the repository root: installation, quickstart, core concepts
(the `AuditEvent` model, actor vs. entity, automatic context capture), the
global vs. creational API, all three adapters with their options and
documented differences, all transports (including `RabbitMQTransport` as a
separate package), data safety, lifecycle/shutdown, error/warning handling,
and a troubleshooting section built from real issues encountered while
integrating the SDK into external Express applications (the
`expressAdapter()` vs. `expressAdapter` factory-invocation mistake, actor
extraction with session-based auth instead of Passport's `req.user`
convention, the empty actor on the login request itself). Links to
`examples/` and `docs/` rather than duplicating their content.

---

## — — — QUEUE CONSUMPTION / PERSISTENCE MODULE (future, unimplemented) — — —

Everything below remains **future, opt-in, self-hosted**, exactly as
originally scoped. The SDK-side publisher (Phase 9b) is done; nothing below
has been built. See SDK Architecture §10 and the companion documents
(`platform-general-overview.md`, `database-design.md`,
`rabbitmq-worker-architecture.md`) — those should be read as forward-looking
design, not as current behavior.

## Phase 11 — Worker: Consume, Validate, Persist  [ ]
**Doc:** RabbitMQ + Worker Architecture

Not started. Reminder: the Worker is a reference implementation, not an
imposed dependency — the real contract is the message shape on the queue
(the shared `AuditEvent` type, snake_case routing key per Phase 9b), not a
code dependency on this specific service.

## Phase 12 — Database: Schema & Hypertable  [ ]
**Doc:** Database Design (TimescaleDB)

Not started. Note: before implementation, reconcile `database-design.md`
against the current `AuditEvent` shape — the SDK's `correlationId` is optional
(events recorded outside a request context may lack one), while the DB design
marks it `NOT NULL`; six columns (`request_id`/`trace_id`/`span_id`/
`server_name`/`status_code`/`duration_ms`) have no current SDK equivalent and
are forward-looking only; and HTTP-context columns should not be scoped only
to `event_type = 'request'`, since adapters attach request context to
business/security/system events too, not only a dedicated "request" type.

## Phase 13 — Worker: Retry & Dead Letter  [ ]
**Doc:** RabbitMQ + Worker Architecture

Not started.

## Phase 14 — Containerization & Self-Hosted Infra  [ ]
**Doc:** Deployment Architecture *(to be written)*

Not started.

## Phase 15 — Pipeline Observability  [ ]
**Doc:** RabbitMQ + Worker Architecture §11 · Grafana & Observability *(to be written)*

Not started.

---

## Later / Unscheduled

- A manual-context helper for non-HTTP entry points (jobs, CLI scripts) —
  conceptually the generic primitive that `expressAdapter`/`fastifyAdapter`/
  `AuditContextMiddleware` all build on top of; not yet extracted as its own
  public API.
- Additional queue transport packages for other brokers (e.g. BullMQ, Kafka),
  each its own independent workspace package following the
  `transport-rabbitmq` pattern — named per-broker
  (`@tnet06/mapa-audit-transport-<broker>`), not a single generic "queue"
  package, since each broker is a genuinely different client/protocol.
- File rotation (`maxSize`/`maxFiles`) for `FileTransport`.
- Array-element masking in `maskedFields`.
- Read API for querying persisted events (depends on Phase 12+).
- Continuous aggregates for dashboards (depends on Phase 12+).
- Multi-tenant isolation hardening (schema already carries `tenant_id`, once
  Phase 12 exists).

Do not start these without explicit assignment.

---

## Publication Checklist (separate from feature phases — do when ready to publish)

Deliberately deferred, not forgotten. When the decision is made to publish:

- [ ] `packages/sdk/package.json`, `packages/types/package.json`,
      `packages/transport-rabbitmq/package.json`: remove `private: true`, set
      a real `version` (in sync across all three — fixed versioning, not
      independent), add `repository`, `engines`. (`license` addressed
      separately below.)
- [ ] Add `publishConfig.access: "public"` (required for scoped packages).
- [ ] Add a `prepublishOnly` script (`npm run build`) to each publishable
      package.
- [ ] Confirm `tsc -b` (already a single command via project references)
      still builds cleanly with all current packages, including
      `transport-rabbitmq` and the three example apps registered as
      references.

---

## Notes for the Agent

- **One phase at a time.** Finish, get it reviewed, then move on.
- **Read the linked doc section before coding** — `docs/sdk-architecture.md`
  and the root `README.md` are the current sources of truth for the SDK; the
  queue-consumption/DB/worker documents describe a **future, unimplemented**
  module — do not treat them as describing current behavior.
- **Reuse shared types** — never redeclare the event contract (`AGENTS.md`
  §3). `Transport` lives in `@tnet06/mapa-audit-types`, not the SDK.
- **Adapters and transports are independent** — adding one must not touch the
  other. Adapters share `adapters/http-context.ts`; do not duplicate its logic
  when adding a future adapter.
- **`id` is generated client-side** in `record()`/`buildAuditEvent()` —
  preserved across all transports for the queue transport's idempotency.
- **Never commit** — leave changes in the working tree for the architect.
- **Flag, don't guess**, on anything touching a fixed contract (`AGENTS.md`
  §0.2).