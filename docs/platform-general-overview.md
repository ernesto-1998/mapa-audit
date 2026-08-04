# Audit & Business Observability Platform
## Platform Design Overview (Current State — v3)

**Status:** Reflects what is implemented today, with the future pipeline clearly
marked as such
**Audience:** Engineering, anyone evaluating adoption
**Companion to:** SDK Architecture (current, implemented), Database Design
(future), RabbitMQ + Worker Architecture (Worker side future; SDK-side
publisher implemented)

> **Superseded content notice:** this revision replaces v2. Since v2, all
> three planned HTTP adapters (Express, NestJS, Fastify) were implemented,
> and the RabbitMQ transport moved from "planned" to **implemented** as its
> own package — though it only publishes; nothing on the consuming/persistence
> side has changed. This revision reflects that.

---

### 1. What this platform is

A small ecosystem for structured audit, business, error, and security events in
backend services, built from independently useful pieces:

| Piece | Status | What it does |
|---|---|---|
| **SDK** (`@tnet06/mapa-audit-sdk`) | ✅ **Implemented, usable today** | Automatic request-context capture, a structured event model, built-in data safety (masking, size limits), pluggable local transports (console, file) |
| **RabbitMQ transport** (`@tnet06/mapa-audit-transport-rabbitmq`) | ✅ **Implemented, usable today** | Publishes events to a RabbitMQ topic exchange instead of console/file. Publish-only — see §4 |
| **Worker** | 🔜 Future, separate deployable service | Consumes the queue, validates, persists to a database |
| **Database schema** (TimescaleDB) | 🔜 Future | Where the Worker persists events, if adopted |

**The SDK works completely on its own, with zero additional infrastructure.**
A team can install it, call `initGlobalAudit()` once, and start recording
structured events to console or a local file — nothing else to deploy, nothing
else to operate. Adding the RabbitMQ transport requires only a running
RabbitMQ instance to publish to (any deployment — self-hosted, Docker, a
managed service). The Worker/database pipeline that would *consume* that
queue is a further, **optional, separate extension** for teams that want
centralized, queryable, long-term storage — not a requirement to get value
from either the SDK or the RabbitMQ transport.

This is a deliberate ordering, not an accident: build the piece with the
highest value-to-effort ratio first (structured, context-aware events with
safe defaults), ship it, let the publish-side queue integration follow, and
leave the consuming/persistence side to be adopted independently and later,
by whoever actually needs it.

---

### 2. What "the SDK" gives you (implemented)

The SDK's core value has nothing to do with where events end up — it is what
happens *before* that:

- **Automatic request-context capture** — correlation ID, causation ID,
  actor (who), and request metadata (method, endpoint, IP, user agent),
  captured once per request via a framework adapter (`AsyncLocalStorage`-based)
  and merged into every event recorded during that request, without the
  caller passing any of it manually. Implemented for **Express, NestJS, and
  Fastify** — see §3.
- **A structured, nested event model** (`AuditEvent`) — not free-text logs.
  `eventType`, `eventName`, `outcome`, `entity`, `payload`, all typed.
- **Built-in data safety** — `maskedFields` (dot-notation, nested paths) redact
  sensitive payload fields before any transport sees the event;
  `maxPayloadSize` replaces oversized payloads with a truncation marker
  instead of forwarding arbitrarily large data.
- **Pluggable transports** — `ConsoleTransport` and `FileTransport`
  (jsonl/csv/text) ship with the SDK; `RabbitMQTransport` (§4) is a separate
  package. All implement the same small interface, so they are interchangeable
  and combinable (fan-out): the same event can go to console, a file, and a
  queue simultaneously, with one transport's failure never affecting the
  others.
- **Identity resolved later in a request** — `setActor()` for architectures
  where auth is verified after the adapter already opened context (most
  notably NestJS Guards, the idiomatic place for JWT verification in Nest).
- **Explicit lifecycle** — `shutdown()` drains any transport with pending work
  (e.g. buffered file writes) before a process exits, so events are not lost
  on graceful shutdown.
- **Visible failure** — transport errors and misconfiguration emit
  `process.emitWarning` instead of failing silently, while never throwing into
  the host application (fire-and-forget by design).

See `sdk-architecture.md` for the full technical reference, and
`examples/express-demo/`, `examples/nestjs-demo/`, and
`examples/fastify-demo/` for runnable demonstrations of all of the above.

---

### 3. The public API and adapters

```ts
// Global — the common case: one configuration per process, initialized once
import { initGlobalAudit, record, shutdownGlobalAudit } from '@tnet06/mapa-audit-sdk';

initGlobalAudit({
  serviceName: 'recipes-api',
  environment: 'production',
  transports: [new ConsoleTransport()],
  maskedFields: ['creditCard', 'user.ssn'],
});

record({
  eventType: 'business',
  eventName: 'recipe.updated',
  outcome: 'success',
  entity: { type: 'recipe', id: recipe.id },
  payload: { changedFields: ['title'] },
});
```

```ts
// Creational — isolated instances, for tests or multiple independent configs
import { createAudit } from '@tnet06/mapa-audit-sdk';
const audit = createAudit({ serviceName: 'recipes-api', environment: 'test', transports: [...] });
audit.record({ ... });
```

See `sdk-architecture.md` §2 for the full rationale behind offering both
shapes.

**All three planned HTTP adapters are implemented:** Express, NestJS, and
Fastify — each configurable (custom correlation/causation headers, custom
actor extraction) and sharing one internal context-building helper, so
there's no duplicated logic between them. A Node.js `http`-module adapter for
frameworkless services remains planned but unimplemented. All adapters are
designed to stay lightweight and live inside the main SDK package (no heavy
runtime dependencies) — unlike the RabbitMQ transport (§4), which ships
separately because it carries a real broker-client dependency. See
`sdk-architecture.md` §7 for adapter-specific details, including a documented
difference (NestJS does not capture `routePattern`, to remain agnostic of
whether it runs on Express or Fastify underneath) and the Guard/`setActor()`
pattern for identity resolved after context capture.

---

### 4. The RabbitMQ transport (implemented, publish-only) and the future consuming pipeline

For teams that want events centrally persisted, queryable, and retained beyond
a local file, the design calls for additional pieces beyond the SDK:

```
Your service (SDK)  →  RabbitMQTransport  →  [ RabbitMQ ]  →  Worker  →  Database
   (implemented)          (implemented,        (any real       (future,     (future,
                           own npm package)      deployment)     separate     TimescaleDB —
                                                                  process)     see below)
```

- **RabbitMQ transport** (`@tnet06/mapa-audit-transport-rabbitmq`) —
  **implemented**, a `Transport` that publishes events to a RabbitMQ topic
  exchange instead of console/file. Ships as its **own npm package**, because
  it carries a real, non-trivial client dependency
  (`amqp-connection-manager`) — consumers who only use console/file
  transports never install it. It implements the *same* `Transport`
  interface as everything else; from the SDK core's perspective, it is
  interchangeable with `FileTransport` and can be combined with it (fan-out).
  The message body preserves the `AuditEvent`'s camelCase shape as-is; only
  the routing key is converted to snake_case, matching the queue/DB boundary
  convention in `rabbitmq-worker-architecture.md`. This transport is
  client-side only — it does not require or assume any particular way the
  user's RabbitMQ was deployed (self-hosted, Docker, a managed service all
  work identically, since both sides speak the standard AMQP protocol).
  See `sdk-architecture.md` §10 for full design details, including the
  documented limitation that `close()` cannot guarantee in-flight publishes
  complete first.
- **Worker** — **not implemented.** A separate, deployable service (its own
  process, its own Docker image, not an npm package) that would consume the
  queue, validate incoming events, and persist them. Design-only: a **reference
  implementation**, not something the SDK forces on anyone — a team adopting
  the RabbitMQ transport can eventually run a reference Worker as-is, adapt
  it, or write their own, since the real contract is the shape of the message
  on the queue (the shared `AuditEvent` type plus the snake_case routing
  key), not a code dependency on any specific Worker.
- **Database** — **not implemented.** The design calls for
  **TimescaleDB** (a time-series-oriented extension of PostgreSQL), chosen for
  its native support of time-partitioned hypertables, compression, and
  retention policies — a good structural fit for audit events, which are
  fundamentally time-series data accessed mostly by time range.

**As of this revision: the RabbitMQ transport (SDK-side publisher) is
implemented and usable. The Worker and database schema are not.** A team
today can publish events to their own RabbitMQ instance; nothing yet consumes
or persists them without writing that piece themselves. Design details for
the consuming side live in `rabbitmq-worker-architecture.md` and
`database-design.md`; both should be read as forward-looking design for that
remaining piece.

#### 4.1 Why the consuming/persistence side stays optional and separate

A service using only `ConsoleTransport`/`FileTransport` never needs to know
any of this exists. A service that adds `RabbitMQTransport` needs only a
RabbitMQ instance to publish to — no Worker, no database, no additional
service required just to publish. This is deliberate: the SDK's value
(structured, context-aware, safe-by-default events) does not depend on
centralized persistence, and neither does publishing to a queue for future
use. Centralization is something teams opt into when they need cross-service
querying, long retention, or compliance-grade durability beyond a local file
— not a requirement to start using the SDK, or even the queue transport,
productively.

---

### 5. Guarantees, today

Independent of whether the future Worker/database pipeline is ever adopted,
these hold for every transport the SDK ships or supports today, including
the RabbitMQ transport:

- Recording an event never throws into, or blocks, the calling application
  (fire-and-forget).
- A transport failure is isolated — it never prevents delivery to other
  configured transports, and never surfaces as an exception to the caller. It
  is reported via `process.emitWarning`, never silently swallowed.
- `shutdown()` drains any transport with pending work before a process exits
  cleanly (with a documented exception for the RabbitMQ transport's in-flight
  publishes — see §4), so a graceful shutdown does not lose in-flight events
  where the transport supports draining.
- Sensitive payload fields, when identified via `maskedFields`, are redacted
  before any transport — including console — ever receives the event.

These guarantees are transport-agnostic by construction: they hold the same
way whether the underlying transport is `ConsoleTransport`, `FileTransport`,
or `RabbitMQTransport`.

---

### 6. Status summary

| Capability | Status |
|---|---|
| Structured event model, automatic context capture | ✅ Implemented |
| Console / file transports, fan-out, lifecycle | ✅ Implemented |
| Field masking, payload size limiting | ✅ Implemented |
| Express, NestJS, and Fastify adapters (all configurable) | ✅ Implemented |
| `setActor()` for identity resolved after context capture | ✅ Implemented |
| Node.js `http`-module adapter (frameworkless) | 🔜 Planned, unimplemented |
| RabbitMQ transport (publish-only, separate package) | ✅ Implemented |
| Worker (consume, validate, persist) | 🔜 Planned, unimplemented, separate service |
| TimescaleDB schema & persistence | 🔜 Planned, unimplemented |
| Query API / dashboards over persisted events | 🔜 Depends on the above; not yet designed in detail |

See `docs/BUILD_PLAN.md` for the phase-by-phase build order and current
progress, and the root `README.md` for practical usage documentation.